//! Live TLS tests: a server that needs a client certificate, signed by a private CA.
//!   DISPATCH_MTLS_DIR=<dir with ca.pem client.pem client.key; server on 127.0.0.1:8444> cargo test --test network_live
use dispatch_lib::send_json;
use serde_json::json;

fn base(dir: &str) -> serde_json::Value {
    let _ = dir;
    json!({ "id": 1, "method": "GET", "url": "https://localhost:8444/", "headers": [], "body": null, "body_base64": null, "multipart": null,
            "timeout_ms": 5000, "follow_redirects": true, "insecure_tls": false })
}

#[tokio::test]
async fn mutual_tls_with_a_private_ca() {
    let Ok(dir) = std::env::var("DISPATCH_MTLS_DIR") else { eprintln!("skipped: set DISPATCH_MTLS_DIR"); return };
    let read = |f: &str| std::fs::read_to_string(format!("{dir}/{f}")).unwrap();

    // Unknown CA: refused.
    let e = send_json(base(&dir)).await.unwrap_err();
    assert!(e.to_lowercase().contains("certificate") || e.contains("UnknownIssuer"), "{e}");

    // CA trusted but no client certificate: the server rejects the handshake.
    let mut r = base(&dir);
    r["ca_certs_pem"] = json!([read("ca.pem")]);
    assert!(send_json(r.clone()).await.is_err());

    // CA + client certificate: accepted, and the server sees who we are.
    r["client_cert_pem"] = json!(read("client.pem"));
    r["client_key_pem"] = json!(read("client.key"));
    let ok = send_json(r.clone()).await.expect("mTLS call");
    assert_eq!(ok["status"], 200);
    let body = String::from_utf8(base64_decode(ok["body_base64"].as_str().unwrap())).unwrap();
    assert!(body.contains("dispatch-client"), "{body}");

    // A proxy that isn't there is used (and fails), unless the host is bypassed.
    r["proxy"] = json!("http://127.0.0.1:9");
    assert!(send_json(r.clone()).await.is_err());
    r["no_proxy"] = json!("localhost");
    assert_eq!(send_json(r).await.expect("bypassed")["status"], 200);
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
