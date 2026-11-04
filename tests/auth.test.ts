import { describe, expect, it } from 'vitest'
import { authPipeline, digestHeader, finishAuthCode, getClientToken, md5, parseChallenge, refreshToken, signAwsV4, signJwt, startAuthCode } from '../src/core/auth'
import { execute } from '../src/core/runtime'
import { emptyAuth, kv, newEnvironment, newRequest } from '../src/core/types'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  constructor(private readonly reply: (p: PreparedRequest, n: number) => Partial<HttpResponse>) {}
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1, ...this.reply(p, this.sent.length) }
  }
}
const opts = { timeoutMs: 1000, followRedirects: true, insecureTls: false }

describe('crypto building blocks', () => {
  it('computes MD5 test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6')
    expect(md5('a'.repeat(1000))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8')
  })
  it('signs the jwt.io example token', async () => {
    const t = await signJwt({ algorithm: 'HS256', secret: 'your-256-bit-secret', payload: '{"sub":"1234567890","name":"John Doe","iat":1516239022}' })
    expect(t).toBe('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    const withIat = await signJwt({ algorithm: 'HS512', secret: 's', payload: '{}' }, 100)
    expect(JSON.parse(atob(withIat.split('.')[1]))).toEqual({ iat: 100 })
  })
  it('answers the RFC 2617 Digest example', async () => {
    const ch = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!
    const h = await digestHeader(ch, 'GET', 'http://host.com/dir/index.html', 'Mufasa', 'Circle Of Life', '0a4f113b')
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"')
    expect(h).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"')
  })
  it('matches the AWS SigV4 test suite', async () => {
    const keys = { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' }
    const now = new Date('2015-08-30T12:36:00Z')
    const vanilla = await signAwsV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: [], body: null, unresolved: [] }, keys, now)
    expect(vanilla.headers.find(([k]) => k === 'Authorization')![1]).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
    const q = await signAwsV4({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1', headers: [], body: null, unresolved: [] }, keys, now)
    expect(q.headers.find(([k]) => k === 'Authorization')![1]).toMatch(/Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/)
  })
})

describe('OAuth 2', () => {
  const base = { ...emptyAuth('oauth2'), tokenUrl: 'https://auth.test/token', clientId: 'app', clientSecret: 's3', scope: 'read' }
  it('gets client-credentials and password tokens, and refreshes', async () => {
    const t = new Fake((p) => ({ body: JSON.stringify({ access_token: `tok-${new URLSearchParams(p.body!).get('grant_type')}`, refresh_token: 'r1', expires_in: 3600 }) }))
    const cc = await getClientToken(base, t, opts)
    expect(cc.accessToken).toBe('tok-client_credentials'); expect(cc.expiresAt).toBeGreaterThan(Date.now())
    expect(t.sent[0].headers).toContainEqual(['Authorization', `Basic ${btoa('app:s3')}`])
    expect(new URLSearchParams(t.sent[0].body!).get('scope')).toBe('read')
    const pw = await getClientToken({ ...base, grant: 'password', username: 'u', password: 'p', clientAuth: 'body' }, t, opts)
    expect(pw.accessToken).toBe('tok-password')
    expect(Object.fromEntries(new URLSearchParams(t.sent[1].body!))).toMatchObject({ username: 'u', password: 'p', client_id: 'app', client_secret: 's3' })
    expect((await refreshToken({ ...base, refreshToken: 'r1' }, t, opts)).accessToken).toBe('tok-refresh_token')
  })
  it('reports token errors', async () => {
    const t = new Fake(() => ({ status: 400, statusText: 'Bad Request', body: '{"error":"invalid_client","error_description":"Unknown client"}' }))
    await expect(getClientToken(base, t, opts)).rejects.toThrow(/Unknown client/)
  })
  it('runs the authorization code flow with PKCE and checks state', async () => {
    const a = { ...base, grant: 'authorization_code' as const, authUrl: 'https://auth.test/authorize', redirectUri: 'http://127.0.0.1:45719/callback' }
    const s = await startAuthCode(a)
    const u = new URL(s.url)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const t = new Fake(() => ({ body: '{"access_token":"A"}' }))
    await expect(finishAuthCode(a, s, `http://127.0.0.1:45719/callback?code=c&state=wrong`, t, opts)).rejects.toThrow(/state mismatch/)
    const tok = await finishAuthCode(a, s, `http://127.0.0.1:45719/callback?code=c0de&state=${s.state}`, t, opts)
    expect(tok.accessToken).toBe('A')
    expect(Object.fromEntries(new URLSearchParams(t.sent[0].body!))).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', code_verifier: s.verifier })
  })
})

describe('auth pipeline', () => {
  const ctx = (vars: ReturnType<typeof kv>[] = []) => ({ collection: null, folders: [], environment: { ...newEnvironment(), variables: vars }, globals: [] })
  it('answers a Digest challenge and resends', async () => {
    const t = new Fake((p, n) => (n === 1
      ? { status: 401, statusText: 'Unauthorized', headers: [['WWW-Authenticate', 'Digest realm="r", nonce="n1", qop="auth", algorithm=MD5']] }
      : { status: p.headers.some(([k, v]) => k === 'Authorization' && v.includes('username="u"')) ? 200 : 403 }))
    const req = newRequest({ url: 'https://api.test/secure?x=1', auth: { ...emptyAuth('digest'), username: '{{user}}', password: 'pw' } })
    const x = await execute(req, ctx([kv('user', 'u')]), t, opts, authPipeline({}, t))
    expect(x.response?.status).toBe(200)
    expect(t.sent).toHaveLength(2)
    expect(x.sent.headers.find(([k]) => k === 'Authorization')?.[1]).toContain('uri="/secure?x=1"')
  })
  it('signs JWT and AWS requests with variables filled', async () => {
    const t = new Fake(() => ({}))
    const jwt = newRequest({ url: 'https://api.test/', auth: { ...emptyAuth('jwt'), secret: '{{k}}', payload: '{"sub":"{{who}}"}' } })
    const x = await execute(jwt, ctx([kv('k', 'key'), kv('who', 'ann')]), t, opts, authPipeline({}, t))
    const token = x.sent.headers.find(([k]) => k === 'Authorization')![1].replace('Bearer ', '')
    expect(JSON.parse(atob(token.split('.')[1]))).toMatchObject({ sub: 'ann' })
    const aws = newRequest({ url: 'https://api.test/x', auth: { ...emptyAuth('awsv4'), accessKey: 'AK', secretKey: 'SK', region: 'eu-west-1', service: 'execute-api' } })
    const y = await execute(aws, ctx(), t, opts, authPipeline({}, t))
    expect(y.sent.headers.find(([k]) => k === 'Authorization')![1]).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/eu-west-1\/execute-api\/aws4_request/)
  })
})
