import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { buildSchema, introspectionFromSchema } from 'graphql'
import { checkQuery, fetchSchema, rootFields, starterQuery } from '../src/core/graphql'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'

const sdl = `
  type Query { me: User, user(id: ID!): User, search(term: String!, limit: Int): [Result!]! }
  type Mutation { rename(id: ID!, name: String!): User }
  type User { id: ID!, name: String, friends(first: Int!): [User!] }
  type Post { id: ID!, title: String }
  union Result = User | Post
`
class Fake implements Transport {
  readonly label = 'fake'; readonly unrestricted = true
  sent: PreparedRequest[] = []
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    const body = JSON.stringify({ data: introspectionFromSchema(buildSchema(sdl)) })
    return { status: 200, statusText: 'OK', headers: [], body, binary: false, size: body.length, timeMs: 1 }
  }
}

describe('GraphQL helpers', () => {
  it('fetches a schema by introspection with the request headers', async () => {
    const t = new Fake()
    const schema = await fetchSchema({ method: 'GET', url: 'https://g.test/graphql', headers: [['Authorization', 'Bearer x']], body: null, unresolved: [] }, t, { timeoutMs: 1000, followRedirects: true, insecureTls: false })
    expect(t.sent[0].method).toBe('POST'); expect(t.sent[0].headers).toContainEqual(['Authorization', 'Bearer x'])
    expect(rootFields(schema).map((r) => [r.kind, r.fields.map((f) => f.name)])).toEqual([['query', ['me', 'user', 'search']], ['mutation', ['rename']]])
    expect(checkQuery('{ me { id nope } }', schema)[0].message).toMatch(/Cannot query field "nope"/)
    expect(checkQuery('{ me { id } }', schema)).toEqual([])
    expect(checkQuery('{ me { ', null)[0].line).toBe(1)
    const s = starterQuery(schema, 'mutation', 'rename')
    expect(s.query).toBe('mutation Rename($id: ID!, $name: String!) {\n  rename(id: $id, name: $name) {\n    id\n    name\n  }\n}')
    expect(JSON.parse(s.variables)).toEqual({ id: '1', name: '' })
    expect(checkQuery(starterQuery(schema, 'query', 'search').query, schema)).toEqual([])
  })
})

class FakeSocket {
  static last: FakeSocket
  sent: string[] = []
  protocol = ''
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: (e: { code: number; reason: string }) => void; onerror?: () => void
  constructor(public url: string, public protocols: string[]) { FakeSocket.last = this }
  send(t: string) { this.sent.push(t); setTimeout(() => this.onmessage?.({ data: `echo:${t}` }), 0) }
  close() { this.onclose?.({ code: 1000, reason: '' }) }
}

describe('WebSocket pane', () => {
  beforeEach(async () => { await resetForTests() })
  afterEach(() => cleanup())
  it('connects, sends with variables, logs the echo and saves messages', async () => {
    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket
    render(<App transport={new Fake()} />)
    await screen.findByLabelText('URL')
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'ws' } })
    const pane = await screen.findByRole('region', { name: 'WebSocket' })
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: 'wss://echo.test/socket' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'Connect' }))
    await act(async () => { await Promise.resolve() })
    expect(FakeSocket.last.url).toBe('wss://echo.test/socket')
    act(() => FakeSocket.last.onopen?.())
    expect(pane.querySelector('.connDot.open')).toBeTruthy()
    fireEvent.change(within(pane).getByLabelText('Message'), { target: { value: '{"n": {{$randomInt}}}' } })
    fireEvent.click(within(pane).getByRole('button', { name: 'Send' }))
    expect(FakeSocket.last.sent[0]).toMatch(/^\{"n": \d+\}$/)
    await within(pane).findByText(/echo:/)
    fireEvent.click(within(pane).getByRole('button', { name: 'Save message' }))
    expect(within(pane).getByRole('list', { name: 'Message log' })).toBeTruthy()
    expect(within(pane).getAllByRole('button', { name: 'Send' }).length).toBe(2)
    fireEvent.click(within(pane).getByRole('button', { name: 'Disconnect' }))
    expect(within(pane).getByText(/Closed \(1000\)/)).toBeTruthy()
  })
})
