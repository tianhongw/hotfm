// Pure tuning-dial math, shared by the dial UI, seek buttons and keyboard shortcuts.

export const FM_MIN = 87.5
export const FM_MAX = 108.0
export const FM_SPAN = FM_MAX - FM_MIN
export const STEP = 0.1
/** Within this distance (MHz) a released dial snaps onto a station. */
export const SNAP_RADIUS = 0.15

export interface Slot {
  freq: number
}

export const roundFreq = (f: number) => Math.round(f * 10) / 10
export const clampFreq = (f: number) => Math.min(FM_MAX, Math.max(FM_MIN, f))
export const freqToRatio = (f: number) => (clampFreq(f) - FM_MIN) / FM_SPAN
export const ratioToFreq = (r: number) => clampFreq(FM_MIN + r * FM_SPAN)

/** Index of the first slot with freq >= f (slots sorted ascending). */
function lowerBound<T extends Slot>(slots: T[], f: number): number {
  let lo = 0
  let hi = slots.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (slots[mid]!.freq < f) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function nearestSlot<T extends Slot>(slots: T[], f: number): { slot: T; dist: number } | null {
  if (slots.length === 0) return null
  const i = lowerBound(slots, f)
  let best: T | undefined
  let dist = Infinity
  for (const j of [i - 1, i]) {
    const s = slots[j]
    if (s && Math.abs(s.freq - f) < dist) {
      best = s
      dist = Math.abs(s.freq - f)
    }
  }
  return best ? { slot: best, dist } : null
}

/** The slot exactly at f (after rounding), if any. */
export function slotAt<T extends Slot>(slots: T[], f: number): T | undefined {
  const n = nearestSlot(slots, f)
  return n && n.dist < 0.05 ? n.slot : undefined
}

/** Where a released dial should come to rest. */
export function snapTarget<T extends Slot>(slots: T[], f: number, radius = SNAP_RADIUS): number {
  const n = nearestSlot(slots, f)
  if (n && n.dist <= radius) return n.slot.freq
  return roundFreq(clampFreq(f))
}

/** Next station above (dir=1) or below (dir=-1) f, wrapping around the band like a real seek. */
export function seek<T extends Slot>(slots: T[], f: number, dir: 1 | -1): T | undefined {
  if (slots.length === 0) return undefined
  if (dir === 1) {
    const i = lowerBound(slots, f + 0.05)
    return slots[i] ?? slots[0]
  }
  const i = lowerBound(slots, f - 0.05) - 1
  return slots[i] ?? slots[slots.length - 1]
}

/** Static-noise level for a dial position: silent on a station, loud between stations. */
export function noiseLevel(distToStation: number): number {
  if (!Number.isFinite(distToStation)) return 1
  const t = Math.min(1, Math.max(0, (distToStation - 0.02) / 0.25))
  return t * t * (3 - 2 * t) // smoothstep
}

/** "103.7" / " 98.1" (leading blank keeps 7-segment digits aligned). */
export function formatFreq(f: number, pad = false): string {
  const s = roundFreq(f).toFixed(1)
  return pad ? s.padStart(5, '!') : s
}
