import { FM_MAX, FM_MIN, roundFreq } from './dial'

const inBand = (f: number) => f >= FM_MIN && f <= FM_MAX

/**
 * Reads an FM frequency out of a search query: "101.7", "FM 101.7", "101.7fm", "调频97.4",
 * "1017" / "905" (the compact form used in station names) or a bare "98".
 * Returns MHz rounded to 0.1, or null when the query is not a frequency.
 */
export function parseFreqQuery(query: string): number | null {
  const m = /^(?:fm|调频)?\s*(\d{2,4}(?:\.\d)?)\s*(?:fm|mhz|兆赫)?$/i.exec(query.trim())
  if (!m) return null
  const raw = m[1]!
  if (raw.includes('.')) {
    const f = Number(raw)
    return inBand(f) ? roundFreq(f) : null
  }
  const n = Number(raw)
  if (raw.length === 4) return inBand(n / 10) ? roundFreq(n / 10) : null
  if (raw.length === 3) {
    if (inBand(n / 10)) return roundFreq(n / 10) // 905 → 90.5
    return inBand(n) ? n : null // 101 → 101.0
  }
  return inBand(n) ? n : null // 98 → 98.0
}
