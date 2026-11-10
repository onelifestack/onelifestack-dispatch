// Draws the installer artwork (src-tauri/installer/*) from the app icon and the site fonts.
// Dev tool, not part of the build: run it after changing the look, then commit the images.
//   PLAYWRIGHT=<dir with playwright-core> CHROMIUM=<path to a headless chromium, optional> node scripts/make-installer-art.mjs
// Needs a Chromium that playwright-core can launch (see CLAUDE.md, "Visual check without a desktop").
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const out = path.join(root, 'src-tauri/installer')
const pwDir = process.env.PLAYWRIGHT ?? path.join(process.env.HOME, 'projects/github-tools/rea/node_modules/playwright-core')
const { chromium } = createRequire(import.meta.url)(pwDir)
mkdirSync(out, { recursive: true })

const icon = 'data:image/png;base64,' + readFileSync(path.join(root, 'src-tauri/icons/icon.png')).toString('base64')
const font = (w) => pathToFileURL(path.join(root, `site/src/assets/fonts/nunito-${w}.woff2`)).href
const css = `
@font-face{font-family:N;font-weight:700;src:url(${font(700)})}
@font-face{font-family:N;font-weight:800;src:url(${font(800)})}
*{box-sizing:border-box;margin:0}
body{font-family:N,sans-serif;overflow:hidden}
.panel{position:absolute;left:0;top:0;bottom:0;width:164px;color:#fff;
  background:radial-gradient(120% 70% at 20% 0%,#7A4DF0 0%,#5A2DDD 45%,#3A1B96 100%)}
.panel img{position:absolute;left:22px;top:30px;width:68px;height:68px;border-radius:16px;box-shadow:0 6px 18px #1a0a5066}
.panel h1{position:absolute;left:22px;top:112px;font-weight:800;font-size:28px;letter-spacing:-.5px}
.panel p{position:absolute;left:22px;top:150px;width:124px;font-weight:700;font-size:13px;line-height:1.4;color:#E6DCFF}
.panel small{position:absolute;left:22px;bottom:22px;font-weight:700;font-size:11px;letter-spacing:.6px;color:#C9B8F5;text-transform:uppercase}
.dots{position:absolute;left:22px;bottom:52px;display:flex;gap:6px}
.dots i{width:6px;height:6px;border-radius:50%;background:#FFC145}.dots i:nth-child(2){opacity:.6}.dots i:nth-child(3){opacity:.3}
`
const html = (w, h, body, bg) => `<!doctype html><meta charset=utf-8><style>${css}body{width:${w}px;height:${h}px;background:${bg}}</style><body>${body}`
const panel = `<div class=panel><img src="${icon}"><h1>Dispatch</h1><p>A local-first API client. Your requests stay on your computer.</p><div class=dots><i></i><i></i><i></i></div><small>OneLifeStack</small></div>`

const jobs = [
  { name: 'nsis-sidebar', w: 164, h: 314, bmp: true, html: html(164, 314, panel, '#fff') },
  { name: 'nsis-header', w: 150, h: 57, bmp: true,
    html: html(150, 57, `<img src="${icon}" style="position:absolute;right:12px;top:8px;width:41px;height:41px;border-radius:10px"><div style="position:absolute;right:62px;top:17px;font-weight:800;font-size:17px;color:#26173D;letter-spacing:-.3px">Dispatch</div>`, '#fff') },
  { name: 'wix-dialog', w: 493, h: 312, bmp: true, html: html(493, 312, panel, '#fff') },
  { name: 'wix-banner', w: 493, h: 58, bmp: true,
    html: html(493, 58, `<img src="${icon}" style="position:absolute;right:16px;top:9px;width:40px;height:40px;border-radius:10px"><div style="position:absolute;right:66px;top:17px;font-weight:800;font-size:19px;color:#26173D;letter-spacing:-.3px">Dispatch</div>`, '#fff') },
  { name: 'dmg-background', w: 660, h: 400, bmp: false,
    html: html(660, 400, `
      <div style="position:absolute;inset:0;background:radial-gradient(90% 80% at 50% 0%,#FFF3E4 0%,#FFF9F2 70%)"></div>
      <div style="position:absolute;top:34px;left:0;right:0;text-align:center;font-weight:800;font-size:24px;color:#26173D;letter-spacing:-.4px">Drag Dispatch into Applications</div>
      <div style="position:absolute;top:70px;left:0;right:0;text-align:center;font-weight:700;font-size:13px;color:#5E4D72">Then open it from Launchpad. Your data stays on this Mac.</div>
      <svg style="position:absolute;left:268px;top:158px" width="124" height="64" viewBox="0 0 124 64" fill="none" stroke="#5A2DDD" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 32h104M84 8l28 24-28 24" stroke-dasharray="0 0"/></svg>
      <div style="position:absolute;bottom:26px;left:0;right:0;text-align:center;font-weight:700;font-size:11px;letter-spacing:.7px;color:#9a88b0;text-transform:uppercase">OneLifeStack</div>`, '#FFF9F2') },
]

/** 24-bit BMP (bottom-up), from RGBA at 2x averaged down to 1x: smooth edges, no alpha (NSIS and WiX need that). */
function bmp(rgba, w2, h2) {
  const w = w2 / 2, h = h2 / 2, row = Math.ceil((w * 3) / 4) * 4, buf = Buffer.alloc(54 + row * h)
  buf.write('BM'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = [0, 0, 0]
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((y * 2 + dy) * w2 + x * 2 + dx) * 4; c[0] += rgba[i]; c[1] += rgba[i + 1]; c[2] += rgba[i + 2] }
    const o = 54 + (h - 1 - y) * row + x * 3
    buf[o] = Math.round(c[2] / 4); buf[o + 1] = Math.round(c[1] / 4); buf[o + 2] = Math.round(c[0] / 4)
  }
  return buf
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'installer-art-'))
const open = async (browser, j, scale) => {
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: scale })
  const file = path.join(tmp, `${j.name}.html`); writeFileSync(file, j.html)
  await page.goto(pathToFileURL(file).href); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(150)
  return page
}
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
for (const j of jobs) {
  // The Chromium we have is older than playwright-core expects; its screenshot sometimes stalls waiting for
  // fonts, so retry on a fresh page.
  let page, png
  for (let attempt = 1; !png; attempt++) {
    page = await open(browser, j, j.bmp ? 2 : 1)
    try { png = await page.screenshot({ timeout: 8000 }) } catch (e) { await page.close(); if (attempt >= 5) throw e }
  }
  if (j.bmp) {
    const px = await page.evaluate(async (u) => {
      const im = new Image(); im.src = u; await im.decode()
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height
      const g = c.getContext('2d'); g.drawImage(im, 0, 0)
      return Array.from(g.getImageData(0, 0, c.width, c.height).data)
    }, 'data:image/png;base64,' + png.toString('base64'))
    writeFileSync(path.join(out, `${j.name}.bmp`), bmp(Uint8ClampedArray.from(px), j.w * 2, j.h * 2))
  } else writeFileSync(path.join(out, `${j.name}.png`), png)
  await page.close()
}
await browser.close()
rmSync(tmp, { recursive: true, force: true })
console.log('wrote', jobs.map((j) => j.name).join(', '))
