import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Station } from '../api/types'
import { useLibrary } from './library'

// Runs before the store module initializes, so its persist storage resolves instead of warning.
vi.hoisted(() => {
  const store = new Map<string, string>()
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    },
  })
})

const st = (id: string): Station => ({ id, name: id }) as unknown as Station

const ids = (list: Station[]) => list.map((s) => s.id)

beforeEach(() => {
  useLibrary.setState({
    favorites: [st('a'), st('b'), st('c')],
    recent: [st('r1'), st('r2'), st('r3')],
  })
})

describe('undoable removals', () => {
  it('puts a removed favorite back at its previous index', () => {
    useLibrary.getState().removeFavorite('b')
    expect(ids(useLibrary.getState().favorites)).toEqual(['a', 'c'])

    useLibrary.getState().insertFavorite(st('b'), 1)
    expect(ids(useLibrary.getState().favorites)).toEqual(['a', 'b', 'c'])
  })

  it('never doubles a favorite that is already saved', () => {
    useLibrary.getState().insertFavorite(st('a'), 2)
    expect(ids(useLibrary.getState().favorites)).toEqual(['a', 'b', 'c'])
  })

  it('puts a removed recent entry back at its previous index', () => {
    useLibrary.getState().removeRecent('r2')
    expect(ids(useLibrary.getState().recent)).toEqual(['r1', 'r3'])

    useLibrary.getState().insertRecent(st('r2'), 1)
    expect(ids(useLibrary.getState().recent)).toEqual(['r1', 'r2', 'r3'])
  })

  it('restores the whole recent list after clearing it', () => {
    const before = useLibrary.getState().recent
    useLibrary.getState().clearRecent()
    expect(useLibrary.getState().recent).toEqual([])

    useLibrary.getState().restoreRecent(before)
    expect(ids(useLibrary.getState().recent)).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('refresh', () => {
  it('re-points entries absorbed by a merge and dedupes them', () => {
    useLibrary.setState({
      favorites: [st('old1'), st('canon'), st('old2')],
      recent: [st('old2')],
      lastStationId: 'old2',
    })
    // The batch API answers each requested id, so the surviving station can
    // appear once per absorbed id, each carrying that id in aliasOf.
    const fresh = [
      { ...st('canon'), aliasOf: 'old1' },
      { ...st('canon'), aliasOf: 'old2' },
      st('canon'),
    ] as Station[]
    useLibrary.getState().refresh(fresh, ['old1', 'canon', 'old2'])

    expect(ids(useLibrary.getState().favorites)).toEqual(['canon'])
    expect(ids(useLibrary.getState().recent)).toEqual(['canon'])
    expect(useLibrary.getState().lastStationId).toBe('canon')
  })

  it('marks requested ids the server dropped as offline', () => {
    useLibrary.setState({ favorites: [st('gone'), st('kept')], recent: [], lastStationId: null })
    useLibrary.getState().refresh([st('kept')], ['gone', 'kept'])

    const [gone, kept] = useLibrary.getState().favorites
    expect(gone?.offline).toBe(true)
    expect(kept?.offline).toBeUndefined()
  })
})