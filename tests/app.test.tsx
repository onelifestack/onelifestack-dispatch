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
const side = () => within(screen.getByRole('complementary', { name: 'Library' }))
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
    expect(await screen.findByText(/^Imported from curl\./)).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(dialog).getByLabelText('New collection name'), { target: { value: 'Shop API' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    expect(await screen.findByText('Saved.')).toBeTruthy()
    expect(side().getByRole('button', { name: 'Shop API' })).toBeTruthy()
    expect(side().getByRole('button', { name: /Who am I/ })).toBeTruthy()
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull()

    // set collection auth to bearer
    fireEvent.click(side().getByRole('button', { name: 'Shop API' }))
    const editor = await screen.findByRole('region', { name: 'Collection' })
    fireEvent.change(within(editor).getByLabelText('Auth type'), { target: { value: 'bearer' } })
    fireEvent.change(within(editor).getByLabelText('Token'), { target: { value: 'abc' } })
    fireEvent.click(side().getByRole('button', { name: /Who am I/ }))
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
    const input = document.querySelector('input[aria-label="Import file"]') as HTMLInputElement
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }) })
    expect(await screen.findByText(/Imported 1 collection, 1 request/)).toBeTruthy()
    expect(side().getByRole('button', { name: 'Pets' })).toBeTruthy()
    fireEvent.click(side().getByRole('button', { name: /List pets/ }))
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://pets.test/pets')
  })

  it('keeps saved data after a reload', async () => {
    await start()
    typeUrl('https://keep.test')
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    const dialog = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    cleanup()
    await start()
    expect(await side().findByRole('button', { name: /keep\.test/ })).toBeTruthy()
    expect(side().getByRole('button', { name: 'My API' })).toBeTruthy()
  })

  it('keeps several requests open in tabs and restores them after a reload', async () => {
    await start()
    typeUrl('https://one.test')
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await waitFor(() => expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(''))
    typeUrl('https://two.test')
    const bar = within(screen.getByRole('tablist', { name: 'Open requests' }))
    expect(bar.getAllByRole('tab')).toHaveLength(2)
    fireEvent.click(bar.getAllByRole('tab')[0])
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://one.test')
    // closing a tab with changes asks first
    fireEvent.click(bar.getAllByRole('button', { name: /^Close/ })[1])
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel', hidden: true }))
    await new Promise((r) => setTimeout(r, 500)) // tabs are saved after a short pause
    cleanup()
    await start()
    const bar2 = within(screen.getByRole('tablist', { name: 'Open requests' }))
    expect(bar2.getAllByRole('tab')).toHaveLength(2)
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('https://one.test')
  })

  it('makes nested folders, saves into one and inherits folder auth', async () => {
    await start()
    // collection
    fireEvent.click(side().getByRole('button', { name: '+ Collection' }))
    let d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New collection'), { target: { value: 'Shop' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    await side().findByRole('button', { name: 'Shop' })
    // folder via the collection menu
    fireEvent.click(side().getByRole('menuitem', { name: 'New folder', hidden: true }))
    d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New folder'), { target: { value: 'Orders' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    fireEvent.click(await side().findByRole('button', { name: 'Orders' }))
    const editor = await screen.findByRole('region', { name: 'Folder' })
    fireEvent.change(within(editor).getByLabelText('Auth type'), { target: { value: 'apikey' } })
    fireEvent.change(within(editor).getByLabelText('Key'), { target: { value: 'X-Key' } })
    fireEvent.change(within(editor).getByLabelText('Value'), { target: { value: 'secret' } })
    // new request in the folder
    fireEvent.click(within(editor).getByRole('button', { name: 'New request here' }))
    typeUrl('https://shop.test/orders/:id')
    clickTab('Request', /Params/)
    fireEvent.change(screen.getByLabelText('Path variables Value 1'), { target: { value: '42' } })
    clickTab('Request', /Auth/)
    expect(screen.getByText(/Uses Orders’s auth/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await screen.findByText('200 OK')
    expect(t.sent[0].url).toBe('https://shop.test/orders/42')
    expect(t.sent[0].headers).toContainEqual(['X-Key', 'secret'])
    // save: the dialog offers the folder
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    d = await screen.findByRole('dialog', { hidden: true })
    expect((within(d).getByLabelText('Folder') as HTMLSelectElement).value).not.toBe('')
    fireEvent.click(within(d).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    expect(side().getByRole('button', { name: /shop\.test\/orders\/:id/ })).toBeTruthy()
  })

  it('runs post-response tests, shows results and logs to the console', async () => {
    await start()
    typeUrl('https://api.test/hello')
    clickTab('Request', /Scripts/)
    fireEvent.click(screen.getByRole('tab', { name: /After response/ }))
    fireEvent.change(screen.getByLabelText('Post-response script'), { target: { value: `pm.test('says hello', () => pm.expect(pm.response.json().hello).to.equal('world'))\npm.test('is 201', () => pm.response.to.have.status(201))\nconsole.log('done')\npm.environment.set('x', 1)` } })
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    expect(await screen.findByText('1/2 tests passed')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('region', { name: 'Response' })).getByRole('tab', { name: /Tests/ }))
    const list = screen.getByRole('list', { name: 'Test results' })
    expect(within(list).getByText('says hello')).toBeTruthy()
    expect(within(list).getByText(/expected 200 to equal 201|expected status 201/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Console/ }))
    expect(within(screen.getByRole('log')).getByText('done')).toBeTruthy()
  })

  it('runs a saved collection in the runner with a data file', async () => {
    t.next = { status: 200, statusText: 'OK', headers: [], body: '{"ok":true}', binary: false, size: 11, timeMs: 4 }
    await start()
    typeUrl('https://api.test/users/{{user}}')
    clickTab('Request', /Scripts/)
    fireEvent.click(screen.getByRole('tab', { name: /After response/ }))
    fireEvent.change(screen.getByLabelText('Post-response script'), { target: { value: `pm.test('ok', () => pm.expect(pm.response.json().ok).to.equal(true))` } })
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    fireEvent.click(side().getByRole('button', { name: /Runner/ }))
    const runner = await screen.findByRole('region', { name: 'Runner' })
    const csv = new File(['user\nann\nbo\n'], 'users.csv', { type: 'text/csv' })
    await act(async () => { fireEvent.change(within(runner).getByLabelText('Data file'), { target: { files: [csv] } }) })
    await within(runner).findByText(/users\.csv · 2 rows/)
    fireEvent.click(within(runner).getByRole('button', { name: /Run 2 requests/ }))
    await within(runner).findByRole('button', { name: 'Export JUnit' })
    expect(t.sent.map((p) => p.url)).toEqual(['https://api.test/users/ann', 'https://api.test/users/bo'])
    expect(within(runner).getByRole('status').textContent).toMatch(/2 sent.*2 tests passed/)
  })

  it('load-tests the open tab after confirming permission', async () => {
    await start()
    typeUrl('https://api.test/ping')
    fireEvent.click(side().getByRole('button', { name: /Load test/ }))
    const view = await screen.findByRole('region', { name: 'Load test' })
    fireEvent.change(within(view).getByLabelText('Run for'), { target: { value: 'iterations' } })
    fireEvent.change(within(view).getByLabelText('Loops per user'), { target: { value: '3' } })
    fireEvent.change(within(view).getByLabelText(/Virtual users/), { target: { value: '4' } })
    fireEvent.change(within(view).getByLabelText(/Ramp-up/), { target: { value: '0' } })
    const startBtn = within(view).getByRole('button', { name: /Start load test/ }) as HTMLButtonElement
    expect(startBtn.disabled).toBe(true)
    fireEvent.click(within(view).getByLabelText(/permission to load-test/))
    fireEvent.click(startBtn)
    await within(view).findByText('Results', {}, { timeout: 3000 })
    expect(t.sent).toHaveLength(12)
    expect(within(view).getByText(/✓ Passed/)).toBeTruthy()
  })

  it('undoes a deleted collection, and restores a local backup', async () => {
    await start()
    typeUrl('https://keep.test/a')
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    let d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New collection name'), { target: { value: 'Keep me' } })
    fireEvent.click(within(d).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    // delete via the collection editor, then undo
    fireEvent.click(side().getByRole('button', { name: 'Keep me' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete collection' }))
    d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'Delete', hidden: true }))
    await screen.findByText(/Deleted “Keep me”/)
    expect(side().queryByRole('button', { name: 'Keep me' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await side().findByRole('button', { name: 'Keep me' })).toBeTruthy()
    expect(side().getByRole('button', { name: /keep\.test\/a/ })).toBeTruthy()
    // back up, add another collection, restore → it's gone again
    fireEvent.click(screen.getByRole('menuitem', { name: /Local backups/, hidden: true }))
    const view = await screen.findByRole('region', { name: 'Backups' })
    fireEvent.click(within(view).getByRole('button', { name: 'Back up now' }))
    await screen.findByText('Backup made.')
    fireEvent.click(side().getByRole('button', { name: '+ Collection' }))
    d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New collection'), { target: { value: 'Later' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    await side().findByRole('button', { name: 'Later' })
    fireEvent.click(screen.getByRole('menuitem', { name: /Local backups/, hidden: true }))
    const v2 = await screen.findByRole('region', { name: 'Backups' })
    fireEvent.click(within(v2).getAllByRole('button', { name: 'Restore' })[0])
    d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    await screen.findByText('Backup restored.')
    expect(side().queryByRole('button', { name: 'Later' })).toBeNull()
    expect(side().getByRole('button', { name: 'Keep me' })).toBeTruthy()
  })

  it('moves and reorders with drag and drop, multi-selects, and searches bodies', async () => {
    await start()
    const file = new File([JSON.stringify({
      info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        { name: 'A', request: { method: 'GET', url: 'https://s.test/a' } },
        { name: 'B', request: { method: 'POST', url: 'https://s.test/b', body: { mode: 'raw', raw: '{"needle": 1}' } } },
        { name: 'C', request: { method: 'GET', url: 'https://s.test/c' } },
        { name: 'Box', item: [] },
      ],
    })], 'shop.json', { type: 'application/json' })
    await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
    await screen.findByText(/Imported 1 collection/)
    const names = () => [...document.querySelectorAll('.tree .rowName')].map((e) => e.textContent)
    expect(names()).toEqual(['A', 'B', 'C', 'Box'])
    const dt = { setData: () => {}, effectAllowed: '', dropEffect: '' }
    const row = (n: string) => side().getByRole('button', { name: new RegExp(`^(GET|POST) ${n}$`) }).closest('li')!
    // drag C before A
    fireEvent.dragStart(row('C'), { dataTransfer: dt })
    fireEvent.dragOver(row('A'), { dataTransfer: dt })
    await act(async () => { fireEvent.drop(row('A'), { dataTransfer: dt }) })
    expect(names()).toEqual(['C', 'A', 'B', 'Box'])
    // drag A into the Box folder
    fireEvent.dragStart(row('A'), { dataTransfer: dt })
    const box = side().getByRole('button', { name: 'Box' }).closest('.row')!
    fireEvent.dragOver(box, { dataTransfer: dt })
    await act(async () => { fireEvent.drop(box, { dataTransfer: dt }) })
    expect(names()).toEqual(['C', 'B', 'Box', 'A'])
    // search by body text
    fireEvent.change(side().getByLabelText('Filter requests'), { target: { value: 'needle' } })
    expect(names()).toEqual(['B'])
    fireEvent.change(side().getByLabelText('Filter requests'), { target: { value: '' } })
    // ctrl-click two, delete together, undo once
    fireEvent.click(side().getByRole('button', { name: /^GET C$/ }), { ctrlKey: true })
    fireEvent.click(side().getByRole('button', { name: /^POST B$/ }), { ctrlKey: true })
    expect(screen.getByRole('toolbar', { name: 'Selected requests' }).textContent).toMatch(/2 selected/)
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Selected requests' })).getByRole('button', { name: 'Delete' }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'Delete', hidden: true }))
    await screen.findByText('Deleted 2 requests.')
    expect(names()).toEqual(['Box', 'A'])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(names()).toEqual(['C', 'B', 'Box', 'A']))
  })

  it('creates a schedule and runs it now', async () => {
    await start()
    typeUrl('https://api.test/health')
    fireEvent.click(screen.getByRole('button', { name: /^Save Ctrl/ }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.click(within(d).getByRole('button', { name: 'Save', hidden: true }))
    await screen.findByText('Saved.')
    fireEvent.click(side().getByRole('button', { name: /Schedules/ }))
    const view = await screen.findByRole('region', { name: 'Schedules' })
    fireEvent.click(within(view).getByRole('button', { name: '+ New schedule' }))
    fireEvent.change(await within(view).findByLabelText('Every (minutes)'), { target: { value: '5' } })
    fireEvent.click(within(view).getByRole('button', { name: 'Run now' }))
    expect(await screen.findByText('My API check passed.')).toBeTruthy()
    expect(t.sent.map((p) => p.url)).toEqual(['https://api.test/health'])
    expect(within(view).getByText(/1 requests, 0 passed, 0 failed/)).toBeTruthy()
    expect(within(view).getByText('passing')).toBeTruthy()
  })

  it('lists earlier responses for a request and compares them', async () => {
    await start()
    typeUrl('https://api.test/stock')
    t.next = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '{"apples":3,"pears":1}', binary: false, size: 22, timeMs: 5 }
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await screen.findByText('200 OK')
    t.next = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], body: '{"apples":2,"pears":1}', binary: false, size: 22, timeMs: 6 }
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await screen.findByText('6 ms')
    const pane = screen.getByRole('region', { name: 'Response' })
    fireEvent.click(await within(pane).findByRole('tab', { name: /History/ })) // history is saved just after the response shows
    const table = within(pane).getByRole('table', { name: 'Earlier responses' })
    expect(within(table).getAllByRole('row')).toHaveLength(1)
    fireEvent.click(within(table).getByRole('button', { name: 'Compare' }))
    const diff = within(pane).getByLabelText('Differences')
    expect(diff.textContent).toContain('−   "apples": 3,')
    expect(diff.textContent).toContain('+   "apples": 2,')
    expect(within(pane).getByText(/time 5 ms → 6 ms/)).toBeTruthy()
  })

  it('duplicates an environment with its values', async () => {
    await start()
    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }))
    fireEvent.click(side().getByRole('button', { name: '+ New' }))
    let d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New environment'), { target: { value: 'Prod' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    const ed = await screen.findByRole('region', { name: 'Environment' })
    fireEvent.change(within(ed).getByLabelText('Environment variables Variable 1'), { target: { value: 'host' } })
    fireEvent.change(within(ed).getByLabelText('Environment variables Value 1'), { target: { value: 'prod.test' } })
    fireEvent.click(within(ed).getByRole('button', { name: 'Duplicate' }))
    await side().findByRole('button', { name: 'Prod copy' })
    const copy = await screen.findByRole('region', { name: 'Environment' })
    expect((within(copy).getByLabelText('Environment name') as HTMLInputElement).value).toBe('Prod copy')
    expect((within(copy).getByLabelText('Environment variables Value 1') as HTMLInputElement).value).toBe('prod.test')
  })

  it('parameterizes a pasted curl into variables in a new environment', async () => {
    await start()
    fireEvent.paste(screen.getByLabelText('URL'), { clipboardData: { getData: () => `curl https://api.shop.test/users/12345 -H 'Authorization: Bearer abc.def.ghi'` } })
    fireEvent.click(await screen.findByText('Parameterize', { selector: '.toastAction' }))
    const panel = await screen.findByRole('dialog', { name: 'Parameterize' })
    expect(within(panel).getByText(/Base URL → \{\{baseUrl\}\}/)).toBeTruthy()
    expect(within(panel).getByText(/\/12345 → \/:userId/)).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: /^Apply/ }))
    await screen.findByText(/Parameterized: 3 changes, 2 new variables/)
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/users/:userId')
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await screen.findByText('200 OK')
    expect(t.sent[0].url).toBe('https://api.shop.test/users/12345')
    expect(t.sent[0].headers).toContainEqual(['Authorization', 'Bearer abc.def.ghi'])
    expect((screen.getByRole('combobox', { name: 'Environment' }) as HTMLSelectElement).selectedOptions[0].textContent).toBe('Default')
  })

  it('switches an endpoint between alternatives from the top bar', async () => {
    await start()
    fireEvent.click(screen.getByRole('tab', { name: 'Environments' }))
    fireEvent.click(side().getByRole('button', { name: '+ New' }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByLabelText('New environment'), { target: { value: 'Prod' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    const ed = await screen.findByRole('region', { name: 'Environment' })
    fireEvent.change(within(ed).getByLabelText('Environment variables Variable 1'), { target: { value: 'base' } })
    fireEvent.change(within(ed).getByLabelText('Environment variables Value 1'), { target: { value: 'https://lb.test' } })
    fireEvent.change(within(ed).getByLabelText('Variable to give alternatives'), { target: { value: within(ed).getByRole('option', { name: 'base' }).getAttribute('value') } })
    fireEvent.click(within(ed).getByRole('button', { name: 'Add alternatives' }))
    fireEvent.change(within(ed).getByLabelText('base alternative 1 name'), { target: { value: 'load balancer' } })
    fireEvent.change(within(ed).getByLabelText('base alternative 2 name'), { target: { value: 'pod-1' } })
    fireEvent.change(within(ed).getByLabelText('base alternative 2 value'), { target: { value: 'http://10.0.0.5:8080' } })
    fireEvent.click(within(ed).getByRole('button', { name: 'Use this environment' }))
    fireEvent.click(screen.getByRole('button', { name: '+ New request' }))
    typeUrl('{{base}}/health')
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await screen.findByText('200 OK')
    fireEvent.change(screen.getByLabelText('Alternative for base'), { target: { value: 'pod-1' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }))
    await waitFor(() => expect(t.sent).toHaveLength(2))
    expect(t.sent.map((p) => p.url)).toEqual(['https://lb.test/health', 'http://10.0.0.5:8080/health'])
  })
})
