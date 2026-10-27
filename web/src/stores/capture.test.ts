import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useCapture as UseCapture } from './capture'

let useCapture: typeof UseCapture

beforeAll(async () => {
  const saved = new Map<string, string>()
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  }
  vi.stubGlobal('window', { localStorage: storage })
  // The store reads window.localStorage while it is created, so the stub must land first.
  useCapture = (await import('./capture')).useCapture
})

beforeEach(() => {
  useCapture.setState({ segments: [], dirty: false, captionsOn: true })
})

const t0 = new Date(2026, 9, 23, 14, 3, 12).getTime()

describe('transcript store', () => {
  it('marks the transcript dirty when a line is added', () => {
    useCapture.getState().addText(t0, 4000, 'And the council voted.')
    const { segments, dirty } = useCapture.getState()
    expect(dirty).toBe(true)
    expect(segments).toEqual([{ kind: 'text', id: expect.any(Number), at: t0, dur: 4000, text: 'And the council voted.' }])
  })

  it('merges nearby gaps and starts a new one after a long silence', () => {
    useCapture.getState().addGap(t0, 1000, 1)
    useCapture.getState().addGap(t0 + 3000, 1000, 1)
    let gaps = useCapture.getState().segments
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ kind: 'gap', at: t0, dur: 4000, count: 2 })

    useCapture.getState().addGap(t0 + 20_000, 2000, 3)
    gaps = useCapture.getState().segments
    expect(gaps).toHaveLength(2)
    expect(gaps[1]).toMatchObject({ kind: 'gap', at: t0 + 20_000, dur: 2000, count: 3 })
    expect(useCapture.getState().dirty).toBe(true)
  })

  it('inserts a gap before a line transcribed later but spoken after it', () => {
    useCapture.getState().addGap(t0 - 5000, 1000, 1)
    useCapture.getState().addText(t0, 4000, 'Good morning.')
    expect(useCapture.getState().segments.map((s) => s.kind)).toEqual(['gap', 'text'])
  })

  it('clears the transcript and its dirty flag; saving clears the flag too', () => {
    useCapture.getState().addText(t0, 4000, 'And the council voted.')
    useCapture.getState().set({ dirty: false })
    expect(useCapture.getState().dirty).toBe(false)
    useCapture.getState().addText(t0 + 5000, 3000, 'Officials said.')
    useCapture.getState().clear()
    expect(useCapture.getState()).toMatchObject({ segments: [], dirty: false })
  })
})