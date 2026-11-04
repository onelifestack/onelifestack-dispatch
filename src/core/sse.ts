/** A server-sent events (text/event-stream) parser, fed text as it arrives. */
export interface SseEvent { event: string; data: string; id: string | null; retry: number | null }

export class SseParser {
  private buf = ''
  private data: string[] = []
  private event = ''
  private id: string | null = null
  private retry: number | null = null
  lastEventId: string | null = null

  /** Feeds a chunk; returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buf += chunk
    const out: SseEvent[] = []
    let nl: number
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1))
      if (line === '') {
        if (this.data.length) {
          out.push({ event: this.event || 'message', data: this.data.join('\n'), id: this.id, retry: this.retry })
          if (this.id !== null) this.lastEventId = this.id
        }
        this.data = []; this.event = ''; this.retry = null
        continue
      }
      if (line.startsWith(':')) continue // comment / keep-alive
      const i = line.indexOf(':')
      const field = i >= 0 ? line.slice(0, i) : line
      let value = i >= 0 ? line.slice(i + 1) : ''
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') this.data.push(value)
      else if (field === 'event') this.event = value
      else if (field === 'id' && !value.includes('\0')) this.id = value
      else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value)
    }
    return out
  }
}
