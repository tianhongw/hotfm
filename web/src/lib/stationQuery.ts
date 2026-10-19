import type { CountryCode, StationQuery } from '../api/types'
import { parseFreqQuery } from './freq'

export type SearchScope = 'current' | 'all'

export function stationQuery(
  country: CountryCode,
  region: string,
  sort: 'popular' | 'freq',
  term: string,
  scope: SearchScope = 'current',
): StationQuery {
  const text = term.trim()
  if (!text) return { country, region: region || undefined, sort }
  const freq = parseFreqQuery(text)
  return {
    ...(scope === 'all' ? {} : { country, region: region || undefined }),
    ...(freq == null ? { q: text } : { freq }),
    sort,
  }
}
