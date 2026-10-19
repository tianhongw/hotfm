// Fuzzy region lookup shared by the location picker and the search palette.
// Matches native name, English name, key (pinyin for CN), pinyin initials ("gd" → 广东)
// and USPS codes ("tx" → Texas).

import type { CountryCode } from '../api/types'

export interface RegionLike {
  key: string
  name: string
  nameEn: string
}

export type Located<T extends RegionLike> = T & { country: CountryCode }

const USPS: Record<string, string> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct',
  delaware: 'de', 'district-of-columbia': 'dc', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il',
  indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt',
  nebraska: 'ne', nevada: 'nv', 'new-hampshire': 'nh', 'new-jersey': 'nj', 'new-mexico': 'nm', 'new-york': 'ny',
  'north-carolina': 'nc', 'north-dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa',
  'rhode-island': 'ri', 'south-carolina': 'sc', 'south-dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut',
  vermont: 'vt', virginia: 'va', washington: 'wa', 'west-virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
  'puerto-rico': 'pr',
}

// One pinyin syllable: optional initial + final. A trailing n/ng is only taken when no vowel follows,
// so "henan" splits he-nan rather than hen-an.
const SYLLABLE =
  /(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ia[o]|ua[i]|ian(?![aeiouv])|uan(?![aeiouv])|ang(?![aeiouv])|eng(?![aeiouv])|ing(?![aeiouv])|ong(?![aeiouv])|ai|ei|ao|ou|an(?![aeiouv])|en(?![aeiouv])|in(?![aeiouv])|un(?![aeiouv])|ia|ie|iu|ua|uo|ui|ue|er|a|o|e|i|u|v)/y

/** "guangdong" → "gd", "neimenggu" → "nmg"; null when the key is not clean pinyin. */
export function pinyinInitials(key: string): string | null {
  SYLLABLE.lastIndex = 0
  let out = ''
  while (SYLLABLE.lastIndex < key.length) {
    const start = SYLLABLE.lastIndex
    const m = SYLLABLE.exec(key)
    if (!m) return null
    out += key[start]
    if (SYLLABLE.lastIndex === start) return null
  }
  return out
}

function initials(r: RegionLike, country: CountryCode): string[] {
  if (country === 'US') {
    const words = r.key.split('-')
    const out = [USPS[r.key]]
    if (words.length > 1) out.push(words.map((w) => w[0]).join(''))
    return out.filter((x): x is string => !!x)
  }
  const py = pinyinInitials(r.key)
  return py ? [py] : []
}

/** Lower score = better match; null = no match. */
export function regionScore(r: RegionLike, country: CountryCode, query: string): number | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return null
  const qKey = q.replace(/[\s-]/g, '')
  const fields = [r.name.toLowerCase(), r.nameEn.toLowerCase(), r.key.replace(/-/g, '')]
  if (fields.some((f) => f === q || f === qKey)) return 0
  const abbr = initials(r, country)
  if (abbr.includes(qKey)) return 1
  if (fields.some((f) => f.startsWith(q) || f.startsWith(qKey))) return 2
  if (r.nameEn.toLowerCase().split(' ').some((w) => w.startsWith(q))) return 3
  if (qKey.length >= 2 && abbr.some((a) => a.startsWith(qKey))) return 4
  if (fields.some((f) => f.includes(q))) return 5
  return null
}

/** Matching regions, best first; ties keep the input order (which the API sorts by station count). */
export function matchRegions<T extends RegionLike>(items: Located<T>[], query: string): Located<T>[] {
  const scored: [Located<T>, number, number][] = []
  items.forEach((r, i) => {
    const s = regionScore(r, r.country, query)
    if (s != null) scored.push([r, s, i])
  })
  return scored.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([r]) => r)
}
