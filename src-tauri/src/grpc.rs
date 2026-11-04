//! gRPC for the desktop app: describe a server (reflection, or a pasted .proto) and call any method with JSON.
//! Messages are built at runtime with prost-reflect; tonic does the transport.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor, MethodDescriptor, SerializeOptions};
use prost_types::FileDescriptorProto;
use serde::{Deserialize, Serialize};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::metadata::{MetadataKey, MetadataMap, MetadataValue};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::Status;

// ---------- codec for runtime messages ----------

#[derive(Clone)]
struct DynCodec(MessageDescriptor);
struct DynEncoder;
struct DynDecoder(MessageDescriptor);

impl Codec for DynCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynEncoder;
    type Decoder = DynDecoder;
    fn encoder(&mut self) -> DynEncoder { DynEncoder }
    fn decoder(&mut self) -> DynDecoder { DynDecoder(self.0.clone()) }
}
impl Encoder for DynEncoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn encode(&mut self, item: DynamicMessage, dst: &mut EncodeBuf<'_>) -> Result<(), Status> {
        item.encode(dst).map_err(|e| Status::internal(e.to_string()))
    }
}
impl Decoder for DynDecoder {
    type Item = DynamicMessage;
    type Error = Status;
    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<DynamicMessage>, Status> {
        DynamicMessage::decode(self.0.clone(), src).map(Some).map_err(|e| Status::internal(e.to_string()))
    }
}

// ---------- connecting and building the descriptor pool ----------

#[derive(Deserialize)]
pub struct Target {
    /// host:port, or a full http(s):// URL.
    address: String,
    tls: bool,
    /// .proto source; when empty, server reflection is used.
    proto: String,
    timeout_ms: u64,
}

async fn channel(t: &Target) -> Result<Channel, String> {
    let addr = t.address.trim();
    let url = if addr.starts_with("http://") || addr.starts_with("https://") { addr.to_string() } else if t.tls { format!("https://{addr}") } else { format!("http://{addr}") };
    let mut ep = Endpoint::from_shared(url.clone()).map_err(|_| format!("“{addr}” isn’t a valid address."))?
        .connect_timeout(Duration::from_millis(t.timeout_ms.min(30_000)))
        .timeout(Duration::from_millis(t.timeout_ms));
    if url.starts_with("https://") {
        ep = ep.tls_config(ClientTlsConfig::new().with_webpki_roots()).map_err(|e| e.to_string())?;
    }
    ep.connect().await.map_err(|e| format!("Couldn’t connect to {addr}: {}", chain(&e)))
}

fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(x) = src { let p = x.to_string(); if !s.contains(&p) { s.push_str(": "); s.push_str(&p); } src = x.source(); }
    s
}

