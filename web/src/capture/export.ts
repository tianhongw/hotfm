// Transcript / recording export formats. Pure except for `saveFile`.
import { strToU8, zipSync } from 'fflate'

export type Segment =
  | { kind: 'text'; id: number; at: number; dur: number; text: string }
  /** Marks where the listener tuned to another station. */
  | { kind: 'station'; id: number; at: number; name: string }

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Local wall-clock time, HH:MM:SS. */
export function clock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Elapsed time, M:SS or H:MM:SS. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms))
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`
}

function dateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function inRange(segments: Segment[], from: number, to: number): Segment[] {
  return segments.filter((s) => s.at + (s.kind === 'text' ? s.dur : 0) > from && s.at < to)
}

export function toTxt(segments: Segment[], title: string, from: number, to: number): string {
  const lines = [`HotFM — ${title}`, `${dateTime(from)} – ${dateTime(to).slice(11)}`, 'Transcribed automatically on this device; may contain errors.', '']
  for (const s of segments) lines.push(s.kind === 'text' ? `[${clock(s.at)}] ${s.text}` : `\n— ${s.name} —\n`)
  return lines.join('\n') + '\n'
}

/** SubRip cues relative to `start`, so they line up with a recording that began then. */
export function toSrt(segments: Segment[], start: number, end = Infinity): string {
  const cues: string[] = []
  const texts = segments.filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
  texts.forEach((s, i) => {
    const next = texts[i + 1]
    const from = Math.max(s.at, start) - start
    const to = Math.min(s.at + s.dur, next ? next.at : Infinity, end) - start
    if (to <= from) return
    cues.push(`${cues.length + 1}\n${srtTime(from)} --> ${srtTime(to)}\n${s.text}\n`)
  })
  return cues.join('\n')
}

export function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 40) || 'station'
  )
}

export function fileBase(name: string, at: number): string {
  const d = new Date(at)
  return `hotfm-${slug(name)}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** Audio + transcript in one archive. Stored, not deflated: the audio is already compressed. */
export function buildZip(audio: Uint8Array, ext: string, txt: string, srt: string): Uint8Array {
  return zipSync(
    {
      [`audio.${ext}`]: audio,
      'transcript.txt': strToU8(txt),
      'transcript.srt': strToU8(srt),
    },
    { level: 0 },
  )
}

export function saveFile(data: Blob, name: string) {
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
