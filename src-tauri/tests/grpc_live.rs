//! Live gRPC test. Needs a server like the one in examples/grpc (Greeter with reflection):
//!   DISPATCH_GRPC_ADDR=127.0.0.1:50051 cargo test --test grpc_live -- --nocapture
use dispatch_lib::grpc::{grpc_call, grpc_describe};

fn addr() -> Option<String> { std::env::var("DISPATCH_GRPC_ADDR").ok() }

const PROTO: &str = r#"syntax = "proto3";
package demo.v1;
import "google/protobuf/timestamp.proto";
message HelloRequest { string name = 1; int32 times = 2; }
message HelloReply { string message = 1; google.protobuf.Timestamp at = 2; }
message Count { int32 total = 1; }
service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc SayManyTimes (HelloRequest) returns (stream HelloReply);
  rpc CountNames (stream HelloRequest) returns (Count);
}"#;

fn target(a: &str, proto: &str) -> serde_json::Value { serde_json::json!({ "address": a, "tls": false, "proto": proto, "timeout_ms": 5000 }) }

#[tokio::test]
async fn describes_and_calls_with_reflection_and_proto() {
    let Some(a) = addr() else { eprintln!("skipped: set DISPATCH_GRPC_ADDR"); return };
    for proto in ["", PROTO] {
        let services = grpc_describe(serde_json::from_value(target(&a, proto)).unwrap()).await.expect("describe");
        let json = serde_json::to_value(&services).unwrap();
        println!("{}", serde_json::to_string(&json).unwrap());
        let greeter = json.as_array().unwrap().iter().find(|s| s["name"] == "demo.v1.Greeter").expect("Greeter listed");
        assert_eq!(greeter["methods"].as_array().unwrap().len(), 3);

        let call = |path: &str, body: &str, md: Vec<(&str, &str)>| serde_json::json!({ "target": target(&a, proto), "path": path, "request_json": body,
            "metadata": md.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>() });
        let r = serde_json::to_value(grpc_call(serde_json::from_value(call("/demo.v1.Greeter/SayHello", r#"{"name":"Ann"}"#, vec![("authorization", "Bearer t")])).unwrap()).await.unwrap()).unwrap();
        assert_eq!(r["code"], 0, "{r}");
        assert_eq!(r["responses"][0]["message"], "Hello Ann (auth: Bearer t)");
        assert!(r["responses"][0]["at"].as_str().unwrap().ends_with('Z'), "timestamps come back as RFC 3339: {r}");

        let s = serde_json::to_value(grpc_call(serde_json::from_value(call("/demo.v1.Greeter/SayManyTimes", r#"{"name":"Bo","times":4}"#, vec![])).unwrap()).await.unwrap()).unwrap();
        assert_eq!(s["responses"].as_array().unwrap().len(), 4, "{s}");

        let c = serde_json::to_value(grpc_call(serde_json::from_value(call("/demo.v1.Greeter/CountNames", r#"[{"name":"a"},{"name":"b"},{"name":"c"}]"#, vec![])).unwrap()).await.unwrap()).unwrap();
        assert_eq!(c["responses"][0]["total"], 3, "{c}");

        let e = serde_json::to_value(grpc_call(serde_json::from_value(call("/demo.v1.Greeter/SayHello", r#"{"name":"error"}"#, vec![])).unwrap()).await.unwrap()).unwrap();
        assert_eq!(e["code_name"], "InvalidArgument", "{e}");

        let bad = grpc_call(serde_json::from_value(call("/demo.v1.Greeter/SayHello", r#"{"nope":1}"#, vec![])).unwrap()).await;
        assert!(bad.unwrap_err().contains("doesn’t fit demo.v1.HelloRequest"));
    }
}
