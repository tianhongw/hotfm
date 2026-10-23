// Transcript / recording export formats, and reading them back for replay. Pure except for `saveFile`.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

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

/** Local date and time, YYYY-MM-DD HH:MM. */
export function dateTime(ms: number): string {
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

// --- import ---

/** A caption line of an imported recording, in ms from the start of its audio. */
export type Cue = { from: number; to: number; text: string }

const SRT_TIME = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/

const ms = (h: string, m: string, s: string, f: string) => ((+h * 60 + +m) * 60 + +s) * 1000 + +f.padEnd(3, '0')

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = []
  for (const block of text.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const i = lines.findIndex((l) => SRT_TIME.test(l))
    if (i < 0) continue
    const [, h1, m1, s1, f1, h2, m2, s2, f2] = SRT_TIME.exec(lines[i]!)!
    const body = lines
      .slice(i + 1)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
    if (body) cues.push({ from: ms(h1!, m1!, s1!, f1!), to: ms(h2!, m2!, s2!, f2!), text: body })
  }
  return cues.sort((a, b) => a.from - b.from)
}

/** Index of the cue playing at `t` (the last one started; it stays current through the pause after it), or -1. */
export function cueAt(cues: Cue[], t: number): number {
  let lo = 0
  let hi = cues.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid]!.from <= t) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

type Meta = { title: string; startedAt: number }

/** Station name and start (to the minute) from the first two lines `toTxt` writes. */
export function parseTxtHeader(text: string): Meta | null {
  const [first = '', second = ''] = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const title = /^HotFM — (.+)$/.exec(first.trim())?.[1]
  const d = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(second.trim())
  if (!title || !d) return null
  return { title, startedAt: new Date(+d[1]!, +d[2]! - 1, +d[3]!, +d[4]!, +d[5]!).getTime() }
}

/** Reads back a name made by `fileBase` (the station name comes back as its slug). */
export function parseFileBase(name: string): Meta | null {
  const m = /^hotfm-(.+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name)
  if (!m) return null
  return { title: m[1]!.replace(/-/g, ' '), startedAt: new Date(+m[2]!, +m[3]! - 1, +m[4]!, +m[5]!, +m[6]!).getTime() }
}

const AUDIO_TYPES: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}

const ext = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''

export const isAudioName = (name: string) => ext(name) in AUDIO_TYPES

export type ImportFile = { name: string; data: Uint8Array | Blob }

export type Imported = { audio: Blob; title: string; startedAt: number | null; cues: Cue[] }

/**
 * An exported zip, or loose files picked together (audio + optional .srt/.txt), back as
 * audio and caption cues. Null when there is no audio; throws on a damaged zip.
 */
export function readExport(files: ImportFile[]): Imported | null {
  const all: ImportFile[] = []
  for (const f of files) {
    if (ext(f.name) !== 'zip' || f.data instanceof Blob) {
      all.push(f)
      continue
    }
    const entries = unzipSync(f.data, { filter: (e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/') })
    for (const [name, data] of Object.entries(entries)) all.push({ name, data })
  }
  const audio = all.find((f) => f.data instanceof Blob || isAudioName(f.name))
  if (!audio) return null
  const text = (e: string) => {
    const f = all.find((x) => ext(x.name) === e && x.data instanceof Uint8Array)
    return f ? strFromU8(f.data as Uint8Array) : ''
  }
  const base = files.find((f) => ext(f.name) === 'zip') ?? audio
  const meta = parseTxtHeader(text('txt')) ?? parseFileBase(base.name)
  const type = AUDIO_TYPES[ext(audio.name)] ?? (audio.data instanceof Blob ? audio.data.type : '')
  return {
    audio: audio.data instanceof Blob && (audio.data.type || !type) ? audio.data : new Blob([audio.data], { type }),
    title: meta?.title ?? base.name.replace(/\.[^.]+$/, ''),
    startedAt: meta?.startedAt ?? null,
    cues: parseSrt(text('srt')),
  }
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
