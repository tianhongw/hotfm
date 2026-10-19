import type { CountryCode } from '../api/types'

/** Deep-link state: ?c=US&r=california&s=<stationId> */
export interface UrlState {
  country?: CountryCode
  region?: string
  station?: string
}

export function readUrl(): UrlState {
  const p = new URLSearchParams(window.location.search)
  const c = p.get('c')?.toUpperCase()
  return {
    country: c === 'US' || c === 'CN' ? c : undefined,
    region: p.get('r') ?? undefined,
    station: p.get('s') ?? undefined,
  }
}

export function writeUrl(s: UrlState, mode: 'push' | 'replace') {
  const p = new URLSearchParams()
  if (s.country) p.set('c', s.country)
  if (s.region) p.set('r', s.region)
  if (s.station) p.set('s', s.station)
  const next = '?' + p.toString()
  if (next === window.location.search) return
  if (mode === 'push') window.history.pushState(null, '', next)
  else window.history.replaceState(null, '', next)
}

export function shareUrl(stationId: string, country: CountryCode): string {
  const u = new URL(window.location.href)
  u.search = new URLSearchParams({ c: country, s: stationId }).toString()
  return u.toString()
}
