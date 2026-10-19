import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useLibrary } from '../stores/library'
import { useUI } from '../stores/ui'
import { IconClose, IconClock, IconSearch } from './Icons'
import { LocationPicker } from './LocationPicker'
import s from './StationSearch.module.css'

/** One bar: query on the left, the location it searches in on the right. */
export function StationSearch() {
  const t = useT()
  const ui = useUI()
  const { recentSearches, pushSearch, removeSearch, clearSearches } = useLibrary()
  const input = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const history = focused && !ui.searchText.trim() && recentSearches.length > 0

  useEffect(() => {
    if (ui.searchFocus) {
      input.current?.focus({ preventScroll: true })
      input.current?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    }
  }, [ui.searchFocus])
  useEffect(() => {
    if (composing) return
    const timer = window.setTimeout(ui.commitSearch, 200)
    return () => window.clearTimeout(timer)
  }, [ui.searchText, ui.commitSearch, composing])

  const submit = () => {
    if (composing) return
    ui.commitSearch()
    pushSearch(ui.searchText)
    setFocused(false)
  }

  return (
    <div className={s.bar}>
      <div
        className={s.searchWrap}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false)
        }}
      >
        <form
          className={s.search}
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <IconSearch size={19} />
          <input
            id="station-search"
            ref={input}
            type="search"
            autoComplete="off"
            maxLength={64}
            placeholder={t('search.placeholder')}
            aria-label={t('search.button')}
            aria-describedby="station-search-scope"
            aria-controls="station-panel"
            value={ui.searchText}
            onChange={(e) => ui.setSearchText(e.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (composing || e.nativeEvent.isComposing)) e.preventDefault()
              if (e.key === 'Escape' && !composing) {
                setFocused(false)
                input.current?.blur()
              }
            }}
            enterKeyHint="search"
          />
          {ui.searchText ? (
            <button
              type="button"
              className={s.clear}
              aria-label={t('search.clear')}
              title={t('search.clear')}
              onClick={() => {
                ui.setSearchText('')
                input.current?.focus()
              }}
            >
              <IconClose size={17} />
            </button>
          ) : (
            <kbd className={s.searchKey}>⌘ K</kbd>
          )}
        </form>
        {history && (
          <div className={s.history}>
            <div className={s.historyHead}>
              <strong>{t('search.recent')}</strong>
              <button onClick={clearSearches}>{t('search.clearAll')}</button>
            </div>
            {recentSearches.map((q) => (
              <div className={s.historyRow} key={q}>
                <button
                  onClick={() => {
                    ui.setSearchText(q)
                    ui.commitSearch()
                    pushSearch(q)
                    setFocused(false)
                  }}
                >
                  <IconClock size={16} />
                  {q}
                </button>
                <button aria-label={`${t('search.clearRecent')} ${q}`} onClick={() => removeSearch(q)}>
                  <IconClose size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <span className={s.divider} aria-hidden />
      <LocationPicker />
    </div>
  )
}
