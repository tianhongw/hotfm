/**
 * Minimal ID3v2 reader for HLS timed metadata: hls.js parses the tags but does
 * not expose TIT2/TPE1 text, so radio titles need decoding here.
 *
 * Only v2.3/v2.4 text frames TIT2 (title) and TPE1 (artist) are read; the
 * global unsynchronisation flag is ignored (rare in HLS samples, and it only
 * affects media tags, not text).
 */

// Byte access is bounds-checked by the parse loops; `?? 0` keeps the reads
// well-defined under noUncheckedIndexedAccess without scattering assertions.
function syncsafe(b: Uint8Array, o: number): number {
  return (
    (((b[o] ?? 0) & 0x7f) << 21) |
    (((b[o + 1] ?? 0) & 0x7f) << 14) |
    (((b[o + 2] ?? 0) & 0x7f) << 7) |
    ((b[o + 3] ?? 0) & 0x7f)
  )
}

function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)
}

function latin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0)
  return s
}

function utf16(b: Uint8Array, bomAware: boolean): string {
  let off = 0
  let le = false
  if (bomAware) {
    le = true
    if (b[0] === 0xff && b[1] === 0xfe) {
      off = 2
    } else if (b[0] === 0xfe && b[1] === 0xff) {
      le = false
      off = 2
    }
  }
  let s = ''
  for (let i = off; i + 1 < b.length; i += 2) {
    const lo = b[i] ?? 0
    const hi = b[i + 1] ?? 0
    s += String.fromCharCode(le ? lo | (hi << 8) : (lo << 8) | hi)
  }
  return s
}

/** Decodes one text frame body (encoding byte + text); empty when unusable. */
function decodeText(body: Uint8Array): string {
  if (body.length === 0) return ''
  const enc = body[0]
  const b = body.subarray(1)
  let s: string
  switch (enc) {
    case 0:
      s = latin1(b)
      break
    case 1:
      s = utf16(b, true)
      break
    case 2:
      s = utf16(b, false)
      break
    case 3:
      s = new TextDecoder('utf-8').decode(b)
      break
    default:
      return ''
  }
  return s.replace(/^\uFEFF/, '').replace(/\u0000+$/, '').trim()
}

/**
 * Extracts "Artist - Title" (or whichever part exists) from a buffer holding
 * one or more concatenated ID3v2 tags, as hls.js delivers them.
 */
export function parseId3Title(data: Uint8Array): string | null {
  let title = ''
  let artist = ''
  let o = 0
  while (o + 10 <= data.length && data[o] === 0x49 && data[o + 1] === 0x44 && data[o + 2] === 0x33) {
    const version = data[o + 3] ?? 0
    if (version !== 3 && version !== 4) break // v2.2 and unknown versions: stop
    const flags = data[o + 5] ?? 0
    const size = syncsafe(data, o + 6)
    const tagEnd = Math.min(o + 10 + size, data.length)
    for (let p = o + 10; p + 10 <= tagEnd; ) {
      const id = String.fromCharCode(data[p] ?? 0, data[p + 1] ?? 0, data[p + 2] ?? 0, data[p + 3] ?? 0)
      if (id === '\u0000\u0000\u0000\u0000') break // padding
      const frameSize = version === 4 ? syncsafe(data, p + 4) : u32be(data, p + 4)
      if (frameSize === 0) break
      if (p + 10 + frameSize > tagEnd) break // truncated frame: stop, do not guess
      if (id === 'TIT2' || id === 'TPE1') {
        const v = decodeText(data.subarray(p + 10, p + 10 + frameSize))
        if (v) {
          if (id === 'TIT2') title = v
          else artist = v
        }
      }
      p += 10 + frameSize
    }
    // A v2.4 footer sits after the tag body and is not counted in the size.
    o = version === 4 && (flags & 0x10) !== 0 ? tagEnd + 10 : tagEnd
  }
  if (artist && title) return `${artist} - ${title}`
  return title || artist || null
}

/** Returns the new title, or null when it did not change. An empty string clears it. */
export function nextTitle(prev: string, raw: string): string | null {
  const t = raw.trim()
  return t === prev ? null : t
}