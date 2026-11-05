/** Bugs found by the Windows test of 0.4.3 (#8): a deleted flow came back (#14); Sign out didn't stick (#15). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import * as db from '../src/core/db'
import type { McpSignIn } from '../src/core/mcpAuth'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'
import { InlineEngine } from '../src/core/scriptPipeline'

const json = (body: unknown, headers: [string, string][] = []): HttpResponse => {
  const b = JSON.stringify(body)
  return { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ...headers], body: b, binary: false, size: b.length, timeMs: 1 }
}
const side = () => within(screen.getByRole('complementary', { name: 'Library' }))

beforeEach(async () => { await db.resetForTests() })
afterEach(() => cleanup())

describe('Deleting a flow (#14)', () => {
  it('stays deleted after the editor closes, and Undo still brings it back', async () => {
    const t: Transport = { label: 'fake', unrestricted: true, send: async () => json({}) }
    render(<App transport={t} engine={new InlineEngine()} />)
    await screen.findByLabelText('URL')
    fireEvent.click(side().getByRole('tab', { name: 'Flows' }))
    fireEvent.click(side().getByRole('button', { name: '+ New' }))
    let d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByRole('textbox', { hidden: true }), { target: { value: 'Tmp three' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    const view = await screen.findByRole('region', { name: 'Flow Tmp three' })
    expect((await db.listFlows()).map((f) => f.name)).toEqual(['Tmp three'])

    fireEvent.click(within(view).getByRole('button', { name: 'Delete' }))
    d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: /Delete|OK/, hidden: true }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Flow Tmp three' })).toBeNull())
    // The editor's last save used to run here and write the flow back.
    await new Promise((r) => setTimeout(r, 400))
    expect(await db.listFlows()).toEqual([])

    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(async () => expect((await db.listFlows()).map((f) => f.name)).toEqual(['Tmp three']))
  })
})

describe('MCP Sign out (#15)', () => {
  it('sticks even when closing the connection refreshes a token that is about to run out', async () => {
    const url = 'http://mcp.test/mcp'
    let refreshes = 0
    const t: Transport = {
      label: 'fake', unrestricted: true,
      async send(p: PreparedRequest, _o: SendOptions) {
        if (p.url === 'http://auth.test/token') { refreshes++; return json({ access_token: `a${refreshes}`, refresh_token: 'r', expires_in: 30 }) }
        if (p.method === 'DELETE') return json({})
        const msg = JSON.parse(p.body ?? '{}')
        if (msg.method === 'initialize') return json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo' } } }, [['mcp-session-id', 's1']])
        if (msg.id === undefined) return { ...json({}), status: 202, body: '' }
        return json({ jsonrpc: '2.0', id: msg.id, result: { tools: [], resources: [], prompts: [] } })
      },
    }
    // A sign-in whose token has 30 s left: every request refreshes it first.
    const s: McpSignIn = {
      envId: null, serverUrl: url, resource: url, issuer: 'http://auth.test', authorizationEndpoint: 'http://auth.test/authorize', tokenEndpoint: 'http://auth.test/token',
      clientId: 'c', clientSecret: '', registered: true, redirectUri: 'http://127.0.0.1:33418/callback', scope: '', accessToken: 'a0', refreshToken: 'r', expiresAt: Date.now() + 30_000, signedInAt: Date.now(),
    }
    await db.putMcpSignIns([s])

    render(<App transport={t} />)
    await screen.findByLabelText('URL')
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'mcp' } })
    const pane = await screen.findByRole('region', { name: 'MCP' })
    fireEvent.change(within(pane).getByLabelText('URL'), { target: { value: url } })
    expect(await within(pane).findByText('Signed in')).toBeTruthy()
    fireEvent.click(within(pane).getByRole('button', { name: 'Connect' }))
    await within(pane).findByRole('button', { name: 'Disconnect' })

    const before = refreshes
    fireEvent.click(within(pane).getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText(/Signed out\./)).toBeTruthy()
    await waitFor(() => expect(within(pane).queryByText('Signed in')).toBeNull())
    expect(await db.getMcpSignIns()).toEqual([])
    expect(refreshes).toBe(before) // no refresh after Sign out
  })
})
