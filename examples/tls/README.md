# Mutual TLS test server

    sh examples/tls/make-certs.sh       # throwaway CA + server and client certificates
    node examples/tls/server.cjs        # https://localhost:8444, requires a client certificate

In Dispatch (desktop) → Settings: add `ca.pem` under CA certificates, and a client certificate for host
`localhost` with `client.pem` and `client.key`. A GET to https://localhost:8444/ then answers with your client
certificate's name. Rust test: `DISPATCH_MTLS_DIR=examples/tls cargo test --test network_live` in `src-tauri/`.
