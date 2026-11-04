import type { PreparedRequest } from './types'
import { toCurl } from './curl'

export interface Language { id: string; label: string; generate: (p: PreparedRequest) => string }

/** A string literal for languages with C-like escapes (JS, Java, C#, Go, Rust, Python, Ruby, PHP double quotes…). */
const dq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
const sq = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const posix = (s: string) => (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`
const indent = (s: string, n: number) => s.split('\n').map((l, i) => (i ? ' '.repeat(n) + l : l)).join('\n')
const isJson = (p: PreparedRequest) => p.headers.some(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('json'))
const prettyBody = (p: PreparedRequest) => { if (!p.body || !isJson(p)) return p.body; try { return JSON.stringify(JSON.parse(p.body), null, 2) } catch { return p.body } }
const bodyNote = (p: PreparedRequest) => (p.bodyFile ? `body: file ${p.bodyFile.name}` : null)
const noCt = (p: PreparedRequest) => (p.multipart ? p.headers.filter(([k]) => k.toLowerCase() !== 'content-type') : p.headers)

const fetchJs: Language = {
  id: 'js-fetch', label: 'JavaScript (fetch)',
  generate: (p) => {
    const lines: string[] = []
    if (p.multipart) {
      lines.push('const form = new FormData()')
      for (const part of p.multipart) lines.push(part.file ? `form.append(${dq(part.name)}, fileInput.files[0], ${dq(part.file.name)}) // choose the file` : `form.append(${dq(part.name)}, ${dq(part.value ?? '')})`)
      lines.push('')
    }
    const opts = [`method: ${dq(p.method)}`]
    const hs = noCt(p)
    if (hs.length) opts.push(`headers: {\n${hs.map(([k, v]) => `  ${dq(k)}: ${dq(v)},`).join('\n')}\n}`)
    if (p.multipart) opts.push('body: form')
    else if (p.bodyFile) opts.push(`body: file // ${p.bodyFile.name}`)
    else if (p.body != null) opts.push(isJson(p) ? `body: JSON.stringify(${indent(prettyBody(p)!, 0)})` : `body: ${dq(p.body)}`)
    lines.push(`const res = await fetch(${dq(p.url)}, {\n  ${opts.map((o) => indent(o, 2)).join(',\n  ')},\n})`)
    lines.push('console.log(res.status, await res.text())')
    return lines.join('\n')
  },
}

const axios: Language = {
  id: 'node-axios', label: 'Node.js (axios)',
  generate: (p) => {
    const lines = ["import axios from 'axios'"]
    if (p.multipart) {
      lines.unshift("import fs from 'node:fs'")
      lines.push('', 'const form = new FormData()')
      for (const part of p.multipart) lines.push(part.file ? `form.append(${sq(part.name)}, new Blob([fs.readFileSync(${sq(part.file.name)})]), ${sq(part.file.name)})` : `form.append(${sq(part.name)}, ${sq(part.value ?? '')})`)
    }
    const cfg = [`method: ${sq(p.method.toLowerCase())}`, `url: ${sq(p.url)}`]
    const hs = noCt(p)
    if (hs.length) cfg.push(`headers: {\n${hs.map(([k, v]) => `  ${sq(k)}: ${sq(v)},`).join('\n')}\n}`)
    if (p.multipart) cfg.push('data: form')
    else if (p.bodyFile) cfg.push(`data: fs.readFileSync(${sq(p.bodyFile.name)})`)
    else if (p.body != null) cfg.push(isJson(p) ? `data: ${prettyBody(p)}` : `data: ${sq(p.body)}`)
    if (p.bodyFile && !p.multipart) lines.unshift("import fs from 'node:fs'")
    lines.push('', `const res = await axios({\n  ${cfg.map((c) => indent(c, 2)).join(',\n  ')},\n  validateStatus: () => true,\n})`, 'console.log(res.status, res.data)')
    return lines.join('\n')
  },
}