fn pool_from_proto(src: &str) -> Result<DescriptorPool, String> {
    let dir = std::env::temp_dir().join(format!("dispatch-proto-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("request.proto");
    std::fs::write(&file, src).map_err(|e| e.to_string())?;
    let set = protox::compile([&file], [&dir]).map_err(|e| format!("The .proto didn’t compile: {e}"))?;
    let _ = std::fs::remove_file(&file);
    DescriptorPool::from_file_descriptor_set(set).map_err(|e| e.to_string())
}

/// Every message/enum full name a file defines (nested ones too).
fn defined_names(f: &FileDescriptorProto) -> Vec<String> {
    fn msgs(prefix: &str, list: &[prost_types::DescriptorProto], out: &mut Vec<String>) {
        for m in list {
            let n = format!("{prefix}.{}", m.name());
            out.push(n.clone());
            for e in &m.enum_type { out.push(format!("{n}.{}", e.name())); }
            msgs(&n, &m.nested_type, out);
        }
    }
    let prefix = if f.package().is_empty() { String::new() } else { format!(".{}", f.package()) };
    let mut out = vec![];
    msgs(&prefix, &f.message_type, &mut out);
    for e in &f.enum_type { out.push(format!("{prefix}.{}", e.name())); }
    out
}

/// Every type a file refers to (field types, method inputs/outputs), as ".pkg.Name".
fn referenced_names(f: &FileDescriptorProto) -> Vec<String> {
    fn msgs(list: &[prost_types::DescriptorProto], out: &mut Vec<String>) {
        for m in list {
            for fl in &m.field { if !fl.type_name().is_empty() { out.push(fl.type_name().to_string()); } }
            msgs(&m.nested_type, out);
        }
    }
    let mut out = vec![];
    msgs(&f.message_type, &mut out);
    for s in &f.service { for m in &s.method { out.push(m.input_type().to_string()); out.push(m.output_type().to_string()); } }
    out
}

/// Adds files in dependency order (a file's imports first). Some servers send well-known types under their own
/// file name (e.g. "google_protobuf.proto"); those duplicates are skipped and imports of them are pointed at the
/// pool's real files.
fn pool_from_files(files: HashMap<String, FileDescriptorProto>) -> Result<DescriptorPool, String> {
    // The global pool already has Google's well-known types (Timestamp, Any…), which servers don't always send.
    let mut pool = DescriptorPool::global();
    let mut done: HashSet<String> = pool.files().map(|f| f.name().to_string()).collect();
    let mut alias: HashMap<String, Vec<String>> = HashMap::new();
    // Some reflection servers leave out imports; work them out from the types each file uses.
    let mut owner: HashMap<String, String> = HashMap::new();
    for f in files.values() { for n in defined_names(f) { owner.entry(n).or_insert_with(|| f.name().to_string()); } }
    let mut files = files;
    for f in files.values_mut() {
        let own: HashSet<String> = defined_names(f).into_iter().collect();
        for r in referenced_names(f) {
            if own.contains(&r) { continue; }
            let dep = owner.get(&r).cloned().or_else(|| {
                let n = r.trim_start_matches('.');
                pool.get_message_by_name(n).map(|m| m.parent_file().name().to_string()).or_else(|| pool.get_enum_by_name(n).map(|e| e.parent_file().name().to_string()))
            });
            if let Some(d) = dep { if d != f.name() && !f.dependency.contains(&d) { f.dependency.push(d); } }
        }
    }
    fn add(name: &str, files: &HashMap<String, FileDescriptorProto>, pool: &mut DescriptorPool, done: &mut HashSet<String>, alias: &mut HashMap<String, Vec<String>>, depth: u32) -> Result<(), String> {
        if done.contains(name) || alias.contains_key(name) || depth > 64 { return Ok(()); }
        let Some(f) = files.get(name) else { return Ok(()) };
        for dep in &f.dependency { add(dep, files, pool, done, alias, depth + 1)?; }
        let mut f = f.clone();
        let mut deps: Vec<String> = vec![];
        for d in &f.dependency { for x in alias.get(d).cloned().unwrap_or_else(|| vec![d.clone()]) { if !deps.contains(&x) { deps.push(x); } } }
        f.dependency = deps;
        f.public_dependency.clear();
        f.weak_dependency.clear();
        match pool.add_file_descriptor_proto(f.clone()) {
            Ok(()) => { done.insert(name.to_string()); Ok(()) }
            Err(e) if e.to_string().contains("already defined") => {
                // Find where the pool already defines this file's types, and use those files instead.
                let pkg = f.package().to_string();
                let full = |n: &str| if pkg.is_empty() { n.to_string() } else { format!("{pkg}.{n}") };
                let mut real: Vec<String> = vec![];
                for n in f.message_type.iter().map(|m| full(m.name())) { if let Some(m) = pool.get_message_by_name(&n) { let fname = m.parent_file().name().to_string(); if !real.contains(&fname) { real.push(fname); } } }
                for n in f.enum_type.iter().map(|m| full(m.name())) { if let Some(m) = pool.get_enum_by_name(&n) { let fname = m.parent_file().name().to_string(); if !real.contains(&fname) { real.push(fname); } } }
                alias.insert(name.to_string(), real);
                Ok(())
            }
            Err(e) => Err(format!("Reflection returned a descriptor that didn’t load ({name}): {e}")),
        }
    }
    let names: Vec<String> = files.keys().cloned().collect();
    for n in names { add(&n, &files, &mut pool, &mut done, &mut alias, 0)?; }
    Ok(pool)
}

macro_rules! reflect_with {
    ($module:path, $channel:expr) => { async { 
        use $module::{server_reflection_client::ServerReflectionClient, server_reflection_request::MessageRequest, server_reflection_response::MessageResponse, ServerReflectionRequest};
        let mut client = ServerReflectionClient::new($channel);
        let ask = |m: MessageRequest| ServerReflectionRequest { host: String::new(), message_request: Some(m) };
        // One request per stream keeps this simple and works with every server.
        async fn one<T: tonic::client::GrpcService<tonic::body::BoxBody> + Clone>(c: &mut ServerReflectionClient<T>, r: ServerReflectionRequest) -> Result<MessageResponse, Status>
        where T::Error: Into<tonic::codegen::StdError>, T::ResponseBody: tonic::codegen::Body<Data = bytes::Bytes> + Send + 'static, <T::ResponseBody as tonic::codegen::Body>::Error: Into<tonic::codegen::StdError> + Send {
            let mut s = c.server_reflection_info(tokio_stream::iter(vec![r])).await?.into_inner();
            let resp = s.message().await?.ok_or_else(|| Status::internal("empty reflection reply"))?;
            resp.message_response.ok_or_else(|| Status::internal("empty reflection reply"))
        }
        let services: Vec<String> = match one(&mut client, ask(MessageRequest::ListServices(String::new()))).await? {
            MessageResponse::ListServicesResponse(l) => l.service.into_iter().map(|s| s.name).filter(|n| !n.starts_with("grpc.reflection.")).collect(),
            MessageResponse::ErrorResponse(e) => return Err(Status::new(tonic::Code::from(e.error_code), e.error_message)),
            _ => vec![],
        };
        let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
        let take = |resp: MessageResponse, files: &mut HashMap<String, FileDescriptorProto>| {
            if let MessageResponse::FileDescriptorResponse(fd) = resp {
                for b in fd.file_descriptor_proto { if let Ok(f) = FileDescriptorProto::decode(b.as_slice()) { files.insert(f.name().to_string(), f); } }
            }
        };
        for s in &services { let r = one(&mut client, ask(MessageRequest::FileContainingSymbol(s.clone()))).await?; take(r, &mut files); }
        // Fetch imports the server didn't send along.
        for _ in 0..8 {
            let missing: Vec<String> = files.values().flat_map(|f| f.dependency.clone()).filter(|d| !files.contains_key(d) && !d.starts_with("google/protobuf/")).collect::<HashSet<_>>().into_iter().collect();
            if missing.is_empty() { break; }
            for m in missing { if let Ok(r) = one(&mut client, ask(MessageRequest::FileByFilename(m))).await { take(r, &mut files); } }
        }
        Ok::<_, Status>((services, files))
    }.await };
}

async fn pool_for(t: &Target, ch: Channel) -> Result<DescriptorPool, String> {
    if !t.proto.trim().is_empty() { return pool_from_proto(&t.proto); }
    let v1 = reflect_with!(tonic_reflection::pb::v1, ch.clone());
    let (_, files) = match v1 {
        Ok(x) => x,
        Err(s) if s.code() == tonic::Code::Unimplemented => reflect_with!(tonic_reflection::pb::v1alpha, ch)
            .map_err(|s| format!("Server reflection isn’t available ({}). Paste the service’s .proto instead.", s.message()))?,
        Err(s) => return Err(format!("Server reflection failed: {} ({:?}). Paste the service’s .proto instead.", s.message(), s.code())),
    };
    pool_from_files(files)
}

// ---------- describe ----------

#[derive(Serialize)]
pub struct MethodInfo { name: String, path: String, input: String, output: String, client_streaming: bool, server_streaming: bool, template: String }
#[derive(Serialize)]
pub struct ServiceInfo { name: String, methods: Vec<MethodInfo> }

fn template(desc: &MessageDescriptor) -> String {
    let msg = DynamicMessage::new(desc.clone());
    let opts = SerializeOptions::new().skip_default_fields(false);
    let v = msg.serialize_with_options(serde_json::value::Serializer, &opts).unwrap_or(serde_json::Value::Null);
    serde_json::to_string_pretty(&v).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
pub async fn grpc_describe(target: Target) -> Result<Vec<ServiceInfo>, String> {
    let ch = if target.proto.trim().is_empty() { Some(channel(&target).await?) } else { None };
    let pool = match ch { Some(c) => pool_for(&target, c).await?, None => pool_from_proto(&target.proto)? };
    let mut out: Vec<ServiceInfo> = pool.services().filter(|s| !s.full_name().starts_with("grpc.reflection.")).map(|s| ServiceInfo {
        name: s.full_name().to_string(),
        methods: s.methods().map(|m| MethodInfo {
            name: m.name().to_string(), path: format!("/{}/{}", s.full_name(), m.name()),
            input: m.input().full_name().to_string(), output: m.output().full_name().to_string(),
            client_streaming: m.is_client_streaming(), server_streaming: m.is_server_streaming(),
            template: if m.is_client_streaming() { format!("[\n{}\n]", template(&m.input())) } else { template(&m.input()) },
        }).collect(),
    }).collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ---------- call ----------

#[derive(Deserialize)]
pub struct Call { target: Target, path: String, request_json: String, metadata: Vec<(String, String)> }

#[derive(Serialize, Debug)]
pub struct CallResult {
    /// gRPC status code (0 = OK) and message.
    code: i32,
    code_name: String,
    message: String,
    /// One entry per response message (unary: one).
    responses: Vec<serde_json::Value>,
    headers: Vec<(String, String)>,
    trailers: Vec<(String, String)>,
    time_ms: u64,
}

fn md(m: &MetadataMap) -> Vec<(String, String)> {
    m.iter().filter_map(|kv| match kv {
        tonic::metadata::KeyAndValueRef::Ascii(k, v) => Some((k.to_string(), v.to_str().unwrap_or("").to_string())),
        tonic::metadata::KeyAndValueRef::Binary(k, v) => Some((k.to_string(), format!("{:?}", v))),
    }).collect()
}

fn find_method(pool: &DescriptorPool, path: &str) -> Result<MethodDescriptor, String> {
    let p = path.trim_start_matches('/');
    let (svc, m) = p.split_once('/').ok_or_else(|| format!("Use “package.Service/Method”, not “{path}”."))?;
    let s = pool.get_service_by_name(svc).ok_or_else(|| format!("No service {svc} on this server."))?;
    let found = s.methods().find(|x| x.name() == m);
    found.ok_or_else(|| format!("{svc} has no method {m}."))
}

fn to_msg(desc: &MessageDescriptor, v: &serde_json::Value) -> Result<DynamicMessage, String> {
    DynamicMessage::deserialize(desc.clone(), v).map_err(|e| format!("The JSON doesn’t fit {}: {e}", desc.full_name()))
}

fn with_md<T>(mut req: tonic::Request<T>, metadata: &[(String, String)]) -> Result<tonic::Request<T>, String> {
    for (k, v) in metadata {
        let key = MetadataKey::from_bytes(k.to_lowercase().as_bytes()).map_err(|_| format!("“{k}” isn’t a valid metadata key."))?;
        let val = MetadataValue::try_from(v.as_str()).map_err(|_| format!("The value of “{k}” has characters that can’t be sent."))?;
        req.metadata_mut().insert(key, val);
    }
    Ok(req)
}

fn status_result(s: Status, headers: Vec<(String, String)>, responses: Vec<serde_json::Value>, started: Instant) -> CallResult {
    CallResult { code: s.code() as i32, code_name: format!("{:?}", s.code()), message: s.message().to_string(), responses, headers, trailers: md(s.metadata()), time_ms: started.elapsed().as_millis() as u64 }
}

#[tauri::command]
pub async fn grpc_call(call: Call) -> Result<CallResult, String> {
    let ch = channel(&call.target).await?;
    let pool = pool_for(&call.target, ch.clone()).await?;
    let method = find_method(&pool, &call.path)?;
    let input: serde_json::Value = serde_json::from_str(if call.request_json.trim().is_empty() { "{}" } else { &call.request_json }).map_err(|e| format!("The request isn’t valid JSON: {e}"))?;
    let path = http::uri::PathAndQuery::try_from(format!("/{}/{}", method.parent_service().full_name(), method.name())).map_err(|e| e.to_string())?;
    let codec = DynCodec(method.output());
    let opts = SerializeOptions::new().skip_default_fields(false);
    let ser = |m: &DynamicMessage| m.serialize_with_options(serde_json::value::Serializer, &opts).unwrap_or(serde_json::Value::Null);
    let mut grpc = tonic::client::Grpc::new(ch);
    grpc.ready().await.map_err(|e| format!("Not ready: {e}"))?;
    let started = Instant::now();

    let messages: Vec<DynamicMessage> = if method.is_client_streaming() {
        let arr = match &input { serde_json::Value::Array(a) => a.clone(), other => vec![other.clone()] };
        arr.iter().map(|v| to_msg(&method.input(), v)).collect::<Result<_, _>>()?
    } else {
        vec![to_msg(&method.input(), &input)?]
    };

    match (method.is_client_streaming(), method.is_server_streaming()) {
        (false, false) => {
            let req = with_md(tonic::Request::new(messages.into_iter().next().unwrap()), &call.metadata)?;
            match grpc.unary(req, path, codec).await {
                Ok(res) => {
                    let headers = md(res.metadata());
                    Ok(CallResult { code: 0, code_name: "Ok".into(), message: String::new(), responses: vec![ser(res.get_ref())], headers, trailers: vec![], time_ms: started.elapsed().as_millis() as u64 })
                }
                Err(s) => Ok(status_result(s, vec![], vec![], started)),
            }
        }
        (cs, _) => {
            let res = if cs {
                let req = with_md(tonic::Request::new(tokio_stream::iter(messages)), &call.metadata)?;
                if method.is_server_streaming() { grpc.streaming(req, path, codec).await } else {
                    match grpc.client_streaming(req, path, codec).await {
                        Ok(r) => { let headers = md(r.metadata()); return Ok(CallResult { code: 0, code_name: "Ok".into(), message: String::new(), responses: vec![ser(r.get_ref())], headers, trailers: vec![], time_ms: started.elapsed().as_millis() as u64 }) }
                        Err(s) => return Ok(status_result(s, vec![], vec![], started)),
                    }
                }
            } else {
                let req = with_md(tonic::Request::new(messages.into_iter().next().unwrap()), &call.metadata)?;
                grpc.server_streaming(req, path, codec).await
            };
            let res = match res { Ok(r) => r, Err(s) => return Ok(status_result(s, vec![], vec![], started)) };
            let headers = md(res.metadata());
            let mut stream = res.into_inner();
            let mut out = vec![];
            loop {
                match stream.message().await {
                    Ok(Some(m)) => { out.push(ser(&m)); if out.len() >= 10_000 { break; } }
                    Ok(None) => break,
                    Err(s) => return Ok(status_result(s, headers, out, started)),
                }
            }
            let trailers = stream.trailers().await.ok().flatten().map(|t| md(&t)).unwrap_or_default();
            Ok(CallResult { code: 0, code_name: "Ok".into(), message: String::new(), responses: out, headers, trailers, time_ms: started.elapsed().as_millis() as u64 })
        }
    }
}
