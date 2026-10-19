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
  toast: Toast | null

  setCountry: (c: CountryCode) => void
  setRegion: (r: string) => void
  /** Country + region in one step (the location picker and search use this); remembered in recentRegions. */
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
  showToast: (text: string) => void
}

let seq = 0

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
      toast: null,

      setCountry: (country) => set((s) => (s.country === country ? s : { country, region: '' })),
      setRegion: (region) => set({ region, searchText: '', searchTerm: '', searchScope: 'current' }),
      setLocation: (country, region) =>
        set((s) => ({
          country,
          region,
          searchText: '',
          searchTerm: '',
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
      partialize: ({ country, region, sort, dialOpen, recentRegions }) => ({ country, region, sort, dialOpen, recentRegions }),
    },
  ),
)
