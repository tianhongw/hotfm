// Favorites export/import: a small versioned JSON file the listener can keep or move between browsers.
import type { Station } from '../api/types'

export const FAVORITES_FORMAT = 'hotfm.favorites'
export const FAVORITES_VERSION = 1

export interface FavoritesFile {
  format: typeof FAVORITES_FORMAT
  version: typeof FAVORITES_VERSION
  /** ISO timestamp of the export. */
  exportedAt: string
  favorites: Station[]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar day as YYYYMMDD, for the download name. */
export function favoritesDateStamp(now = new Date()): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

/** hotfm-favorites-YYYYMMDD.json */
export function favoritesFileName(now = new Date()): string {
  return `hotfm-favorites-${favoritesDateStamp(now)}.json`
}

export function buildFavoritesFile(favorites: Station[], now = new Date()): FavoritesFile {
  return {
    format: FAVORITES_FORMAT,
    version: FAVORITES_VERSION,
    exportedAt: now.toISOString(),
    favorites: [...favorites],
  }
}

export function serializeFavoritesFile(favorites: Station[], now = new Date()): string {
  return JSON.stringify(buildFavoritesFile(favorites, now), null, 2) + '\n'
}

/**
 * A saved favorite is rendered as-is by the list and the player, so an entry
 * must carry the fields they read; a bare id and name would blank the list.
 */
function isStationLike(value: unknown): value is Station {
  if (!value || typeof value !== 'object') return false
  const st = value as Record<string, unknown>
  const region = st.region as Record<string, unknown> | undefined
  return (
    typeof st.id === 'string' &&
    st.id.trim() !== '' &&
    typeof st.name === 'string' &&
    typeof st.country === 'string' &&
    st.country !== '' &&
    !!region &&
    typeof region.key === 'string' &&
    region.key !== ''
  )
}

/**
 * Parse an export file. Returns the stations it holds (dropping malformed entries),
 * or null when the file is not a version-1 HotFM favorites export at all.
 */
export function parseFavoritesFile(text: string): Station[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const file = raw as Record<string, unknown>
  if (file.format !== FAVORITES_FORMAT || file.version !== FAVORITES_VERSION) return null
  if (!Array.isArray(file.favorites)) return null
  return file.favorites.filter(isStationLike)
}

/**
 * Existing favorites keep their order; ids that are new are appended in file order.
 * Duplicates already saved (or repeated inside the file) are skipped.
 */
export function mergeFavorites(existing: Station[], incoming: Station[]): { favorites: Station[]; added: Station[] } {
  const seen = new Set(existing.map((st) => st.id))
  const added: Station[] = []
  for (const st of incoming) {
    if (seen.has(st.id)) continue
    seen.add(st.id)
    added.push(st)
  }
  return { favorites: added.length > 0 ? [...existing, ...added] : existing, added }
}