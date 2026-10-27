import { describe, expect, it } from 'vitest'
import { pollInterval, snapshot, syncedChanged, SYNC_POLL_MS, WAITING_POLL_MS } from './syncWatch'
import type { Country, CountryCode } from './types'

function country(code: CountryCode, syncedAt: string | null, syncing = false): Country {
  return { code, count: 0, syncing, syncedAt }
}

describe('pollInterval', () => {
  it('does not poll without countries', () => {
    expect(pollInterval(undefined)).toBe(false)
    expect(pollInterval([])).toBe(false)
  })

  it('waits slowly while a country has never synced', () => {
    expect(pollInterval([country('US', null), country('CN', '2026-01-01T00:00:00Z')])).toBe(WAITING_POLL_MS)
  })

  it('polls fast while a sync run is in flight', () => {
    expect(pollInterval([country('US', null, true), country('CN', '2026-01-01T00:00:00Z')])).toBe(SYNC_POLL_MS)
    expect(pollInterval([country('US', '2026-01-01T00:00:00Z'), country('CN', null, true)])).toBe(SYNC_POLL_MS)
  })

  it('stops once every country has synced', () => {
    expect(pollInterval([country('US', '2026-01-01T00:00:00Z'), country('CN', '2026-01-01T00:00:00Z')])).toBe(false)
  })
})

describe('syncedChanged', () => {
  it('reports a country that finished its first sync', () => {
    expect(syncedChanged({ US: null }, [country('US', '2026-01-01T00:00:00Z')])).toEqual(['US'])
  })

  it('reports nothing when nothing changed', () => {
    expect(syncedChanged({ US: '2026-01-01T00:00:00Z' }, [country('US', '2026-01-01T00:00:00Z')])).toEqual([])
  })

  it('ignores codes missing from the previous snapshot', () => {
    expect(syncedChanged({}, [country('US', '2026-01-01T00:00:00Z')])).toEqual([])
  })

  it('reports a syncedAt that disappeared', () => {
    expect(syncedChanged({ US: '2026-01-01T00:00:00Z' }, [country('US', null)])).toEqual(['US'])
  })
})

describe('snapshot', () => {
  it('records syncedAt per country', () => {
    expect(snapshot([country('US', null), country('CN', '2026-01-01T00:00:00Z')])).toEqual({
      US: null,
      CN: '2026-01-01T00:00:00Z',
    })
  })
})