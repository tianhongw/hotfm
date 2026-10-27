import type { Country } from './types'

/** Poll cadence while a catalog sync run is in flight. */
export const SYNC_POLL_MS = 5_000
/** Poll cadence while nothing runs but a country has never finished a sync. */
export const WAITING_POLL_MS = 15_000

/** refetchInterval for /countries: fast during a sync, slow while waiting for a first sync, off otherwise. */
export function pollInterval(countries: Country[] | undefined): number | false {
  if (!countries?.length) return false
  if (countries.some((c) => c.syncing)) return SYNC_POLL_MS
  if (countries.some((c) => !c.syncedAt)) return WAITING_POLL_MS
  return false
}

/** Per-country syncedAt snapshot used to detect a sync landing. */
export function snapshot(countries: Country[]): Record<string, string | null> {
  return Object.fromEntries(countries.map((c) => [c.code, c.syncedAt] as const))
}

/** Country codes whose syncedAt changed since prev; codes missing from prev (the first snapshot) are ignored. */
export function syncedChanged(prev: Record<string, string | null>, countries: Country[]): string[] {
  return countries.filter((c) => c.code in prev && prev[c.code] !== c.syncedAt).map((c) => c.code)
}