import { describe, expect, it } from 'vitest'
import { stationQuery } from './stationQuery'
import { migrateLibrary, resolvedTheme } from './appearance'

describe('station search requests', () => {
  it('sends partial and misspelled names to the complete US catalog when no state is selected', () => {
    for (const term of ['kex', 'k exp', 'kxep']) {
      expect(stationQuery('US', '', 'popular', term)).toEqual({
        country: 'US', region: undefined, q: term, sort: 'popular',
      })
    }
  })
  it('only searches globally when explicitly expanded', () => {
    expect(stationQuery('CN', 'beijing', 'popular', 'KEXP', 'all')).toEqual({ q: 'KEXP', sort: 'popular' })
  })
  it('defaults to the selected province, or the current country when no province is selected', () => {
    expect(stationQuery('CN', '', 'popular', '音乐')).toEqual({
      q: '音乐',
      country: 'CN',
      region: undefined,
      sort: 'popular',
    })
    expect(stationQuery('CN', 'beijing', 'freq', '音乐')).toEqual({ q: '音乐', country: 'CN', region: 'beijing', sort: 'freq' })
    expect(stationQuery('US', 'california', 'popular', 'jazz', 'current')).toEqual({
      q: 'jazz',
      country: 'US',
      region: 'california',
      sort: 'popular',
    })
  })
  it('queries compact FM frequencies without an extra text condition', () => {
    expect(stationQuery('CN', 'beijing', 'popular', 'fm974')).toEqual({
      country: 'CN',
      region: 'beijing',
      freq: 97.4,
      sort: 'popular',
    })
  })
  it('returns to the browsing region immediately when the search is empty', () => {
    expect(stationQuery('CN', 'beijing', 'popular', ' ', 'all')).toEqual({ country: 'CN', region: 'beijing', sort: 'popular' })
  })
})

describe('appearance migration', () => {
  it('switches legacy themes to Default light and moves presets into favorites', () => {
    const saved = {
      theme: 'braun',
      favorites: [{ id: 'favorite' }],
      presets: [null, { id: 'preset' }],
      recent: [{ id: 'recent' }],
      lang: 'zh',
      volume: 0.3,
      lastStationId: 'recent',
    }
    const { presets: _presets, ...remaining } = saved
    expect(migrateLibrary(saved, 1)).toEqual({
      ...remaining,
      theme: 'apple',
      colorMode: 'light',
      favorites: [{ id: 'favorite' }, { id: 'preset' }],
    })
  })
  it('preserves current appearance choices and merges presets once without duplicating favorites', () => {
    const saved = {
      theme: 'hifi',
      colorMode: 'system',
      favorites: [{ id: 'favorite', name: 'Updated name' }],
      presets: [null, { id: 'favorite', name: 'Old name' }, { id: 'preset' }, { id: 'preset' }],
      recent: [{ id: 'recent' }],
      volume: 0.3,
    }
    const migrated = migrateLibrary(saved, 2)
    expect(migrated).toEqual({
      theme: 'hifi',
      colorMode: 'system',
      favorites: [{ id: 'favorite', name: 'Updated name' }, { id: 'preset' }],
      recent: saved.recent,
      volume: 0.3,
    })
    expect(migrateLibrary(migrated, 3)).toEqual(migrated)
    expect(migrateLibrary({ theme: 'apple', colorMode: 'dark' }, 2)).toMatchObject({ theme: 'apple', colorMode: 'dark' })
  })
  it('falls back from the retired theme while retaining color preference', () => {
    expect(migrateLibrary({ theme: 'braun', colorMode: 'dark' }, 2)).toMatchObject({ theme: 'apple', colorMode: 'dark' })
  })
  it('only follows system colors when requested, leaving classic themes intact', () => {
    expect(resolvedTheme('apple', 'light', true)).toBe('apple')
    expect(resolvedTheme('apple', 'system', true)).toBe('apple-dark')
    expect(resolvedTheme('apple', 'system', false)).toBe('apple')
    expect(resolvedTheme('hifi', 'dark', true)).toBe('hifi')
  })
})
