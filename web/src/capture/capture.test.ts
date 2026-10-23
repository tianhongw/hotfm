import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Chunker, cleanText, resample, rms } from './dsp'
import {
  buildZip,
  cueAt,
  elapsed,
  fileBase,
  inRange,
  parseFileBase,
  parseSrt,
  parseTxtHeader,
  readExport,
  slug,
  toSrt,
  toTxt,
  type Segment,
} from './export'

const tone = (n: number, amp: number) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 3))

describe('dsp', () => {
  it('measures loudness', () => {
    expect(rms(new Float32Array(100))).toBe(0)
    expect(rms(Float32Array.from({ length: 100 }, () => 0.5))).toBeCloseTo(0.5)
  })

  it('resamples to the target rate', () => {
    const out = resample(Float32Array.from({ length: 48_000 }, (_, i) => i / 48_000), 48_000, 16_000)
    expect(out.length).toBe(16_000)
    expect(out[8000]).toBeCloseTo(0.5, 3)
    const same = new Float32Array(10)
    expect(resample(same, 16_000, 16_000)).toBe(same)
  })

  // 100 Hz "audio" keeps the arithmetic readable: 1 sample = 10 ms, windows are 5 samples.
  const rate = 100
  const speech = (sec: number) => tone(sec * rate, 0.5)
  const silence = (sec: number) => new Float32Array(sec * rate)
  const concat = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  it('cuts at the first pause after enough speech', () => {
    const c = new Chunker(rate)
    const chunks = c.push(concat(speech(2), silence(0.5), speech(1)), 0)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.frame).toBe(0)
    // Cut in the middle of the 0.3 s needed to call it a pause.
    expect(chunks[0]!.pcm.length).toBe(215)
    // The rest of the pause is dropped as leading silence of the next utterance.
    expect(c.peek()!.frame).toBe(230)
  })

  it('does not cut on a pause before enough speech', () => {
    const c = new Chunker(rate)
    expect(c.push(concat(speech(1), silence(0.5), speech(0.5)), 0)).toHaveLength(0)
    expect(c.speechSec).toBeCloseTo(1.5)
    const out = c.push(silence(0.5), 200)
    expect(out).toHaveLength(1)
    expect(out[0]!.frame).toBe(0)
  })

  it('drops leading silence', () => {
    const c = new Chunker(rate)
    expect(c.push(silence(3), 0)).toHaveLength(0)
    expect(c.peek()).toBeNull()
    const out = c.push(concat(speech(2), silence(0.5)), 300)
    expect(out).toHaveLength(1)
    // Starts just before the speech, not 3 s earlier.
    expect(out[0]!.frame).toBeGreaterThan(280)
    expect(out[0]!.frame).toBeLessThanOrEqual(300)
  })

  it('falls back to the quietest point when nobody pauses', () => {
    const c = new Chunker(rate)
    // A dip that is quieter than the rest but not a full pause.
    const pcm = speech(12)
    for (let i = 700; i < 720; i++) pcm[i]! *= 0.5
    const chunks = c.push(pcm, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.frame).toBe(1000)
    expect(chunks[0]!.pcm.length).toBeGreaterThanOrEqual(700)
    expect(chunks[0]!.pcm.length).toBeLessThanOrEqual(720)
    const rest = c.flush()
    expect(rest!.frame).toBe(1000 + chunks[0]!.pcm.length)
    expect(chunks[0]!.pcm.length + rest!.pcm.length).toBe(1200)
  })

  it('never exceeds the max length and keeps the clock across pushes', () => {
    const c = new Chunker(rate)
    const all = []
    for (let i = 0; i < 30; i++) all.push(...c.push(tone(128, 0.5), i * 128))
    let frame = 0
    for (const ch of all) {
      expect(ch.pcm.length).toBeLessThanOrEqual(10 * rate)
      expect(ch.frame).toBe(frame)
      frame += ch.pcm.length
    }
    expect(all.length).toBeGreaterThan(0)
  })

  it('starts over after a gap in the audio clock', () => {
    const c = new Chunker(rate)
    c.push(speech(1), 0)
    const out = c.push(speech(1), 5000)
    expect(out).toHaveLength(1)
    expect(out[0]!.frame).toBe(0)
    expect(c.flush()!.frame).toBe(5000)
  })

  it('drops non-speech and hallucinated output', () => {
    expect(cleanText(' [Music] ')).toBe('')
    expect(cleanText('♪ ♪')).toBe('')
    expect(cleanText('Thank you.')).toBe('')
    expect(cleanText('(applause) The council voted  7 to 2.')).toBe('The council voted 7 to 2.')
    expect(cleanText('Good morning.', 'good morning')).toBe('')
    expect(cleanText('Good morning, Boston.', 'Good morning.')).toBe('Good morning, Boston.')
  })
})

