// Pure audio helpers for captions: no DOM, unit-tested.

export function rms(pcm: Float32Array, from = 0, to = pcm.length): number {
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += pcm[i]! * pcm[i]!
  return Math.sqrt(sum / (to - from))
}

/** Linear resampling; good enough for speech going into Whisper (16 kHz). */
export function resample(pcm: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return pcm
  const n = Math.floor((pcm.length * to) / from)
  const out = new Float32Array(n)
  const step = from / to
  for (let i = 0; i < n; i++) {
    const x = i * step
    const j = Math.floor(x)
    const a = pcm[j] ?? 0
    const b = pcm[j + 1] ?? a
    out[i] = a + (b - a) * (x - j)
  }
  return out
}

export interface Chunk {
  pcm: Float32Array
  /** Audio-clock frame of the first sample. */
  frame: number
}

/** Absolute floor: below this a window is silence whatever the speech level. */
const SILENT_RMS = 0.004

/**
 * Splits a continuous PCM stream into utterances for Whisper. A chunk is cut
 * as soon as a short pause follows enough speech, so captions don't wait for
 * a fixed-length window; with no pause it is cut at the quietest point before
 * `maxSec`. Leading silence is dropped.
 */
export class Chunker {
  private buf: Float32Array
  private len = 0
  private frame = -1
  /** Samples of `buf` already classified as quiet or voiced. */
  private scanned = 0
  /** Consecutive quiet samples ending at `scanned`. */
  private quiet = 0
  /** Voiced samples in the current chunk. */
  private voiced = 0
  /** Running speech level; a pause is relative to it, since radio rarely goes fully silent. */
  private level = 0
  private readonly win: number
  private readonly minVoiced: number
  private readonly pause: number
  private readonly max: number
  private readonly fallbackMin: number

  constructor(
    readonly rate: number,
    { minSpeechSec = 1.5, pauseSec = 0.3, maxSec = 10, fallbackMinSec = 3, winSec = 0.05 } = {},
  ) {
    this.win = Math.max(1, Math.round(winSec * rate))
    this.minVoiced = Math.round(minSpeechSec * rate)
    this.pause = Math.round(pauseSec * rate)
    this.max = Math.round(maxSec * rate)
    this.fallbackMin = Math.round(fallbackMinSec * rate)
    this.buf = new Float32Array(this.max * 2)
  }

  push(pcm: Float32Array, frame: number): Chunk[] {
    // A gap in the clock (tap re-attached, dropped frames) starts a fresh chunk.
    const out: Chunk[] = []
    if (this.len > 0 && frame !== this.frame + this.len) {
      const rest = this.flush()
      if (rest) out.push(rest)
    }
    if (this.len === 0) this.frame = frame
    let off = 0
    while (off < pcm.length) {
      const n = Math.min(pcm.length - off, this.buf.length - this.len)
      this.buf.set(pcm.subarray(off, off + n), this.len)
      this.len += n
      off += n
      this.scan(out)
    }
    return out
  }

  /** The utterance still being collected (for interim captions), or null if it holds no speech yet. */
  peek(): Chunk | null {
    if (this.voiced === 0) return null
    return { pcm: this.buf.slice(0, this.len), frame: this.frame }
  }

  /** Seconds of speech in the utterance being collected. */
  get speechSec(): number {
    return this.voiced / this.rate
  }

  /** Returns whatever is buffered (if it holds speech) and resets. */
  flush(): Chunk | null {
    const chunk = this.voiced > 0 ? this.take(this.len) : null
    this.len = 0
    this.scanned = 0
    this.quiet = 0
    this.voiced = 0
    return chunk
  }

  private scan(out: Chunk[]) {
    while (this.scanned + this.win <= this.len) {
      const r = rms(this.buf, this.scanned, this.scanned + this.win)
      if (r < Math.max(SILENT_RMS, this.level * 0.3)) {
        this.quiet += this.win
      } else {
        this.quiet = 0
        this.voiced += this.win
        this.level = this.level ? this.level * 0.95 + r * 0.05 : r
      }
      this.scanned += this.win
      if (this.voiced === 0 && this.quiet >= this.pause) {
        this.take(this.scanned - Math.floor(this.pause / 2)) // leading silence: drop it
      } else if (this.quiet >= this.pause && this.voiced >= this.minVoiced) {
        out.push(this.take(this.scanned - Math.floor(this.quiet / 2)))
      } else if (this.scanned >= this.max) {
        out.push(this.take(this.cutPoint()))
      }
    }
  }

  private cutPoint(): number {
    let best = this.max
    let bestRms = Infinity
    for (let start = this.fallbackMin; start + this.win <= this.max; start += this.win) {
      const r = rms(this.buf, start, start + this.win)
      if (r < bestRms) {
        bestRms = r
        best = start + Math.floor(this.win / 2)
      }
    }
    return best
  }

  private take(n: number): Chunk {
    const chunk = { pcm: this.buf.slice(0, n), frame: this.frame }
    this.buf.copyWithin(0, n, this.len)
    this.len -= n
    this.frame += n
    this.scanned = Math.max(0, this.scanned - n)
    this.quiet = Math.min(this.quiet, this.scanned)
    this.voiced = this.scanned - this.quiet
    return chunk
  }
}

const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+|♫+/g
// Whisper's classic hallucinations on music, jingles and silence.
const HALLUCINATIONS = new Set(['you', 'thank you', 'thanks for watching', 'thank you for watching', 'bye', 'okay'])

/** Cleans one Whisper result; returns '' when it should not be shown. */
export function cleanText(text: string, previous = ''): string {
  const t = text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim()
  if (!/[\p{L}\p{N}]/u.test(t)) return ''
  const key = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()
  if (HALLUCINATIONS.has(key)) return ''
  if (key === previous.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim()) return ''
  return t
}
