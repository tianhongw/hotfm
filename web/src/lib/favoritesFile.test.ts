import { describe, expect, it } from 'vitest'
import type { Station } from '../api/types'
import {
  FAVORITES_FORMAT,
  FAVORITES_VERSION,
  favoritesFileName,
  mergeFavorites,
  parseFavoritesFile,
  serializeFavoritesFile,
} from './favoritesFile'

const st = (id: string, name = id): Station =>
  ({
    id,
    name,
    country: 'US',
    region: { key: 'illinois', name: '伊利诺伊州', nameEn: 'Illinois' },
  }) as unknown as Station

describe('favorites export file', () => {
  it('round-trips saved stations and stamps the format, version and export time', () => {
    const now = new Date(2026, 2, 9, 18, 30)
    const favorites = [st('wbez', 'WBEZ'), st('kexp', 'KEXP')]
    const file = JSON.parse(serializeFavoritesFile(favorites, now)) as Record<string, unknown>
    expect(file).toMatchObject({
      format: FAVORITES_FORMAT,
      version: FAVORITES_VERSION,
      exportedAt: now.toISOString(),
    })
    expect(parseFavoritesFile(serializeFavoritesFile(favorites, now))).toEqual(favorites)
    expect(favoritesFileName(now)).toBe('hotfm-favorites-20260309.json')
  })

  it('rejects files that are not a version-1 HotFM favorites export', () => {
    expect(parseFavoritesFile('not json')).toBeNull()
    expect(parseFavoritesFile('[]')).toBeNull()
    expect(parseFavoritesFile(JSON.stringify({ format: 'other', version: 1, favorites: [] }))).toBeNull()
    expect(parseFavoritesFile(JSON.stringify({ format: FAVORITES_FORMAT, version: 2, favorites: [] }))).toBeNull()
    expect(parseFavoritesFile(JSON.stringify({ format: FAVORITES_FORMAT, version: 1, favorites: 'nope' }))).toBeNull()
  })

  it('drops malformed entries but keeps the valid ones', () => {
    const text = JSON.stringify({
      format: FAVORITES_FORMAT,
      version: 1,
      exportedAt: '2026-03-09T10:30:00.000Z',
      favorites: [
        st('wbez', 'WBEZ'),
        null,
        { id: 'no-name' },
        { name: 'no id', id: '' },
        // An id and a name are not enough: the list renders country and region.
        { id: 'partial', name: 'Partial' },
        { id: 'no-region', name: 'No region', country: 'US', region: {} },
        st('kexp', 'KEXP'),
        42,
      ],
    })
    expect(parseFavoritesFile(text)?.map((s) => s.id)).toEqual(['wbez', 'kexp'])
  })

  it('keeps the saved order and appends new ids in file order, skipping duplicates', () => {
    const existing = [st('wbez'), st('kexp')]
    const { favorites, added } = mergeFavorites(existing, [st('kexp'), st('wnyc'), st('wbez'), st('wnyc'), st('krlx')])
    expect(favorites.map((s) => s.id)).toEqual(['wbez', 'kexp', 'wnyc', 'krlx'])
    expect(added.map((s) => s.id)).toEqual(['wnyc', 'krlx'])
    expect(existing.map((s) => s.id)).toEqual(['wbez', 'kexp'])
  })

  it('adds nothing when every id is already saved or the file is empty', () => {
    expect(mergeFavorites([st('wbez')], [st('wbez')]).added).toEqual([])
    expect(mergeFavorites([], []).added).toEqual([])
  })
})