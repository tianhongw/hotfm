import { describe, expect, it } from 'vitest'
import { nextTitle, parseId3Title } from './titles'

function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
}

function latin1Bytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0))
}

/** UTF-16LE with an optional BOM, as ID3v2 encoding 1 uses. */
function utf16leBytes(s: string, bom = true): number[] {
  const bytes = bom ? [0xff, 0xfe] : []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    bytes.push(c & 0xff, c >> 8)
  }
  return bytes
}

/** UTF-16BE, optionally prefixed with a BOM. */
function utf16beBytes(s: string, bom = false): number[] {
  const bytes = bom ? [0xfe, 0xff] : []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    bytes.push(c >> 8, c & 0xff)
  }
  return bytes
}

function frame(id: string, text: number[], enc: number, version: 3 | 4): number[] {
  const body = [enc, ...text]
  const size =
    version === 4
      ? syncsafe(body.length)
      : [0, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]
  return [...latin1Bytes(id), ...size, 0, 0, ...body]
}

function tag(frames: number[][], version: 3 | 4): Uint8Array {
  const body = frames.flat()
  return new Uint8Array([0x49, 0x44, 0x33, version, 0, 0, ...syncsafe(body.length), ...body])
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s))

function daftPunkTag(): Uint8Array {
  return tag(
    [
      frame('TPE1', utf8('Daft Punk'), 3, 4),
      frame('TIT2', utf8('One More Time'), 3, 4),
    ],
    4,
  )
}

describe('parseId3Title', () => {
  it('combines artist and title from v2.4 UTF-8 frames', () => {
    expect(parseId3Title(daftPunkTag())).toBe('Daft Punk - One More Time')
  })

  it('returns a lone title', () => {
    expect(parseId3Title(tag([frame('TIT2', utf8('One More Time'), 3, 4)], 4))).toBe('One More Time')
  })

  it('returns a lone artist', () => {
    expect(parseId3Title(tag([frame('TPE1', utf8('Daft Punk'), 3, 4)], 4))).toBe('Daft Punk')
  })

  it('decodes Latin-1 (encoding 0)', () => {
    expect(parseId3Title(tag([frame('TIT2', latin1Bytes('Beyonc\xe9 - Halo'), 0, 4)], 4))).toBe('Beyoncé - Halo')
  })

  it('decodes UTF-16 with a BOM (encoding 1)', () => {
    const got = parseId3Title(tag([frame('TIT2', utf16leBytes('周杰伦 - 晴天'), 1, 4)], 4))
    expect(got).toBe('周杰伦 - 晴天')
  })

  it('decodes UTF-16BE (encoding 2)', () => {
    expect(parseId3Title(tag([frame('TIT2', utf16beBytes('A - B'), 2, 4)], 4))).toBe('A - B')
  })

  it('decodes UTF-16 with a big-endian BOM (encoding 1)', () => {
    expect(parseId3Title(tag([frame('TIT2', utf16beBytes('C - D', true), 1, 4)], 4))).toBe('C - D')
  })

  it('uses the plain big-endian frame size for v2.3', () => {
    const text = 'x'.repeat(129) // frame body is 130 bytes => 0x82, not syncsafe
    const got = parseId3Title(tag([frame('TIT2', latin1Bytes(text), 0, 3)], 3))
    expect(got).toBe(text)
  })

  it('lets the last value across concatenated tags win', () => {
    const oldTag = tag([frame('TIT2', utf8('Old'), 3, 4)], 4)
    const newTag = tag([frame('TIT2', utf8('New'), 3, 4)], 4)
    const both = new Uint8Array([...oldTag, ...newTag])
    expect(parseId3Title(both)).toBe('New')
  })

  it('ignores non-text frames', () => {
    expect(parseId3Title(tag([frame('TXXX', utf8('ignored'), 3, 4)], 4))).toBeNull()
  })

  it('returns null for a header-only tag', () => {
    expect(parseId3Title(tag([], 4))).toBeNull()
  })

  it('returns null for data that is not ID3', () => {
    expect(parseId3Title(new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull()
  })

  it('returns null for a truncated frame without throwing', () => {
    const full = tag([frame('TIT2', utf8('One More Time'), 3, 4)], 4)
    expect(() => parseId3Title(full.subarray(0, full.length - 5))).not.toThrow()
    expect(parseId3Title(full.subarray(0, full.length - 5))).toBeNull()
  })

  it('parses a tag inside a larger sample unchanged', () => {
    const inner = daftPunkTag()
    const big = new Uint8Array(4 + inner.length + 2)
    big.set(inner, 4)
    expect(parseId3Title(big.subarray(4, 4 + inner.length))).toBe('Daft Punk - One More Time')
  })
})

describe('nextTitle', () => {
  it('drops unchanged titles after trimming', () => {
    expect(nextTitle('a', ' a ')).toBeNull()
  })

  it('returns a changed title', () => {
    expect(nextTitle('a', 'b')).toBe('b')
  })

  it('treats an empty title as a change (clears it)', () => {
    expect(nextTitle('a', '')).toBe('')
  })
})