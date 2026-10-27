import { useLayoutEffect, useMemo, useRef, type ChangeEvent } from 'react'
import { useCountriesSyncWatch, useRegions, useStationList } from '../api/hooks'
import { saveFile } from '../capture/export'
import { useT } from '../i18n'
import { favoritesFileName, mergeFavorites, parseFavoritesFile, serializeFavoritesFile } from '../lib/favoritesFile'
import { stationQuery } from '../lib/stationQuery'
import { clearRecentWithUndo, refreshLibrary, removeFavoriteWithUndo, removeRecentWithUndo } from '../player/controller'
import { useLibrary } from '../stores/library'
import { useUI, type Tab } from '../stores/ui'
import { IconSearch, IconWave } from './Icons'
import { useRegionLabel } from './LocationPicker'
import { StationList } from './StationList'
import { StationSearch } from './StationSearch'
import s from './StationBrowser.module.css'

/**
 * Delays at which a tab switch re-applies the saved scroll offset. The window
 * virtualizer aligns its first row after measuring, so one early scroll would be
 * undone; these cover that window and then stop.
 */
const RESTORE_STEPS = [0, 90, 220, 450, 800]

export function StationBrowser() {
  const t = useT()
  const ui = useUI()
  const { country, region, sort, tab, searchText, searchTerm, searchScope } = ui
  const { favorites, recent, theme } = useLibrary()
  const regions = useRegions(country)
  const label = useRegionLabel()
  const place = regions.data?.find((r) => r.key === region)
  const location = [t(`country.${country}`), region ? (place ? label(place, country) : region) : t('region.all')].join(' · ')
  const searchLocation = region ? location : t(`country.${country}`)
  const searching = !!searchText.trim()
  const waiting = searchText.trim() !== searchTerm
  const query = useMemo(
    () => stationQuery(country, region, sort, searchTerm, searchScope),
    [country, region, sort, searchTerm, searchScope],
  )
  const list = useStationList(query, tab === 'all' && !waiting)
  const stations = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = waiting ? undefined : list.data?.pages[0]?.total
  const countries = useCountriesSyncWatch()
  const selected = countries.data?.find((c) => c.code === country)
  const pendingSync = !!selected && (selected.syncing || !selected.syncedAt)
  const syncingEmpty = !searching && pendingSync && stations.length === 0
  const tabs: [Tab, string, number | undefined][] = [
    ['all', t('tab.all'), undefined],
    ['fav', t('tab.fav'), favorites.length],
    ['recent', t('tab.recent'), recent.length],
  ]
  const title = tab === 'fav' ? t('home.library') : tab === 'recent' ? t('home.recent') : t('home.title')
  const ResultHeading = theme === 'apple' ? 'h2' : 'h1'
  // Each tab comes back to where the listener left it; a new query starts at the top. Session only.
  // Offsets are kept relative to the list itself, because the space above it differs per tab
  // and a window virtualizer re-aligns to its own measured top while the layout settles.
  const scrollByTab = useRef<Record<Tab, number>>({ all: 0, fav: 0, recent: 0 })
  /** Offset within the opened tab's list that the next restore should land on. */
  const restoreTo = useRef<number | null>(null)
  /** Set while a restore is retrying, so a re-render does not start a second loop. */
  const restoring = useRef(false)
  const listTop = () => {
    const el = document.querySelector('#station-panel [role="list"]')
    return el ? el.getBoundingClientRect().top + window.scrollY : null
  }
  const shownTab = useRef(tab)
  const pickedTab = useRef(false)
  const queryKey = JSON.stringify(query)
  const shownQuery = useRef(queryKey)
  const fileInput = useRef<HTMLInputElement>(null)

  // Tab bar picks remember the list being left and restore the one being opened.
  const goTab = (next: Tab) => {
    if (next === tab) return
    pickedTab.current = true
    const top = listTop()
    scrollByTab.current[tab] = top == null ? 0 : Math.max(0, window.scrollY - top)
    restoreTo.current = scrollByTab.current[next]
    ui.setTab(next)
  }

  useLayoutEffect(() => {
    if (shownTab.current === tab) return
    shownTab.current = tab
    if (pickedTab.current) {
      pickedTab.current = false
      return
    }
    // The tab changed from elsewhere (search, location, keyboard): start at the top.
    restoreTo.current = 0
  }, [tab])

  useLayoutEffect(() => {
    if (shownQuery.current === queryKey) return
    shownQuery.current = queryKey
    scrollByTab.current.all = 0
    if (shownTab.current === 'all') restoreTo.current = 0
  }, [queryKey])

  // Runs after the lists have laid out, so a virtualized list can jump straight to the saved offset.
  useLayoutEffect(() => {
    const rel = restoreTo.current
    if (rel == null || restoring.current) return
    // The Stations tab may still show its skeleton; restore once its rows exist so the height is real.
    if (tab === 'all' && (waiting || list.isPending || stations.length === 0)) return
    // The window virtualizer aligns its first visible row once its mounted rows have
    // been measured, which happens after this commit and undoes an early scrollTo.
    // Re-apply across that window, then leave the page alone.
    restoring.current = true
    const aim = () => {
      const top = listTop()
      return rel <= 0 || top == null ? 0 : Math.round(top + rel)
    }
    const timers = RESTORE_STEPS.map((ms) =>
      window.setTimeout(() => {
        if (restoreTo.current !== rel) return clear()
        window.scrollTo(0, aim())
        if (ms === RESTORE_STEPS[RESTORE_STEPS.length - 1]) clear()
      }, ms),
    )
    const clear = () => {
      for (const id of timers) window.clearTimeout(id)
      if (restoreTo.current === rel) restoreTo.current = null
      restoring.current = false
    }
    window.scrollTo(0, aim())
  })

  const exportFavorites = () => {
    const saved = useLibrary.getState().favorites
    if (saved.length === 0) return
    const now = new Date()
    saveFile(new Blob([serializeFavoritesFile(saved, now)], { type: 'application/json' }), favoritesFileName(now))
  }

  const importFavorites = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // picking the same file again should still fire
    if (!file) return
    const parsed = parseFavoritesFile(await file.text())
    if (!parsed) {
      ui.showToast(t('toast.importInvalid'))
      return
    }
    const { added } = mergeFavorites(useLibrary.getState().favorites, parsed)
    if (added.length === 0) {
      ui.showToast(t('toast.importNone'))
      return
    }
    for (const station of added) useLibrary.getState().insertFavorite(station, useLibrary.getState().favorites.length)
    ui.showToast(t('toast.imported', { n: added.length }))
    void refreshLibrary(added.map((station) => station.id))
  }
  return (
    <section className={s.browser}>
      {theme === 'apple' && (
        <div className={s.intro}>
          <h1>{title}</h1>
          <p>{t('home.subtitle')}</p>
        </div>
      )}
      <div className={s.searchArea}>
        <StationSearch />
      </div>
      <div className={s.navigation}>
        <div className={s.tabs} role="tablist" aria-label={t('home.radio')}>
          {tabs.map(([key, text, count]) => (
            <button
              key={key}
              id={`tab-${key}`}
              role="tab"
              aria-selected={tab === key}
              aria-controls="station-panel"
              tabIndex={tab === key ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault()
                  e.stopPropagation()
                  const next = tabs[(tabs.findIndex(([v]) => v === tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]![0]
                  goTab(next)
                  document.getElementById(`tab-${next}`)?.focus()
                }
              }}
              className={s.tab}
              onClick={() => goTab(key)}
            >
              {text}
              {!!count && <span className={s.count}>{count}</span>}
            </button>
          ))}
        </div>
      </div>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void importFavorites(e)} />
      <div className={s.content}>
        <div id="station-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <div className={s.listTitle}>
            <div className={s.summary}>
              {searching ? <IconSearch size={17} /> : <IconWave size={17} />}
              <div className={s.summaryText}>
                <ResultHeading>
                  {tab === 'all'
                    ? searching
                      ? t('search.results', { q: searchText.trim() })
                      : location
                    : t(tab === 'fav' ? 'tab.fav' : 'tab.recent')}
                </ResultHeading>
                <span className={s.resultCount} role="status">
                  {tab === 'all'
                    ? waiting || list.isPending
                      ? t('list.loading')
                      : syncingEmpty
                        ? t('list.syncing')
                        : total != null
                          ? t(searching ? 'list.results' : 'list.count', { n: total })
                          : ''
                    : t('list.count', { n: tab === 'fav' ? favorites.length : recent.length })}
                  {tab === 'all' && searching && ` · ${searchScope === 'all' ? t('search.allRegions') : searchLocation}`}
                </span>
                {tab === 'all' && searching && searchScope === 'all' && (
                  <button className={s.searchReturn} onClick={() => ui.setSearchScope('current')}>
                    {t('search.returnLocal', { location: searchLocation })}
                  </button>
                )}
              </div>
            </div>
            {tab === 'all' && (
              <div className={s.tools}>
                {(searching || region || sort !== 'popular') && (
                  <button className={s.clear} onClick={ui.resetFilters}>
                    {t('filter.clear')}
                  </button>
                )}
                <fieldset className={s.sortControl}>
                  <legend className="sr-only">{t('filter.sort')}</legend>
                  {(['popular', 'freq'] as const).map((value) => (
                    <label className={s.sortOption} key={value}>
                      <input type="radio" name="station-sort" value={value} checked={sort === value} onChange={() => ui.setSort(value)} />
                      <span>{t(searching && query.q && value === 'popular' ? 'sort.relevance' : `sort.${value}`)}</span>
                    </label>
                  ))}
                </fieldset>
              </div>
            )}
            {tab === 'fav' && (
              <div className={s.tools}>
                {favorites.length > 0 && (
                  <button className={s.clear} onClick={exportFavorites}>
                    {t('fav.export')}
                  </button>
                )}
                <button className={s.clear} onClick={() => fileInput.current?.click()}>
                  {t('fav.import')}
                </button>
              </div>
            )}
            {tab === 'recent' && recent.length > 0 && (
              <div className={s.tools}>
                <button className={s.clear} onClick={clearRecentWithUndo}>
                  {t('recent.clear')}
                </button>
              </div>
            )}
          </div>
          <div className={s.columns} aria-hidden>
            <span>{t('list.station')}</span>
            <span>{t('list.frequency')}</span>
            <span>{t('list.quality')}</span>
            <span />
          </div>
          <div className={s.listWrap} aria-busy={tab === 'all' && (waiting || list.isPending)}>
            {tab === 'all' &&
              (waiting || list.isPending ? (
                <div className={s.skeleton}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} />
                  ))}
                </div>
              ) : list.isError && !list.data ? (
                <button className={s.error} onClick={() => void list.refetch()}>
                  {t('list.error')}
                </button>
              ) : stations.length === 0 ? (
                <div className={s.empty}>
                  {syncingEmpty ? <IconWave size={30} /> : <IconSearch size={30} />}
                  <h3>
                    {syncingEmpty
                      ? t('list.syncing')
                      : searching && searchScope === 'current'
                        ? t('search.emptyLocal', { location: searchLocation })
                        : t(searching ? 'search.empty' : 'list.empty')}
                  </h3>
                  <p>
                    {syncingEmpty
                      ? t('list.syncingHint')
                      : t(searching && searchScope === 'current' ? 'search.widenHint' : 'search.emptyHint')}
                  </p>
                  {!syncingEmpty && (
                    <div>
                      {searching && searchScope === 'current' && (
                        <button className={s.widen} onClick={() => ui.setSearchScope('all')}>
                          <IconSearch size={16} />
                          {t('search.widen')}
                        </button>
                      )}
                      {searching && <button onClick={() => ui.setSearchText('')}>{t('search.clear')}</button>}
                      {!searching && region && <button onClick={ui.resetFilters}>{t('filter.clear')}</button>}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <StationList
                    key={queryKey}
                    stations={stations}
                    hasMore={list.hasNextPage && !list.isFetchNextPageError}
                    loadingMore={list.isFetchingNextPage}
                    onLoadMore={() => void list.fetchNextPage()}
                    empty={t('list.empty')}
                  />
                  {list.isFetchNextPageError && (
                    <button className={s.error} onClick={() => void list.fetchNextPage()}>
                      {t('list.error')}
                    </button>
                  )}
                </>
              ))}
            {tab === 'fav' &&
              (favorites.length === 0 ? (
                <div className={s.empty}>
                  <h3>{t('list.emptyFav')}</h3>
                  <div>
                    <button onClick={() => fileInput.current?.click()}>{t('fav.import')}</button>
                  </div>
                </div>
              ) : (
                <StationList stations={favorites} onRemove={removeFavoriteWithUndo} empty={t('list.emptyFav')} />
              ))}
            {tab === 'recent' && <StationList stations={recent} onRemove={removeRecentWithUndo} empty={t('list.emptyRecent')} />}
          </div>
        </div>
      </div>
    </section>
  )
}
