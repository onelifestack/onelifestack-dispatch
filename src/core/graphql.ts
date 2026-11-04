/**
 * GraphQL helpers: fetch a schema by introspection, check a query against it, and list fields for the explorer.
 */
import {
  type GraphQLSchema, type GraphQLField, type GraphQLNamedType, type IntrospectionQuery,
  buildClientSchema, getIntrospectionQuery, getNamedType, isObjectType, isInterfaceType, isInputObjectType, isEnumType, isUnionType,
  parse, validate, GraphQLError,
} from 'graphql'
import type { PreparedRequest } from './types'
import type { SendOptions, Transport } from './transport'
import { SendError } from './transport'

export type { GraphQLSchema }

/** Fetches the schema with the standard introspection query, using the request's URL, headers and auth. */
export async function fetchSchema(base: PreparedRequest, transport: Transport, opts: SendOptions): Promise<GraphQLSchema> {
  const headers = base.headers.filter(([k]) => k.toLowerCase() !== 'content-type')
  headers.push(['Content-Type', 'application/json'])
  const res = await transport.send({ ...base, method: 'POST', headers, body: JSON.stringify({ query: getIntrospectionQuery() }), multipart: null, bodyFile: null }, opts)
  let json: { data?: IntrospectionQuery; errors?: { message: string }[] }
  try { json = JSON.parse(res.body) } catch { throw new SendError(`The server didn’t answer with JSON (${res.status} ${res.statusText}).`) }
  if (!json.data) throw new SendError(json.errors?.length ? `Introspection failed: ${json.errors[0].message}` : `Introspection failed (${res.status}). The server may have it turned off.`)
  return buildClientSchema(json.data)
}

export interface QueryProblem { message: string; line?: number; column?: number }

/** Syntax errors always; schema errors (unknown fields, wrong args…) when a schema is loaded. */
export function checkQuery(query: string, schema: GraphQLSchema | null): QueryProblem[] {
  if (!query.trim()) return []
  try {
    const doc = parse(query)
    if (!schema) return []
    return validate(schema, doc).map((e) => ({ message: e.message, line: e.locations?.[0]?.line, column: e.locations?.[0]?.column }))
  } catch (e) {
    if (e instanceof GraphQLError) return [{ message: e.message, line: e.locations?.[0]?.line, column: e.locations?.[0]?.column }]
    return [{ message: String(e) }]
  }
}

export interface FieldInfo { name: string; type: string; args: string; description: string; leaf: boolean }

const fieldInfo = (f: GraphQLField<unknown, unknown>): FieldInfo => ({
  name: f.name, type: String(f.type), description: f.description ?? '',
  args: f.args.map((a) => `${a.name}: ${String(a.type)}`).join(', '),
  leaf: !(isObjectType(getNamedType(f.type)) || isInterfaceType(getNamedType(f.type)) || isUnionType(getNamedType(f.type))),
})

/** Root operations and their fields. */
export function rootFields(schema: GraphQLSchema): { kind: 'query' | 'mutation' | 'subscription'; fields: FieldInfo[] }[] {
  const roots: [ 'query' | 'mutation' | 'subscription', ReturnType<GraphQLSchema['getQueryType']>][] = [['query', schema.getQueryType()], ['mutation', schema.getMutationType()], ['subscription', schema.getSubscriptionType()]]
  return roots.filter(([, t]) => t).map(([kind, t]) => ({ kind, fields: Object.values(t!.getFields()).map(fieldInfo) }))
}

/** Fields of a named type (for drilling into the explorer). */
export function typeFields(schema: GraphQLSchema, name: string): { type: GraphQLNamedType | undefined; fields: FieldInfo[]; values: string[] } {
  const t = schema.getType(name)
  if (!t) return { type: undefined, fields: [], values: [] }
  if (isObjectType(t) || isInterfaceType(t)) return { type: t, fields: Object.values(t.getFields()).map(fieldInfo), values: [] }
  if (isInputObjectType(t)) return { type: t, fields: Object.values(t.getFields()).map((f) => ({ name: f.name, type: String(f.type), args: '', description: f.description ?? '', leaf: true })), values: [] }
  if (isEnumType(t)) return { type: t, fields: [], values: t.getValues().map((v) => v.name) }
  if (isUnionType(t)) return { type: t, fields: [], values: t.getTypes().map((x) => x.name) }
  return { type: t, fields: [], values: [] }
}

/** A starter operation for a root field: required args as variables, scalar fields selected. */
export function starterQuery(schema: GraphQLSchema, kind: 'query' | 'mutation' | 'subscription', fieldName: string): { query: string; variables: string } {
  const root = kind === 'query' ? schema.getQueryType() : kind === 'mutation' ? schema.getMutationType() : schema.getSubscriptionType()
  const f = root?.getFields()[fieldName]
  if (!f) return { query: '', variables: '' }
  const required = f.args.filter((a) => String(a.type).endsWith('!'))
  const vars = required.map((a) => `$${a.name}: ${String(a.type)}`).join(', ')
  const args = required.map((a) => `${a.name}: $${a.name}`).join(', ')
  const named = getNamedType(f.type)
  let selection = ''
  if (isObjectType(named) || isInterfaceType(named)) {
    const scalars = Object.values(named.getFields()).filter((x) => { const n = getNamedType(x.type); return !(isObjectType(n) || isInterfaceType(n) || isUnionType(n)) && !x.args.some((a) => String(a.type).endsWith('!')) })
    selection = ` {\n    ${(scalars.length ? scalars : Object.values(named.getFields())).slice(0, 8).map((x) => x.name).join('\n    ')}\n  }`
  } else if (isUnionType(named)) selection = ' {\n    __typename\n  }'
  const opName = fieldName[0].toUpperCase() + fieldName.slice(1)
  return {
    query: `${kind} ${opName}${vars ? `(${vars})` : ''} {\n  ${fieldName}${args ? `(${args})` : ''}${selection}\n}`,
    variables: required.length ? JSON.stringify(Object.fromEntries(required.map((a) => [a.name, sampleFor(String(a.type))])), null, 2) : '',
  }
}

const sampleFor = (t: string): unknown => (t.startsWith('[') ? [] : /Int|Float/.test(t) ? 0 : /Boolean/.test(t) ? true : t.replace('!', '') === 'ID' ? '1' : '')
