const https = require('https'), fs = require('fs')
https.createServer({ key: fs.readFileSync(__dirname + '/server.key'), cert: fs.readFileSync(__dirname + '/server.pem'), ca: fs.readFileSync(__dirname + '/ca.pem'), requestCert: true, rejectUnauthorized: true },
  (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ client: req.socket.getPeerCertificate().subject?.CN ?? null })) })
  .listen(8444, '127.0.0.1', () => console.log('mTLS on https://127.0.0.1:8444'))