describe('export', () => {
  const t0 = new Date(2026, 9, 23, 14, 3, 12).getTime()
  const segs: Segment[] = [
    { kind: 'text', id: 1, at: t0, dur: 6000, text: 'And the council voted.' },
    { kind: 'text', id: 2, at: t0 + 8000, dur: 7000, text: 'Officials said.' },
    { kind: 'station', id: 3, at: t0 + 20_000, name: 'KQED 88.5' },
    { kind: 'text', id: 4, at: t0 + 21_000, dur: 5000, text: 'Good morning.' },
  ]

  it('writes a timestamped text transcript', () => {
    const txt = toTxt(segs, 'WNYC', t0, t0 + 30_000)
    expect(txt).toContain('HotFM — WNYC')
    expect(txt).toContain('2026-10-23 14:03 – 14:03')
    expect(txt).toContain('[14:03:12] And the council voted.')
    expect(txt).toContain('— KQED 88.5 —')
    expect(txt).toContain('[14:03:33] Good morning.')
  })

  it('writes SRT cues relative to the recording start', () => {
    const srt = toSrt(segs, t0 + 2000)
    expect(srt).toBe(
      [
        '1\n00:00:00,000 --> 00:00:04,000\nAnd the council voted.\n',
        '2\n00:00:06,000 --> 00:00:13,000\nOfficials said.\n',
        '3\n00:00:19,000 --> 00:00:24,000\nGood morning.\n',
      ].join('\n'),
    )
    // Cues are clipped at the end of the recording.
    expect(toSrt(segs, t0, t0 + 3000)).toBe('1\n00:00:00,000 --> 00:00:03,000\nAnd the council voted.\n')
  })

  it('selects segments overlapping a time range', () => {
    expect(inRange(segs, t0 + 7000, t0 + 20_500).map((s) => s.id)).toEqual([2, 3])
  })

  it('formats names and durations', () => {
    expect(slug('WNYC 93.9 FM — New York!')).toBe('wnyc-93-9-fm-new-york')
    expect(slug('***')).toBe('station')
    expect(fileBase('WNYC', t0)).toBe('hotfm-wnyc-20261023-1403')
    expect(elapsed(61_000)).toBe('1:01')
    expect(elapsed(3_723_000)).toBe('1:02:03')
  })

  it('bundles audio and transcripts in a zip', () => {
    const files = unzipSync(buildZip(new Uint8Array([1, 2, 3]), 'webm', 'txt', 'srt'))
    expect(Object.keys(files).sort()).toEqual(['audio.webm', 'transcript.srt', 'transcript.txt'])
    expect(Array.from(files['audio.webm']!)).toEqual([1, 2, 3])
    expect(strFromU8(files['transcript.txt']!)).toBe('txt')
  })
})

describe('import', () => {
  const start = new Date(2026, 9, 23, 14, 5, 30).getTime()
  const segs: Segment[] = [
    { kind: 'text', id: 1, at: start + 1_000, dur: 2_500, text: 'Good evening.' },
    { kind: 'text', id: 2, at: start + 4_000, dur: 3_000, text: 'Here is the news.' },
  ]

  it('reads back SubRip cues', () => {
    expect(parseSrt(toSrt(segs, start))).toEqual([
      { from: 1_000, to: 3_500, text: 'Good evening.' },
      { from: 4_000, to: 7_000, text: 'Here is the news.' },
    ])
    expect(parseSrt('\uFEFF1\r\n00:01:02.5 --> 00:01:04,000\r\nline one\r\nline two')).toEqual([
      { from: 62_500, to: 64_000, text: 'line one line two' },
    ])
    expect(parseSrt('')).toEqual([])
  })

  it('finds the cue playing at a time', () => {
    const cues = parseSrt(toSrt(segs, start))
    expect(cueAt(cues, 0)).toBe(-1)
    expect(cueAt(cues, 1_000)).toBe(0)
    expect(cueAt(cues, 3_800)).toBe(0) // the pause after a sentence keeps it current
    expect(cueAt(cues, 4_000)).toBe(1)
    expect(cueAt(cues, 99_000)).toBe(1)
    expect(cueAt([], 10)).toBe(-1)
  })

  it('reads the station and start back from the transcript and file name', () => {
    const minute = new Date(2026, 9, 23, 14, 5).getTime()
    expect(parseTxtHeader(toTxt(segs, 'BBC Radio 4', start, start + 60_000))).toEqual({ title: 'BBC Radio 4', startedAt: minute })
    expect(parseTxtHeader('hello\nworld')).toBeNull()
    expect(parseFileBase(`${fileBase('BBC Radio 4', start)}.zip`)).toEqual({ title: 'bbc radio 4', startedAt: minute })
    expect(parseFileBase('song.mp3')).toBeNull()
  })

  it('opens an exported zip', () => {
    const audio = new Uint8Array([1, 2, 3])
    const zip = buildZip(audio, 'webm', toTxt(segs, 'BBC Radio 4', start, start + 60_000), toSrt(segs, start))
    const got = readExport([{ name: `${fileBase('BBC Radio 4', start)}.zip`, data: zip }])!
    expect(got.title).toBe('BBC Radio 4')
    expect(got.cues).toHaveLength(2)
    expect(got.audio.type).toBe('audio/webm')
    expect(got.audio.size).toBe(3)
  })

  it('opens loose audio with its captions, or audio alone', () => {
    const srt = new TextEncoder().encode(toSrt(segs, start))
    const name = fileBase('KQED', start)
    const both = readExport([
      { name: `${name}.srt`, data: srt },
      { name: `${name}.m4a`, data: new Blob([new Uint8Array(4)]) },
    ])!
    expect(both.title).toBe('kqed')
    expect(both.audio.type).toBe('audio/mp4')
    expect(both.cues).toHaveLength(2)
    const alone = readExport([{ name: 'show.webm', data: new Blob([new Uint8Array(2)], { type: 'audio/webm' }) }])!
    expect(alone).toMatchObject({ title: 'show', startedAt: null, cues: [] })
    expect(readExport([{ name: 'x.srt', data: srt }])).toBeNull()
  })
})
