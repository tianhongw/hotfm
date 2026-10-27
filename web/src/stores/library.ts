import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Station } from '../api/types'
import { detectLang, type Lang } from '../lib/lang'
import { LIBRARY_VERSION, migrateLibrary, type Theme, type ColorMode } from '../lib/appearance'
export type { Theme, ColorMode } from '../lib/appearance'

const RECENT_MAX = 10
const SEARCHES_MAX = 6

export const THEMES: Theme[] = ['apple', 'hifi']

/**
 * Everything the listener owns, kept in localStorage (no accounts yet).
 * `version` lets a future server-side sync migrate this shape.
 */
interface LibraryState {
  version: 1
  lang: Lang
  theme: Theme
  colorMode: ColorMode
  favorites: Station[]
  recent: Station[]
  volume: number
  muted: boolean
  noise: boolean
  lastStationId: string | null
  regionTipDismissed: boolean
  recentSearches: string[]

  toggleFavorite: (st: Station) => boolean
  removeFavorite: (id: string) => void
  /** Put a station back where it was (Undo after a removal); ignored when already saved. */
  insertFavorite: (st: Station, index: number) => void
  pushRecent: (st: Station) => void
  removeRecent: (id: string) => void
  /** Put a station back at its previous position in Recent. */
  insertRecent: (st: Station, index: number) => void
  clearRecent: () => void
  /** Restore a whole recent list (Undo after clearing). */
  restoreRecent: (list: Station[]) => void
  setVolume: (v: number) => void
  setMuted: (m: boolean) => void
  setNoise: (n: boolean) => void
  setLang: (l: Lang) => void
  setTheme: (t: Theme) => void
  setColorMode: (mode: ColorMode) => void
  clearSearches: () => void
  pushSearch: (q: string) => void
  removeSearch: (q: string) => void
  setLastStation: (id: string) => void
  dismissRegionTip: () => void
  /** Replace stored snapshots with fresh server data; ids the server no longer knows become offline. */
  refresh: (fresh: Station[], requested: string[]) => void
}

const markOffline = (st: Station): Station => ({ ...st, offline: true })

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      version: 1,
      lang: detectLang(),
      theme: 'apple',
      colorMode: 'light',
      favorites: [],
      recent: [],
      volume: 0.7,
      muted: false,
      noise: true,
      lastStationId: null,
      regionTipDismissed: false,
      recentSearches: [],

      toggleFavorite: (st) => {
        const exists = get().favorites.some((f) => f.id === st.id)
        set({ favorites: exists ? get().favorites.filter((f) => f.id !== st.id) : [st, ...get().favorites] })
        return !exists
      },
      removeFavorite: (id) => set({ favorites: get().favorites.filter((f) => f.id !== id) }),
      insertFavorite: (st, index) =>
        set((s) => {
          if (s.favorites.some((f) => f.id === st.id)) return s
          const favorites = [...s.favorites]
          favorites.splice(Math.min(Math.max(0, index), favorites.length), 0, st)
          return { favorites }
        }),
      pushRecent: (st) => set({ recent: [st, ...get().recent.filter((r) => r.id !== st.id)].slice(0, RECENT_MAX) }),
      removeRecent: (id) => set({ recent: get().recent.filter((r) => r.id !== id) }),
      insertRecent: (st, index) =>
        set((s) => {
          const rest = s.recent.filter((r) => r.id !== st.id)
          const recent = [...rest]
          recent.splice(Math.min(Math.max(0, index), recent.length), 0, st)
          return { recent: recent.slice(0, RECENT_MAX) }
        }),
      clearRecent: () => set({ recent: [] }),
      restoreRecent: (list) => set({ recent: list.slice(0, RECENT_MAX) }),
      setVolume: (v) => set({ volume: Math.min(1, Math.max(0, v)), muted: false }),
      setMuted: (muted) => set({ muted }),
      setNoise: (noise) => set({ noise }),
      setLang: (lang) => set({ lang }),
      setTheme: (theme) => set({ theme }),
      setColorMode: (colorMode) => set({ colorMode }),
      clearSearches: () => set({ recentSearches: [] }),
      pushSearch: (q) => {
        const term = q.trim()
        if (!term) return
        const lower = term.toLowerCase()
        set({ recentSearches: [term, ...get().recentSearches.filter((x) => x.toLowerCase() !== lower)].slice(0, SEARCHES_MAX) })
      },
      removeSearch: (q) => set({ recentSearches: get().recentSearches.filter((x) => x !== q) }),
      setLastStation: (lastStationId) => set({ lastStationId }),
      dismissRegionTip: () => set({ regionTipDismissed: true }),
      refresh: (fresh, requested) => {
        const byId = new Map(fresh.map((s) => [s.id, s]))
        // A merge absorbs duplicate ids into one surviving station; those answer
        // with aliasOf so stored entries can be re-pointed at the survivor.
        const byAlias = new Map(fresh.flatMap((s) => (s.aliasOf ? [[s.aliasOf, s] as const] : [])))
        const asked = new Set(requested)
        const swap = (st: Station) =>
          byId.get(st.id) ?? byAlias.get(st.id) ?? (asked.has(st.id) ? markOffline(st) : st)
        const dedupe = (list: Station[]) => {
          const seen = new Set<string>()
          return list.filter((s) => !seen.has(s.id) && (seen.add(s.id), true))
        }
        const last = get().lastStationId
        const lastHit = last ? (byId.get(last) ?? byAlias.get(last)) : undefined
        set({
          favorites: dedupe(get().favorites.map(swap)),
          recent: dedupe(get().recent.map(swap)).slice(0, RECENT_MAX),
          lastStationId: lastHit ? lastHit.id : last,
        })
      },
    }),
    {
      name: 'hotfm.library',
      version: LIBRARY_VERSION,
      migrate: migrateLibrary,
      merge: (persisted, current) => {
        const saved = persisted as Partial<LibraryState> | undefined
        return { ...current, ...saved, recent: (saved?.recent ?? current.recent).slice(0, RECENT_MAX) }
      },
      storage: createJSONStorage(() => {
        try {
          return window.localStorage
        } catch {
          return sessionStorageFallback
        }
      }),
      // Keep listener data intact when migrating the default appearance.
      partialize: ({
        version,
        lang,
        theme,
        colorMode,
        favorites,
        recent,
        volume,
        muted,
        noise,
        lastStationId,
        regionTipDismissed,
        recentSearches,
      }) => ({
        version,
        lang,
        theme,
        colorMode,
        favorites,
        recent,
        volume,
        muted,
        noise,
        lastStationId,
        regionTipDismissed,
        recentSearches,
      }),
    },
  ),
)

/** In-memory storage for private windows where localStorage throws. */
const memory = new Map<string, string>()
const sessionStorageFallback = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
}

export function libraryIds(): string[] {
  const s = useLibrary.getState()
  const ids = new Set<string>()
  for (const st of [...s.favorites, ...s.recent]) ids.add(st.id)
  return [...ids]
}
