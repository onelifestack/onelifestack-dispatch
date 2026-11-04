import { describe, expect, it } from 'vitest'
import { beforeAll } from 'vitest'
import { importFile, importFileAsync, type ImportResult } from '../src/core/backup'
import { sampleFromSchema } from '../src/core/openapi'
import { prepare } from '../src/core/prepare'
import { folderChain } from '../src/core/runtime'

const yamlSpec = `
openapi: 3.0.3
info: { title: Pet Store, version: "1.2", description: Pets for all }
servers:
  - url: https://{env}.pets.test/v1
    variables: { env: { default: api } }
tags: [{ name: pets, description: Everything about pets }, { name: store }]
security: [{ bearer: [] }]
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
    key: { type: apiKey, in: header, name: X-Key }
  schemas:
    Pet:
      type: object
      properties:
        id: { type: integer, example: 7 }
        name: { type: string }
        tags: { type: array, items: { $ref: '#/components/schemas/Tag' } }
        parent: { $ref: '#/components/schemas/Pet' }
    Tag: { type: object, properties: { label: { type: string, enum: [cute, old] } } }
paths:
  /pets/{petId}:
    parameters: [{ name: petId, in: path, required: true, schema: { type: integer, example: 42 } }]
    get:
      tags: [pets]
      summary: Get a pet
      parameters:
        - { name: verbose, in: query, schema: { type: boolean } }
        - { name: lang, in: query, required: true, schema: { type: string, default: en } }
      responses:
        "200": { description: The pet, content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
        "404": { description: Not found }
  /pets:
    post:
      tags: [pets]
      operationId: addPet
      security: [{ key: [] }]
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Pet' } } } }
      responses: { "201": { description: Created } }
  /upload:
    post:
      tags: [store]
      security: []
      requestBody:
        content:
          multipart/form-data:
            schema: { type: object, properties: { photo: { type: string, format: binary }, note: { type: string, example: hi } } }
      responses: { "204": { description: Done } }
`

describe('OpenAPI import', () => {
  let r: ImportResult
  let get: ImportResult['requests'][number], add: typeof get, upload: typeof get
  beforeAll(async () => { r = await importFileAsync(yamlSpec); [get, add, upload] = r.requests })
  it('reads YAML, servers, tags and folders', () => {
    expect(r.source).toBe('openapi')
    expect(r.collections[0]).toMatchObject({ name: 'Pet Store', auth: { kind: 'bearer', token: '{{bearerToken}}' } })
    expect(r.collections[0].variables.find((v) => v.key === 'baseUrl')?.value).toBe('https://api.pets.test/v1')
    expect(r.collections[0].variables.find((v) => v.key === 'bearerToken')?.secret).toBe(true)
    expect(r.folders.map((f) => f.name).sort()).toEqual(['pets', 'store'])
    expect(get.folderId).toBe(r.folders.find((f) => f.name === 'pets')!.id)
  })
  it('turns parameters into path variables, query params and a sample body', () => {
    expect(get.name).toBe('Get a pet')
    expect(get.url).toBe('{{baseUrl}}/pets/:petId?lang=en')
    expect(get.pathVars.map((p) => [p.key, p.value])).toEqual([['petId', '42']])
    expect(get.params.map((p) => [p.key, p.enabled])).toEqual([['lang', true], ['verbose', false]])
    const sent = prepare(get, { collection: r.collections[0], folders: folderChain(r.folders, get.folderId) })
    expect(sent.url).toBe('https://api.pets.test/v1/pets/42?lang=en')
    expect(JSON.parse(add.body.text)).toMatchObject({ id: 7, name: 'string', tags: [{ label: 'cute' }] })
    expect(get.examples[0]).toMatchObject({ status: 200, name: 'The pet' })
  })
  it('handles per-operation security and multipart bodies', () => {
    expect(add.name).toBe('addPet')
    expect(add.auth).toMatchObject({ kind: 'apikey', key: 'X-Key', value: '{{apiKey}}' })
    expect(upload.auth.kind).toBe('none')
    expect(upload.body.kind).toBe('formdata')
    expect(upload.body.fields.map((f) => [f.key, f.type, f.value])).toEqual([['photo', 'file', ''], ['note', 'text', 'hi']])
  })
  it('stops on recursive schemas', () => {
    const spec = { components: { schemas: { N: { type: 'object', properties: { next: { $ref: '#/components/schemas/N' } } } } } }
    expect(JSON.stringify(sampleFromSchema(spec, { $ref: '#/components/schemas/N' })).length).toBeLessThan(200)
  })
  it('reads Swagger 2', () => {
    const s = importFile(JSON.stringify({ swagger: '2.0', info: { title: 'Old' }, host: 'old.test', basePath: '/api', schemes: ['http'],
      securityDefinitions: { basic: { type: 'basic' } }, security: [{ basic: [] }],
      paths: { '/things': { post: { parameters: [{ in: 'body', name: 'b', schema: { type: 'object', properties: { a: { type: 'string', example: 'x' } } } }], responses: { 200: { description: 'ok' } } } } } }))
    expect(s.collections[0].variables[0].value).toBe('http://old.test/api')
    expect(s.collections[0].auth.kind).toBe('basic')
    expect(JSON.parse(s.requests[0].body.text)).toEqual({ a: 'x' })
  })
})

describe('HAR import', () => {
  it('keeps requests, bodies and the recorded response', () => {
    const har = { log: { version: '1.2', pages: [{ title: 'My app' }], entries: [
      { request: { method: 'POST', url: 'https://app.test/api/login?x=1', headers: [{ name: ':authority', value: 'app.test' }, { name: 'Content-Type', value: 'application/json' }, { name: 'Cookie', value: 'a=b' }],
          postData: { mimeType: 'application/json', text: '{"u":"ann"}' } },
        response: { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], content: { text: '{"ok":true}' } } },
      { request: { method: 'POST', url: 'https://app.test/form', headers: [], postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a', value: '1' }] } }, response: { status: 302, headers: [], content: {} } },
    ] } }
    const r = importFile(JSON.stringify(har))
    expect(r.source).toBe('har'); expect(r.collections[0].name).toBe('My app')
    const [login, form] = r.requests
    expect(login.name).toBe('POST /api/login')
    expect(login.headers.map((h) => h.key)).toEqual(['Content-Type', 'Cookie'])
    expect(login.params.map((p) => p.key)).toEqual(['x'])
    expect(login.body).toMatchObject({ kind: 'json', text: '{"u":"ann"}' })
    expect(login.examples[0]).toMatchObject({ status: 200, body: '{"ok":true}' })
    expect(form.body.fields.map((f) => [f.key, f.value])).toEqual([['a', '1']])
    expect(r.warnings.join(' ')).toMatch(/cookies or Authorization/)
  })
})
