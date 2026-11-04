import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { buildRoutes, fillMockBody, matchRoute, mockPath } from '../src/core/mock'
import { collectionMarkdown } from '../src/core/docs'
import { Markdown } from '../src/ui/Markdown'
import { emptyAuth, emptyBody, kv, newCollection, newFolder, newRequest, uid } from '../src/core/types'

const col = { ...newCollection('Shop'), docs: 'The **shop** API.', auth: { ...emptyAuth('bearer'), token: '{{t}}' }, variables: [kv('baseUrl', 'https://shop.test'), kv('t', 'abc', true, { secret: true })] }
const f = { ...newFolder(col.id, 'Orders'), sort: 2, docs: 'All about orders' }
const ex = (name: string, status: number, body: string) => ({ id: uid(), name, status, headers: [['Content-Type', 'application/json']] as [string, string][], body })
const list = newRequest({ name: 'List', url: '{{baseUrl}}/orders', collectionId: col.id, folderId: f.id, sort: 1, examples: [ex('ok', 200, '[]')] })
const one = newRequest({ name: 'One', url: '{{baseUrl}}/orders/:id', collectionId: col.id, folderId: f.id, sort: 2, examples: [ex('found', 200, '{"id":"{{id}}"}'), ex('missing', 404, '{"error":"nope"}')],
  pathVars: [kv('id', '7')], docs: 'Gets **one** order.' })
const mine = newRequest({ name: 'Mine', url: 'https://shop.test/orders/mine', collectionId: col.id, folderId: f.id, sort: 3, examples: [ex('mine', 200, '{"mine":true}')] })
const login = newRequest({ name: 'Login', method: 'POST', url: '{{baseUrl}}/login', collectionId: col.id, sort: 1, body: { ...emptyBody('json'), text: '{"u":"x"}' } })

describe('mock routes', () => {
  const routes = buildRoutes(col, [f], [list, one, mine, login])
  it('builds paths from URLs and skips requests without examples', () => {
    expect(mockPath('{{baseUrl}}/a/:id?x=1')).toBe('/a/:id')
    expect(mockPath('https://h:8080/a/{{id}}/')).toBe('/a/:id')
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /orders', 'GET /orders/:id', 'GET /orders/mine'])
  })
  it('matches params, prefers literal segments, and picks examples', () => {
    const a = matchRoute(routes, 'GET', '/orders/42')!
    expect(a.response.name).toBe('found'); expect(fillMockBody(a.response.body, a.params)).toBe('{"id":"42"}')
    expect(matchRoute(routes, 'GET', '/orders/mine')!.route.name).toBe('Mine')
    expect(matchRoute(routes, 'GET', '/orders/42', { 'X-Mock-Response-Code': '404' })!.response.name).toBe('missing')
    expect(matchRoute(routes, 'GET', '/orders/42?__example=missing')!.response.status).toBe(404)
    expect(matchRoute(routes, 'POST', '/orders')).toBeNull()
    expect(matchRoute(routes, 'HEAD', '/orders')!.route.name).toBe('List')
  })
})

describe('docs', () => {
  const md = collectionMarkdown(col, [f], [list, one, login])
  it('writes the collection in order without secrets', () => {
    expect(md.indexOf('POST Login')).toBeLessThan(md.indexOf('## Orders'))
    expect(md).toContain('Gets **one** order.')
    expect(md).toContain('| `t` | (secret) |')
    expect(md).not.toContain('abc')
    expect(md).toContain('**Example: missing** — 404')
  })
  it('renders Markdown safely', () => {
    const { container } = render(<Markdown text={'# Title\n\nHi **there** and `code` [ok](https://a.test) [bad](javascript:alert(1))\n\n- one\n- two\n\n<img src=x onerror=alert(1)>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```\nx < y\n```'} />)
    expect(container.querySelector('h2')?.textContent).toBe('Title')
    expect(container.querySelector('strong')?.textContent).toBe('there')
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://a.test')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('td')?.textContent).toBe('1')
    expect(container.querySelector('pre')?.textContent).toBe('x < y')
  })
  it('never stalls on odd input', () => {
    for (const t of ['| lonely pipe row |', '|', '```', '> ', '- ', '#', '---', '| a |\n| b |', '1)', '**', '[x](', 'a\n\n\n|x|y|\n|--|']) {
      expect(() => render(<Markdown text={t} />)).not.toThrow()
    }
  })
})
