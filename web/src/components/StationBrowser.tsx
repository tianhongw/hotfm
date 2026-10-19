import { useMemo } from 'react'
import { useCountries, useRegions, useStationList } from '../api/hooks'
import { useT } from '../i18n'
import { stationQuery } from '../lib/stationQuery'
import { useLibrary } from '../stores/library'
import { useUI, type Tab } from '../stores/ui'
import { IconSearch, IconWave } from './Icons'
import { useRegionLabel } from './LocationPicker'
import { StationList } from './StationList'
import { StationSearch } from './StationSearch'
import s from './StationBrowser.module.css'

export function StationBrowser() {
  const t = useT()
  const ui = useUI()
  const { country, region, sort, tab, searchText, searchTerm, searchScope } = ui
  const { favorites, recent, removeFavorite, removeRecent, theme } = useLibrary()
  const regions = useRegions(country)
  const countries = useCountries()
  const label = useRegionLabel()
  const place = regions.data?.find((r) => r.key === region)
  const location = [t(`country.${country}`), region ? (place ? label(place, country) : region) : t('region.all')].join(' · ')
  const searchLocation = region ? location : t(`country.${country}`)
  const searchCount = searchScope === 'all'
    ? countries.data?.reduce((sum, c) => sum + c.count, 0)
    : region ? place?.count : countries.data?.find((c) => c.code === country)?.count
  const searching = !!searchText.trim()
  const waiting = searchText.trim() !== searchTerm
  const query = useMemo(
    () => stationQuery(country, region, sort, searchTerm, searchScope),
    [country, region, sort, searchTerm, searchScope],
  )
  const list = useStationList(query, tab === 'all' && !waiting)
  const stations = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = waiting ? undefined : list.data?.pages[0]?.total
  const tabs: [Tab, string, number | undefined][] = [
    ['all', t('tab.all'), undefined],
    ['fav', t('tab.fav'), favorites.length],
    ['recent', t('tab.recent'), recent.length],
  ]
  const title = tab === 'fav' ? t('home.library') : tab === 'recent' ? t('home.recent') : t('home.title')
  const ResultHeading = theme === 'apple' ? 'h2' : 'h1'
  return (
    <section className={s.browser}>
      {theme === 'apple' && (
        <div className={s.intro}>
          <h1>{title}</h1>
          <p>{t('home.subtitle')}</p>
        </div>
      )}
      <div className={s.searchArea}>
        <StationSearch location={searchScope === 'all' ? t('search.allRegions') : location} stationCount={searchCount} />
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
                  ui.setTab(next)
                  document.getElementById(`tab-${next}`)?.focus()
                }
              }}
              className={s.tab}
              onClick={() => ui.setTab(key)}
            >
              {text}
              {!!count && <span className={s.count}>{count}</span>}
            </button>
          ))}
        </div>
      </div>
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
                      : total != null
                        ? t(searching ? 'list.results' : 'list.count', { n: total.toLocaleString() })
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
                  <IconSearch size={30} />
                  <h3>
                    {searching && searchScope === 'current'
                      ? t('search.emptyLocal', { location: searchLocation })
                      : t(searching ? 'search.empty' : 'list.empty')}
                  </h3>
                  <p>{t(searching && searchScope === 'current' ? 'search.widenHint' : 'search.emptyHint')}</p>
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
                </div>
              ) : (
                <>
                  <StationList
                    key={JSON.stringify(query)}
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
            {tab === 'fav' && <StationList stations={favorites} onRemove={removeFavorite} empty={t('list.emptyFav')} />}
            {tab === 'recent' && <StationList stations={recent} onRemove={removeRecent} empty={t('list.emptyRecent')} />}
          </div>
        </div>
      </div>
    </section>
  )
}
