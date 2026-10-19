import { describe, expect, it } from 'vitest'
import { formatFreq, nearestSlot, noiseLevel, ratioToFreq, freqToRatio, seek, slotAt, snapTarget } from './dial'

const slots = [{ freq: 88.1 }, { freq: 94.7 }, { freq: 102.7 }, { freq: 106.7 }]

describe('dial math', () => {
  it('finds the nearest slot', () => {
    expect(nearestSlot(slots, 95)?.slot.freq).toBe(94.7)
    expect(nearestSlot(slots, 87.5)?.slot.freq).toBe(88.1)
    expect(nearestSlot(slots, 108)?.slot.freq).toBe(106.7)
    expect(nearestSlot([], 100)).toBeNull()
  })

  it('snaps only within the radius', () => {
    expect(snapTarget(slots, 102.6)).toBe(102.7)
    expect(snapTarget(slots, 102.83)).toBe(102.7)
    expect(snapTarget(slots, 100.04)).toBe(100)
    expect(snapTarget(slots, 120)).toBe(108)
  })

  it('seeks with wrap-around', () => {
    expect(seek(slots, 94.7, 1)?.freq).toBe(102.7)
    expect(seek(slots, 94.7, -1)?.freq).toBe(88.1)
    expect(seek(slots, 106.7, 1)?.freq).toBe(88.1)
    expect(seek(slots, 88.1, -1)?.freq).toBe(106.7)
    expect(seek(slots, 90, 1)?.freq).toBe(94.7)
    expect(seek([], 90, 1)).toBeUndefined()
  })

  it('matches slots exactly', () => {
    expect(slotAt(slots, 94.7)?.freq).toBe(94.7)
    expect(slotAt(slots, 94.8)).toBeUndefined()
  })

  it('maps ratio and frequency both ways', () => {
    expect(freqToRatio(87.5)).toBe(0)
    expect(freqToRatio(108)).toBe(1)
    expect(ratioToFreq(0.5)).toBeCloseTo(97.75)
    expect(freqToRatio(200)).toBe(1)
  })

  it('ramps noise between stations', () => {
    expect(noiseLevel(0)).toBe(0)
    expect(noiseLevel(1)).toBe(1)
    expect(noiseLevel(Infinity)).toBe(1)
    expect(noiseLevel(0.1)).toBeGreaterThan(0)
    expect(noiseLevel(0.1)).toBeLessThan(1)
  })

  it('formats frequencies', () => {
    expect(formatFreq(98.1)).toBe('98.1')
    expect(formatFreq(98.1, true)).toBe('!98.1')
    expect(formatFreq(103.66)).toBe('103.7')
  })
})
