import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { CountryCode } from '../api/types'
import { detectLang } from '../lib/lang'
import type { SearchScope } from '../lib/stationQuery'

export type Sort = 'popular' | 'freq'
export type Tab = 'all' | 'fav' | 'recent'

export interface RegionRef {
  country: CountryCode
  key: string
}

const RECENT_REGIONS_MAX = 6

interface Toast {
  id: number
  text: string
}

interface UIState {
  country: CountryCode
  region: string
  searchText: string
  searchTerm: string
  searchScope: SearchScope
  searchFocus: number
  sort: Sort
  tab: Tab
  /** Last regions picked, newest first, across both countries. */
  recentRegions: RegionRef[]
  appearanceOpen: boolean
  locationOpen: boolean
  shortcutsOpen: boolean
  sheetOpen: boolean
  /** Tuning dial + signal meter panel; hidden by default to keep the tuner simple. */
  dialOpen: boolean
  /** Live captions / recording side panel. */
  transcriptOpen: boolean
  /** Captions shown big across the whole window; session-only, the side panel is the default. */
  captionsFull: boolean
  /** Type size of the full-screen captions, in px. */
  readerSize: number
  toast: Toast | null

  setCountry: (c: CountryCode) => void
  setRegion: (r: string) => void
  /** Country + region in one step from the location picker; keeps the query, remembered in recentRegions. */
  setLocation: (c: CountryCode, r: string) => void
  setSearchText: (text: string) => void
  commitSearch: () => void
  setSearchScope: (scope: SearchScope) => void
  focusSearch: () => void
  resetFilters: () => void
  setSort: (s: Sort) => void
  setTab: (t: Tab) => void
  setAppearanceOpen: (o: boolean) => void
  setLocationOpen: (o: boolean) => void
  setShortcutsOpen: (o: boolean) => void
  setSheetOpen: (o: boolean) => void
  setDialOpen: (o: boolean) => void
  setTranscriptOpen: (o: boolean) => void
  setCaptionsFull: (o: boolean) => void
  setReaderSize: (px: number) => void
  showToast: (text: string) => void
}

let seq = 0

export const READER_SIZE = { min: 14, max: 32, step: 2, initial: 20 }

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      country: detectLang() === 'zh' ? 'CN' : 'US',
      region: '',
      searchText: '',
      searchTerm: '',
      searchScope: 'current',
      searchFocus: 0,
      sort: 'popular',
      tab: 'all',
      recentRegions: [],
      appearanceOpen: false,
      locationOpen: false,
      shortcutsOpen: false,
      sheetOpen: false,
      dialOpen: false,
      transcriptOpen: false,
      captionsFull: false,
      readerSize: READER_SIZE.initial,
      toast: null,

      setCountry: (country) => set((s) => (s.country === country ? s : { country, region: '' })),
      setRegion: (region) => set({ region, searchText: '', searchTerm: '', searchScope: 'current' }),
      // The query survives so results re-run in the new place; a widened search narrows back to it.
      setLocation: (country, region) =>
        set((s) => ({
          country,
          region,
          searchScope: 'current',
          tab: 'all',
          recentRegions: region
            ? [{ country, key: region }, ...s.recentRegions.filter((r) => r.country !== country || r.key !== region)].slice(
                0,
                RECENT_REGIONS_MAX,
              )
            : s.recentRegions,
        })),
      setSearchText: (searchText) =>
        set((s) => ({
          searchText,
          searchTerm: searchText.trim() ? s.searchTerm : '',
          searchScope: s.searchText === searchText ? s.searchScope : 'current',
          tab: 'all',
        })),
      commitSearch: () => set((s) => ({ searchTerm: s.searchText.trim() })),
      setSearchScope: (searchScope) => set({ searchScope }),
      focusSearch: () => set((s) => ({ searchFocus: s.searchFocus + 1, tab: 'all' })),
      resetFilters: () => set({ region: '', searchText: '', searchTerm: '', searchScope: 'current', sort: 'popular', tab: 'all' }),
      setSort: (sort) => set({ sort }),
      setTab: (tab) => set({ tab, searchText: '', searchTerm: '', searchScope: 'current' }),
      setAppearanceOpen: (appearanceOpen) => set({ appearanceOpen }),
      setLocationOpen: (locationOpen) => set({ locationOpen }),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      setSheetOpen: (sheetOpen) => set({ sheetOpen }),
      setDialOpen: (dialOpen) => set({ dialOpen }),
      setTranscriptOpen: (transcriptOpen) => set(transcriptOpen ? { transcriptOpen } : { transcriptOpen, captionsFull: false }),
      setCaptionsFull: (captionsFull) => set({ captionsFull }),
      setReaderSize: (px) => set({ readerSize: Math.min(READER_SIZE.max, Math.max(READER_SIZE.min, px)) }),
      showToast: (text) => set({ toast: { id: ++seq, text } }),
    }),
    {
      name: 'hotfm.ui',
      storage: createJSONStorage(() => window.localStorage),
      version: 3,
      // v0 had a band filter and a name sort; both were dropped. v2 added recentRegions.
      migrate: (old) => {
        const { band: _band, tag: _tag, searchOpen: _searchOpen, ...rest } = (old ?? {}) as Record<string, unknown>
        return {
          ...rest,
          sort: rest.sort === 'freq' ? 'freq' : 'popular',
          recentRegions: Array.isArray(rest.recentRegions) ? rest.recentRegions : [],
        } as Partial<UIState>
      },
      partialize: ({ country, region, sort, dialOpen, recentRegions, readerSize }) => ({
        country,
        region,
        sort,
        dialOpen,
        recentRegions,
        readerSize,
      }),
    },
  ),
)