const python: Language = {
  id: 'python-requests', label: 'Python (requests)',
  generate: (p) => {
    const lines = ['import requests', '']
    lines.push(`url = ${dq(p.url)}`)
    const hs = noCt(p)
    if (hs.length) lines.push(`headers = {\n${hs.map(([k, v]) => `    ${dq(k)}: ${dq(v)},`).join('\n')}\n}`)
    const args = ['url']
    if (hs.length) args.push('headers=headers')
    if (p.multipart) {
      const text = p.multipart.filter((x) => !x.file), files = p.multipart.filter((x) => x.file)
      if (text.length) { lines.push(`data = {${text.map((x) => `${dq(x.name)}: ${dq(x.value ?? '')}`).join(', ')}}`); args.push('data=data') }
      if (files.length) { lines.push(`files = {${files.map((x) => `${dq(x.name)}: open(${dq(x.file!.name)}, "rb")`).join(', ')}}`); args.push('files=files') }
    } else if (p.bodyFile) { lines.push(`data = open(${dq(p.bodyFile.name)}, "rb")`); args.push('data=data') }
    else if (p.body != null) {
      if (isJson(p)) { try { JSON.parse(p.body); lines.push(`payload = ${pyLiteral(JSON.parse(p.body))}`); args.push('json=payload') } catch { lines.push(`payload = ${dq(p.body)}`); args.push('data=payload') } }
      else { lines.push(`payload = ${dq(p.body)}`); args.push('data=payload') }
    }
    lines.push('', `response = requests.request(${dq(p.method)}, ${args.join(', ')})`, 'print(response.status_code, response.text)')
    return lines.join('\n')
  },
}
function pyLiteral(v: unknown, d = 0): string {
  const pad = '    '.repeat(d + 1), end = '    '.repeat(d)
  if (v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return dq(v)
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => pad + pyLiteral(x, d + 1)).join(',\n')},\n${end}]` : '[]'
  const e = Object.entries(v as object)
  return e.length ? `{\n${e.map(([k, x]) => `${pad}${dq(k)}: ${pyLiteral(x, d + 1)}`).join(',\n')},\n${end}}` : '{}'
}

const go: Language = {
  id: 'go', label: 'Go (net/http)',
  generate: (p) => {
    const hs = noCt(p)
    const imports = ['"fmt"', '"io"', '"net/http"']
    let body = 'nil'
    const pre: string[] = []
    if (p.multipart) {
      imports.push('"bytes"', '"mime/multipart"', '"os"')
      pre.push('var buf bytes.Buffer', 'w := multipart.NewWriter(&buf)')
      for (const part of p.multipart) {
        if (part.file) pre.push(`fw, _ := w.CreateFormFile(${dq(part.name)}, ${dq(part.file.name)})`, `f, _ := os.ReadFile(${dq(part.file.name)})`, 'fw.Write(f)')
        else pre.push(`w.WriteField(${dq(part.name)}, ${dq(part.value ?? '')})`)
      }
      pre.push('w.Close()')
      body = '&buf'
    } else if (p.bodyFile) { imports.push('"os"'); pre.push(`f, _ := os.Open(${dq(p.bodyFile.name)})`); body = 'f' }
    else if (p.body != null) { imports.push('"strings"'); body = `strings.NewReader(${p.body.includes('`') ? dq(p.body) : `\`${p.body}\``})` }
    const lines = [`package main`, '', `import (\n${[...new Set(imports)].sort().map((i) => `\t${i}`).join('\n')}\n)`, '', 'func main() {']
    for (const l of pre) lines.push(`\t${l}`)
    lines.push(`\treq, err := http.NewRequest(${dq(p.method)}, ${dq(p.url)}, ${body})`, '\tif err != nil {\n\t\tpanic(err)\n\t}')
    for (const [k, v] of hs) lines.push(`\treq.Header.Set(${dq(k)}, ${dq(v)})`)
    if (p.multipart) lines.push('\treq.Header.Set("Content-Type", w.FormDataContentType())')
    lines.push('\tres, err := http.DefaultClient.Do(req)', '\tif err != nil {\n\t\tpanic(err)\n\t}', '\tdefer res.Body.Close()', '\tdata, _ := io.ReadAll(res.Body)', '\tfmt.Println(res.Status, string(data))', '}')
    return lines.join('\n')
  },
}

const java: Language = {
  id: 'java', label: 'Java (HttpClient)',
  generate: (p) => {
    const pub = p.bodyFile ? `HttpRequest.BodyPublishers.ofFile(Path.of(${dq(p.bodyFile.name)}))` : p.body != null ? `HttpRequest.BodyPublishers.ofString(${dq(p.body)})` : 'HttpRequest.BodyPublishers.noBody()'
    const lines = ['import java.net.URI;', 'import java.net.http.*;', ...(p.bodyFile ? ['import java.nio.file.Path;'] : []), '', 'public class Main {', '    public static void main(String[] args) throws Exception {',
      '        var request = HttpRequest.newBuilder()', `            .uri(URI.create(${dq(p.url)}))`]
    for (const [k, v] of noCt(p)) lines.push(`            .header(${dq(k)}, ${dq(v)})`)
    lines.push(`            .method(${dq(p.method)}, ${pub})`, '            .build();')
    if (p.multipart) lines.splice(lines.length - 2, 0, '            // form-data: build a multipart body (e.g. with a library) and set its boundary')
    lines.push('        var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());', '        System.out.println(response.statusCode() + " " + response.body());', '    }', '}')
    return lines.join('\n')
  },
}

const csharp: Language = {
  id: 'csharp', label: 'C# (HttpClient)',
  generate: (p) => {
    const ct = p.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]
    const lines = ['using var client = new HttpClient();', `var request = new HttpRequestMessage(new HttpMethod(${dq(p.method)}), ${dq(p.url)});`]
    for (const [k, v] of p.headers) if (k.toLowerCase() !== 'content-type') lines.push(`request.Headers.TryAddWithoutValidation(${dq(k)}, ${dq(v)});`)
    if (p.multipart) {
      lines.push('var form = new MultipartFormDataContent();')
      for (const part of p.multipart) lines.push(part.file ? `form.Add(new ByteArrayContent(File.ReadAllBytes(${dq(part.file.name)})), ${dq(part.name)}, ${dq(part.file.name)});` : `form.Add(new StringContent(${dq(part.value ?? '')}), ${dq(part.name)});`)
      lines.push('request.Content = form;')
    } else if (p.bodyFile) lines.push(`request.Content = new ByteArrayContent(File.ReadAllBytes(${dq(p.bodyFile.name)}));`)
    else if (p.body != null) lines.push(`request.Content = new StringContent(${dq(p.body)}, System.Text.Encoding.UTF8${ct ? `, ${dq(ct.split(';')[0])}` : ''});`)
    lines.push('var response = await client.SendAsync(request);', 'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");')
    return lines.join('\n')
  },
}

const php: Language = {
  id: 'php', label: 'PHP (cURL)',
  generate: (p) => {
    const lines = ['<?php', '$ch = curl_init();', 'curl_setopt_array($ch, [', `    CURLOPT_URL => ${sq(p.url)},`, '    CURLOPT_RETURNTRANSFER => true,', `    CURLOPT_CUSTOMREQUEST => ${sq(p.method)},`]
    const hs = noCt(p)
    if (hs.length) lines.push(`    CURLOPT_HTTPHEADER => [\n${hs.map(([k, v]) => `        ${sq(`${k}: ${v}`)},`).join('\n')}\n    ],`)
    if (p.multipart) lines.push(`    CURLOPT_POSTFIELDS => [\n${p.multipart.map((x) => `        ${sq(x.name)} => ${x.file ? `new CURLFile(${sq(x.file.name)})` : sq(x.value ?? '')},`).join('\n')}\n    ],`)
    else if (p.bodyFile) lines.push(`    CURLOPT_POSTFIELDS => file_get_contents(${sq(p.bodyFile.name)}),`)
    else if (p.body != null) lines.push(`    CURLOPT_POSTFIELDS => ${sq(p.body)},`)
    lines.push(']);', '$body = curl_exec($ch);', 'echo curl_getinfo($ch, CURLINFO_RESPONSE_CODE) . " " . $body;', 'curl_close($ch);')
    return lines.join('\n')
  },
}

const ruby: Language = {
  id: 'ruby', label: 'Ruby (Net::HTTP)',
  generate: (p) => {
    const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' }[p.method]
    const lines = ["require 'net/http'", "require 'uri'", '', `uri = URI(${dq(p.url)})`, `request = Net::HTTP::${cls}.new(uri)`]
    for (const [k, v] of noCt(p)) lines.push(`request[${dq(k)}] = ${dq(v)}`)
    if (p.multipart) lines.push(`request.set_form([${p.multipart.map((x) => (x.file ? `[${dq(x.name)}, File.open(${dq(x.file.name)})]` : `[${dq(x.name)}, ${dq(x.value ?? '')}]`)).join(', ')}], 'multipart/form-data')`)
    else if (p.bodyFile) lines.push(`request.body = File.binread(${dq(p.bodyFile.name)})`)
    else if (p.body != null) lines.push(`request.body = ${dq(p.body)}`)
    lines.push('', "response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') { |http| http.request(request) }", 'puts response.code, response.body')
    return lines.join('\n')
  },
}

const rust: Language = {
  id: 'rust', label: 'Rust (reqwest)',
  generate: (p) => {
    const lines = ['// Cargo.toml: reqwest = { version = "0.12", features = ["multipart"] }, tokio = { version = "1", features = ["full"] }', '#[tokio::main]', 'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
      '    let client = reqwest::Client::new();', `    let response = client`, `        .request(reqwest::Method::from_bytes(b${dq(p.method)})?, ${dq(p.url)})`]
    for (const [k, v] of noCt(p)) lines.push(`        .header(${dq(k)}, ${dq(v)})`)
    if (p.multipart) {
      lines.splice(4, 0, `    let form = reqwest::multipart::Form::new()${p.multipart.map((x) => (x.file ? `\n        .file(${dq(x.name)}, ${dq(x.file.name)}).await?` : `\n        .text(${dq(x.name)}, ${dq(x.value ?? '')})`)).join('')};`)
      lines.push('        .multipart(form)')
    } else if (p.bodyFile) lines.push(`        .body(std::fs::read(${dq(p.bodyFile.name)})?)`)
    else if (p.body != null) lines.push(`        .body(${p.body.includes('"#') ? dq(p.body) : `r#"${p.body}"#`})`)
    lines.push('        .send()', '        .await?;', '    println!("{} {}", response.status(), response.text().await?);', '    Ok(())', '}')
    return lines.join('\n')
  },
}

const httpie: Language = {
  id: 'httpie', label: 'HTTPie',
  generate: (p) => {
    const parts = ['http', ...(p.multipart ? ['--form'] : []), p.method, posix(p.url)]
    for (const [k, v] of noCt(p)) parts.push(posix(`${k}:${v}`))
    if (p.multipart) for (const x of p.multipart) parts.push(posix(x.file ? `${x.name}@${x.file.name}` : `${x.name}=${x.value ?? ''}`))
    const pipeIn = p.bodyFile ? ` < ${posix(p.bodyFile.name)}` : p.body != null && !p.multipart ? '' : ''
    const cmd = parts.join(' \\\n  ') + pipeIn
    return p.body != null && !p.multipart && !p.bodyFile ? `printf '%s' ${posix(p.body)} | ${cmd}` : cmd
  },
}

const powershell: Language = {
  id: 'powershell', label: 'PowerShell',
  generate: (p) => {
    const lines: string[] = []
    const hs = noCt(p).filter(([k]) => k.toLowerCase() !== 'content-type')
    if (hs.length) lines.push(`$headers = @{\n${hs.map(([k, v]) => `    ${ps(k)} = ${ps(v)}`).join('\n')}\n}`)
    const ct = p.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]
    const args = [`-Method ${p.method}`, `-Uri ${ps(p.url)}`]
    if (hs.length) args.push('-Headers $headers')
    if (p.multipart) { lines.push(`$form = @{\n${p.multipart.map((x) => `    ${ps(x.name)} = ${x.file ? `Get-Item ${ps(x.file.name)}` : ps(x.value ?? '')}`).join('\n')}\n}`); args.push('-Form $form') }
    else if (p.bodyFile) args.push(`-InFile ${ps(p.bodyFile.name)}`)
    else if (p.body != null) { lines.push(`$body = ${ps(p.body)}`); args.push('-Body $body') }
    if (ct && !p.multipart) args.push(`-ContentType ${ps(ct)}`)
    lines.push(`$response = Invoke-WebRequest ${args.join(' ')}`, '$response.StatusCode; $response.Content')
    return lines.join('\n')
  },
}

const curl: Language = {
  id: 'curl', label: 'curl',
  generate: (p) => {
    if (!p.multipart && !p.bodyFile) return toCurl(p)
    const parts = ['curl', `-X ${p.method}`, posix(p.url), ...noCt(p).map(([k, v]) => `-H ${posix(`${k}: ${v}`)}`)]
    if (p.multipart) for (const x of p.multipart) parts.push(`-F ${posix(x.file ? `${x.name}=@${x.file.name}` : `${x.name}=${x.value ?? ''}`)}`)
    if (p.bodyFile) parts.push(`--data-binary @${posix(p.bodyFile.name)}`)
    return parts.join(' \\\n  ')
  },
}

export const LANGUAGES: Language[] = [curl, fetchJs, axios, python, go, java, csharp, php, ruby, rust, httpie, powershell]

export function generateCode(langId: string, p: PreparedRequest): string {
  const lang = LANGUAGES.find((l) => l.id === langId) ?? curl
  const code = lang.generate(p)
  const note = bodyNote(p)
  return note && !code.includes(p.bodyFile!.name) ? `${code}\n// ${note}` : code
}
