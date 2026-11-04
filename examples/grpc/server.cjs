const grpc = require('@grpc/grpc-js')
const loader = require('@grpc/proto-loader')
const { ReflectionService } = require('@grpc/reflection')
const def = loader.loadSync(__dirname + '/greeter.proto', { includeDirs: [__dirname] })
const pkg = grpc.loadPackageDefinition(def)
const server = new grpc.Server()
const now = () => ({ seconds: Math.floor(Date.now() / 1000), nanos: 0 })
server.addService(pkg.demo.v1.Greeter.service, {
  SayHello: (call, cb) => {
    if (call.request.name === 'error') return cb({ code: grpc.status.INVALID_ARGUMENT, details: 'name may not be "error"' })
    cb(null, { message: `Hello ${call.request.name} (auth: ${call.metadata.get('authorization')[0] ?? 'none'})`, at: now() })
  },
  SayManyTimes: (call) => { for (let i = 0; i < (call.request.times || 3); i++) call.write({ message: `Hi #${i + 1} ${call.request.name}`, at: now() }); call.end() },
  CountNames: (call, cb) => { let n = 0; call.on('data', () => n++); call.on('end', () => cb(null, { total: n })) },
})
new ReflectionService(def).addToServer(server)
server.bindAsync('127.0.0.1:50051', grpc.ServerCredentials.createInsecure(), () => console.log('gRPC on 127.0.0.1:50051'))
