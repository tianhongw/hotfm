import { describe, expect, it } from 'vitest'
import { enqueue } from './queue'

type Item = { keep: boolean; tag: string }

describe('enqueue', () => {
  it('appends to an empty queue', () => {
    const { next, dropped } = enqueue<Item>([], { keep: false, tag: 'a' }, 3, 120)
    expect(next).toEqual([{ keep: false, tag: 'a' }])
    expect(dropped).toEqual([])
  })

  it('keeps only the newest live utterances', () => {
    const q: Item[] = ['a', 'b', 'c'].map((tag) => ({ keep: false, tag }))
    const { next, dropped } = enqueue(q, { keep: false, tag: 'd' }, 3, 120)
    expect(next.map((x) => x.tag)).toEqual(['b', 'c', 'd'])
    // Shedding live work is the normal back-pressure path, not a gap.
    expect(dropped).toEqual([])
  })

  it('never sheds a recording utterance for live back-pressure', () => {
    const q: Item[] = ['a', 'b', 'c'].map((tag) => ({ keep: false, tag }))
    const { next, dropped } = enqueue([{ keep: true, tag: 'k1' }, ...q], { keep: false, tag: 'd' }, 3, 120)
    expect(next.map((x) => x.tag)).toEqual(['k1', 'b', 'c', 'd'])
    expect(dropped).toEqual([])
  })

  it('reports kept utterances the hard cap pushes out, oldest first', () => {
    const q: Item[] = ['k1', 'k2', 'k3', 'k4'].map((tag) => ({ keep: true, tag }))
    const { next, dropped } = enqueue(q, { keep: true, tag: 'k5' }, 3, 4)
    expect(dropped.map((x) => x.tag)).toEqual(['k1'])
    expect(next.map((x) => x.tag)).toEqual(['k2', 'k3', 'k4', 'k5'])
  })

  it('never returns kept jobs when only live ones overflow', () => {
    const q: Item[] = ['a', 'b'].map((tag) => ({ keep: false, tag }))
    const { next, dropped } = enqueue([{ keep: true, tag: 'k1' }, ...q], { keep: false, tag: 'c' }, 1, 120)
    expect(dropped.filter((j) => j.keep)).toEqual([])
    expect(next.map((x) => x.tag)).toEqual(['k1', 'c'])
  })
})