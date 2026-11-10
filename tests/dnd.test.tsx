/** Drag and drop beyond the sidebar: Ctrl+drag copies, tabs save into collections, requests drop onto flows and the runner. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { App } from '../src/ui/App'
import { resetForTests } from '../src/core/db'
import type { HttpResponse, PreparedRequest } from '../src/core/types'
import type { SendOptions, Transport } from '../src/core/transport'
import { InlineEngine } from '../src/core/scriptPipeline'

class FakeTransport implements Transport {
  readonly label = 'Fake'
  readonly unrestricted = true
  sent: PreparedRequest[] = []
  async send(p: PreparedRequest, _o: SendOptions): Promise<HttpResponse> {
    this.sent.push(p)
    return { status: 200, statusText: 'OK', headers: [], body: '{}', binary: false, size: 2, timeMs: 1 }
  }
}

/** Like the browser's: data set on dragstart is readable on drop, and `types` lists what's there during dragover. */
class FakeDataTransfer {
  data: Record<string, string> = {}
  effectAllowed = ''
  dropEffect = ''
  get types() { return Object.keys(this.data) }
  setData(k: string, v: string) { this.data[k] = v }
  getData(k: string) { return this.data[k] ?? '' }
}

let t: FakeTransport
beforeEach(async () => { await resetForTests(); t = new FakeTransport() })
afterEach(() => cleanup())

const side = () => within(screen.getByRole('complementary', { name: 'Library' }))
const names = () => [...document.querySelectorAll('.tree .rowName')].map((e) => e.textContent)
const row = (n: string) => side().getAllByRole('button', { name: new RegExp(`^(GET|POST) ${n}$`) })[0].closest('li')!
const folderRow = (n: string) => side().getByRole('button', { name: n }).closest('.row')!

async function startWithShop(engine?: InlineEngine) {
  render(<App transport={t} engine={engine} />)
  await screen.findByLabelText('URL')
  const file = new File([JSON.stringify({
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'A', request: { method: 'GET', url: 'https://s.test/a' } },
      { name: 'B', request: { method: 'POST', url: 'https://s.test/b' } },
      { name: 'Box', item: [{ name: 'In box', request: { method: 'GET', url: 'https://s.test/in' } }] },
    ],
  })], 'shop.json', { type: 'application/json' })
  await act(async () => { fireEvent.change(document.querySelector('input[aria-label="Import file"]')!, { target: { files: [file] } }) })
  await screen.findByText(/Imported 1 collection/)
}

async function drag(from: Element, to: Element, opts: { ctrlKey?: boolean } = {}) {
  const dt = new FakeDataTransfer()
  fireEvent.dragStart(from, { dataTransfer: dt })
  // jsdom has no DragEvent, so modifier keys given to fireEvent are dropped; set them on the event itself.
  const make = (kind: 'dragOver' | 'drop') => { const ev = createEvent[kind](to, { dataTransfer: dt }); Object.defineProperty(ev, 'ctrlKey', { value: !!opts.ctrlKey }); Object.defineProperty(ev, 'altKey', { value: false }); return ev }
  fireEvent(to, make('dragOver'))
  await act(async () => { fireEvent(to, make('drop')) })
  fireEvent.dragEnd(from, { dataTransfer: dt })
  return dt
}

describe('drag and drop', () => {
  it('copies with Ctrl held and moves without it', async () => {
    await startWithShop()
    expect(names()).toEqual(['A', 'B', 'Box', 'In box'])
    // Ctrl-drop A into Box: a copy (same name), the original stays.
    await drag(row('A'), folderRow('Box'), { ctrlKey: true })
    expect(names()).toEqual(['A', 'B', 'Box', 'In box', 'A'])
    // Ctrl-drop B before A in the same place: “B copy” lands before A.
    await drag(row('B'), row('A'), { ctrlKey: true })
    expect(names().slice(0, 3)).toEqual(['B copy', 'A', 'B'])
    // Ctrl-drop the Box folder onto the collection: a whole copy of the folder and its requests.
    await drag(folderRow('Box'), folderRow('Shop'), { ctrlKey: true })
    expect(names().filter((n) => n === 'In box')).toHaveLength(2)
    expect(names()).toContain('Box copy')
    // Plain drop still moves.
    await drag(row('B'), folderRow('Box'))
    expect(names().filter((n) => n === 'B')).toHaveLength(1)
  })

  it('saves an open tab into the folder it is dropped on', async () => {
    await startWithShop()
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://s.test/new' } })
    fireEvent.change(screen.getByLabelText('Request name'), { target: { value: 'Fresh' } })
    const tab = screen.getByRole('tab', { name: /Fresh/ }).closest('.reqTab')!
    await drag(tab, folderRow('Box'))
    expect(names()).toEqual(['A', 'B', 'Box', 'In box', 'Fresh'])
    // Saved: the tab isn't marked as having unsaved changes.
    expect(screen.getByRole('button', { name: 'Close Fresh' }).textContent).toBe('×')
  })

  it('adds dropped requests and folders to the runner', async () => {
    await startWithShop()
    fireEvent.click(side().getByRole('button', { name: '▶ Runner' }))
    const view = await screen.findByRole('region', { name: 'Runner' })
    const target = within(view).getByRole('heading', { name: 'What to run' }).parentElement!
    await drag(row('B'), target)
    await drag(folderRow('Box'), target)
    const picks = () => [...within(view).getByRole('list', { name: 'Requests to run' }).querySelectorAll('li')].map((li) => li.textContent)
    // The untouched default (whole Shop) was replaced by what was dropped.
    expect(picks()).toHaveLength(2)
    expect(picks()[0]).toContain('B')
    expect(picks()[1]).toContain('In box')
  })

  it('drops requests onto a flow as wired request blocks', async () => {
    await startWithShop(new InlineEngine())
    fireEvent.click(side().getByRole('tab', { name: 'Flows' }))
    fireEvent.click(side().getByRole('button', { name: '+ New' }))
    const d = await screen.findByRole('dialog', { hidden: true })
    fireEvent.change(within(d).getByRole('textbox', { hidden: true }), { target: { value: 'Dropped' } })
    fireEvent.click(within(d).getByRole('button', { name: 'OK', hidden: true }))
    const view = await screen.findByRole('region', { name: 'Flow Dropped' })
    fireEvent.click(side().getByRole('tab', { name: 'Collections' }))
    // Ctrl-click A and B, then drag A: both come along, in sidebar order.
    fireEvent.click(side().getByRole('button', { name: /^GET A$/ }), { ctrlKey: true })
    fireEvent.click(side().getByRole('button', { name: /^POST B$/ }), { ctrlKey: true })
    await drag(row('A'), view.querySelector('.flowCanvas')!)
    expect(within(view).getByRole('button', { name: /A \(request\)/ })).toBeTruthy()
    expect(within(view).getByRole('button', { name: /B \(request\)/ })).toBeTruthy()
    // A Box folder drop adds the request inside it.
    await drag(folderRow('Box'), view.querySelector('.flowCanvas')!)
    expect(within(view).getByRole('button', { name: /In box \(request\)/ })).toBeTruthy()
  })
})
