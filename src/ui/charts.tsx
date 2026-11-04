import { useState } from 'react'
import type { Bucket } from '../core/load'

/** Rounds an axis maximum up to a friendly number (1, 2, 2.5, 5 × 10ⁿ). */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p
  return 10 * p
}

const W = 640
const H = 200
const PAD = { l: 44, r: 64, t: 12, b: 26 }
const iw = W - PAD.l - PAD.r
const ih = H - PAD.t - PAD.b

function Axes({ max, unit, n, xAt }: { max: number; unit: string; n: number; xAt?: (i: number) => number }) {
  const ticks = [0, max / 2, max]
  const xs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]
  const at = xAt ?? ((i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * iw))
  return <g className="axis">
    {ticks.map((v) => {
      const y = PAD.t + ih - (v / max) * ih
      return <g key={v}><line x1={PAD.l} x2={PAD.l + iw} y1={y} y2={y} className="grid" /><text x={PAD.l - 6} y={y + 4} textAnchor="end">{Math.round(v)}{unit}</text></g>
    })}
    {xs.map((i) => <text key={i} x={at(i)} y={H - 6} textAnchor="middle">{i}s</text>)}
  </g>
}

/** Median and p95 latency per second: two 2px lines, legend + direct end labels, crosshair tooltip. */
export function LatencyChart({ timeline }: { timeline: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const pts = timeline.filter((b) => b.count > 0)
  if (pts.length < 2) return <p className="muted small">The latency chart appears after a couple of seconds.</p>
  const n = timeline.length
  const max = niceMax(Math.max(...pts.map((b) => b.p95)) * 1.1)
  const x = (sec: number) => PAD.l + (n <= 1 ? 0 : (sec / (n - 1)) * iw)
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const path = (key: 'p50' | 'p95') => pts.map((b, i) => `${i ? 'L' : 'M'}${x(b.second).toFixed(1)},${y(b[key]).toFixed(1)}`).join('')
  const last = pts[pts.length - 1]
  const h = hover !== null ? timeline[hover] : null
  return (
    <figure className="viz">
      <figcaption>
        <span className="vizTitle">Response time per second</span>
        <span className="legend"><span className="key s1" />median (p50)<span className="key s2" />p95</span>
      </figcaption>
      <div className="vizBox">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Response time per second: median ending at ${last.p50} ms, p95 ending at ${last.p95} ms`}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * W
            setHover(Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / iw) * (n - 1)))))
          }} onMouseLeave={() => setHover(null)}>
          <Axes max={max} unit="ms" n={n} />
          <path d={path('p50')} className="line s1" />
          <path d={path('p95')} className="line s2" />
          <text x={x(last.second) + 6} y={y(last.p95) + 4} className="endLabel">p95 {last.p95}</text>
          <text x={x(last.second) + 6} y={y(last.p50) + 4 + (Math.abs(y(last.p50) - y(last.p95)) < 12 ? 12 : 0)} className="endLabel">p50 {last.p50}</text>
          {h && h.count > 0 && <g>
            <line x1={x(h.second)} x2={x(h.second)} y1={PAD.t} y2={PAD.t + ih} className="crosshair" />
            <circle cx={x(h.second)} cy={y(h.p50)} r={4} className="dot s1" />
            <circle cx={x(h.second)} cy={y(h.p95)} r={4} className="dot s2" />
          </g>}
        </svg>
        {h && <div className="tip" style={{ left: `${(x(h.second) / W) * 100}%` }} role="status">
          <b>{h.second}s</b><span><i className="key s1" />p50 {h.p50} ms</span><span><i className="key s2" />p95 {h.p95} ms</span><span>{h.count} requests{h.errors ? `, ${h.errors} failed` : ''}</span>
        </div>}
      </div>
    </figure>
  )
}

/** Requests per second as bars; failed requests stack on top in the error colour. */
export function ThroughputChart({ timeline }: { timeline: Bucket[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (timeline.length < 1 || !timeline.some((b) => b.count)) return null
  const n = timeline.length
  const max = niceMax(Math.max(...timeline.map((b) => b.count)) * 1.1)
  const slot = iw / n
  const bw = Math.max(1, Math.min(18, slot - 2))
  const y = (v: number) => PAD.t + ih - (v / max) * ih
  const h = hover !== null ? timeline[hover] : null
  return (
    <figure className="viz">
      <figcaption>
        <span className="vizTitle">Requests per second</span>
        <span className="legend"><span className="key s1" />succeeded<span className="key err" />failed</span>
      </figcaption>
      <div className="vizBox">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Requests per second" onMouseLeave={() => setHover(null)}>
          <Axes max={max} unit="" n={n} xAt={(i) => PAD.l + slot * (i + 0.5)} />
          {timeline.map((b, i) => {
            const cx = PAD.l + slot * (i + 0.5)
            const ok = b.count - b.errors
            const top = y(b.count)
            const mid = y(ok)
            return <g key={b.second} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={PAD.t} width={slot} height={ih} className="hit" />
              {ok > 0 && <rect x={cx - bw / 2} y={mid} width={bw} height={PAD.t + ih - mid} rx={Math.min(2, bw / 2)} className="bar s1" />}
              {b.errors > 0 && <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(1, mid - top - (ok > 0 ? 2 : 0))} rx={Math.min(2, bw / 2)} className="bar err" />}
            </g>
          })}
        </svg>
        {h && <div className="tip" style={{ left: `${((PAD.l + slot * (hover! + 0.5)) / W) * 100}%` }} role="status">
          <b>{h.second}s</b><span>{h.count} requests</span>{h.errors > 0 && <span><i className="key err" />{h.errors} failed</span>}<span>{h.activeUsers} users active</span>
        </div>}
      </div>
    </figure>
  )
}
