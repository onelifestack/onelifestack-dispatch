# gRPC test server

A Greeter service (unary, server streaming, client streaming, one error case) with server reflection, used to test
Dispatch's gRPC client. Its packages aren't Dispatch dependencies, so install them next to it first:

    cd examples/grpc && npm init -y && npm install @grpc/grpc-js @grpc/proto-loader @grpc/reflection
    node server.cjs                      # listens on 127.0.0.1:50051

Then in Dispatch (desktop): new request → protocol gRPC → address `localhost:50051` → Load services.
The Rust live test uses it too: `DISPATCH_GRPC_ADDR=127.0.0.1:50051 cargo test --test grpc_live` in `src-tauri/`.
