import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'
import { SendError } from '../src/core/transport'

class FakeTransport implements Transport {
  readonly label = 'Fake'
  readonly unrestricted = true
  sent: PreparedRequest[] = []
  next: HttpResponse | Error = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '{"hello":"world"}', binary: false, size: 17, timeMs: 42 }
  async send(p: PreparedRequest, _o: SendOptions) {
    this.sent.push(p)
    if (this.next instanceof Error) throw this.next
    return this.next
  }
}

let t: FakeTransport
beforeEach(async () => { await resetForTests(); t = new FakeTransport() })
afterEach(() => cleanup())

async function start() {
  render(<App transport={t} />)
  await screen.findByLabelText('URL')
}
const typeUrl = (v: string) => fireEvent.change(screen.getByLabelText('URL'), { target: { value: v } })
const clickTab = (region: string, name: RegExp) => fireEvent.click(within(screen.getByRole('region', { name: region })).getByRole('tab', { name }))

describe('Dispatch app', () => {
  it('sends a request and shows the pretty-printed response', async () => {
    await start()
    typeUrl('api.test/items?limit=5')
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    expect(await screen.findByText('200 OK')).toBeTruthy()
    expect(screen.getByText('42 ms')).toBeTruthy()
    expect(screen.getByText(/"hello": "world"/)).toBeTruthy()
    expect(t.sent[0]).toMatchObject({ method: 'GET', url: 'https://api.test/items?limit=5' })
    // params tab reflects the query string
    clickTab('Request', /Params/)
    expect((screen.getByLabelText('Query params Key 1') as HTMLInputElement).value).toBe('limit')
  })

  it('keeps URL and params in sync both ways', async () => {
    await start()
    typeUrl('https://a.test/x?q=1')
    fireEvent.change(screen.getByLabelText('Query params Value 1'), { target: { value: 'two words' } })
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://a.test/x?q=two%20words')
    fireEvent.change(screen.getByLabelText('Query params Key 2'), { target: { value: 'page' } })
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://a.test/x?q=two%20words&page')
    fireEvent.click(screen.getByLabelText('Use q'))
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://a.test/x?page')
  })

  it('imports a pasted curl command', async () => {
    await start()
    fireEvent.paste(screen.getByLabelText('URL'), { clipboardData: { getData: () => `curl -X POST https://api.test/users -H 'X-Trace: 1' --data-raw '{"a":1}'` } })
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('POST')
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://api.test/users')
    expect(await screen.findByText('Imported from curl.')).toBeTruthy()
    clickTab('Request', /Body/)
    expect((screen.getByLabelText('Body') as HTMLTextAreaElement).value).toContain('"a": 1')
  })

  it('shows a friendly error and records it in history', async () => {
    await start()
    t.next = new SendError('No response after 30 seconds.')
    typeUrl('https://slow.test')
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'No response after 30 seconds.')
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('slow.test')).toBeTruthy()
  })

  it('saves into a new collection and inherits its auth', async () => {
    await start()
    typeUrl('https://api.test/me')
    fireEvent.change(screen.getByLabelText('Request name'), { target: { value: 'Who am I' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(dialog).getByLabelText('New collection name'), { target: { value: 'Shop API' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Shop API' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Who am I/ })).toBeTruthy()
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()

    // set collection auth to bearer
    fireEvent.click(screen.getByRole('button', { name: 'Shop API' }))
    const editor = await screen.findByRole('region', { name: 'Collection' })
    fireEvent.change(within(editor).getByLabelText('Auth type'), { target: { value: 'bearer' } })
    fireEvent.change(within(editor).getByLabelText('Token'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: /Who am I/ }))
    await screen.findByLabelText('URL')
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await screen.findByText('200 OK')
    expect(t.sent[0].headers).toContainEqual(['Authorization', 'Bearer abc'])
  })

  it('fills variables from the active environment and warns about missing ones', async () => {
    await start()
    typeUrl('{{base}}/ping')
    expect(screen.getByRole('status').textContent).toMatch(/No value for \{\{base\}\}/)
    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New' }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(dialog).getByLabelText('New environment'), { target: { value: 'Local' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK', hidden: true }))
    const editor = await screen.findByRole('region', { name: 'Environment' })
    fireEvent.change(within(editor).getByLabelText('Environment variables Variable 1'), { target: { value: 'base' } })
    fireEvent.change(within(editor).getByLabelText('Environment variables Value 1'), { target: { value: 'http://localhost:8080' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Use this environment' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New request' }))
    // the discard confirmation
    const confirm = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(confirm).getByRole('button', { name: 'OK', hidden: true }))
    await waitFor(() => expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(''))
    typeUrl('{{base}}/ping')
    expect(screen.queryByText(/No value for/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await screen.findByText('200 OK')
    expect(t.sent[0].url).toBe('http://localhost:8080/ping')
  })

  it('imports a Postman collection file', async () => {
    await start()
    const file = new File([JSON.stringify({
      info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'List pets', request: { method: 'GET', url: 'https://pets.test/pets' } }],
    })], 'pets.json', { type: 'application/json' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(await screen.findByText(/Imported 1 collection, 1 request/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pets' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /List pets/ }))
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://pets.test/pets')
  })

  it('keeps saved data after a reload', async () => {
    await start()
    typeUrl('https://keep.test')
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    cleanup()
    await start()
    expect(await screen.findByRole('button', { name: /keep\.test/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'My API' })).toBeTruthy()
  })
})
