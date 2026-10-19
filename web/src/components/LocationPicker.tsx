import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCountries, useRegions } from '../api/hooks'
import type { CountryCode, RegionCount } from '../api/types'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useLang, useT } from '../i18n'
import { matchRegions, type Located } from '../lib/regionMatch'
import { useUI } from '../stores/ui'
import { Dialog } from './Dialog'
import { IconChevron, IconClock, IconClose, IconPin } from './Icons'
import { Popover } from './Popover'
import s from './LocationPicker.module.css'

const COUNTRIES: CountryCode[] = ['CN', 'US']

type Entry = { country: CountryCode; key: string; region?: RegionCount }

/** Both countries' regions, tagged with their country; "other" sinks to the end. */
export function useAllRegions(): Located<RegionCount>[] {
  const cn = useRegions('CN')
  const us = useRegions('US')
  return useMemo(() => {
    const tag = (c: CountryCode, rs: RegionCount[] = []) =>
      rs.map((r) => ({ ...r, country: c })).sort((a, b) => Number(a.key === 'other') - Number(b.key === 'other'))
    return [...tag('CN', cn.data), ...tag('US', us.data)]
  }, [cn.data, us.data])
}

export function useRegionLabel() {
  const lang = useLang()
  return (r: { name: string; nameEn: string }, country: CountryCode) => (lang === 'en' || country === 'US' ? r.nameEn : r.name)
}

/** Country + region in one control. Desktop: anchored popover; phone: bottom sheet. */
export function LocationPicker() {
  const t = useT()
  const label = useRegionLabel()
  const country = useUI((u) => u.country)
  const region = useUI((u) => u.region)
  const open = useUI((u) => u.locationOpen)
  const setOpen = useUI((u) => u.setLocationOpen)
  const mobile = useIsMobile()
  const regions = useRegions(country)
  const current = regions.data?.find((r) => r.key === region)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    trigger.current?.focus()
  }, [setOpen])

  return (
    <div className={s.wrap}>
      <button
        ref={trigger}
        className={s.button}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('location.button')}
        title={`${t('location.button')} (L)`}
      >
        <IconPin size={15} />
        <span className={s.buttonText}>
          <span className={s.triggerLabel}>{t(mobile ? 'location.short' : 'location.button')}</span>
          <span className={s.selection}>
            {t(`country.${country}`)} · {current ? label(current, country) : t('region.all')}
          </span>
        </span>
        <IconChevron size={14} />
      </button>
      {mobile ? (
        <Dialog open={open} onClose={close} label={t('location.button')} variant="sheet">
          <LocationPanel onDone={close} mobile />
        </Dialog>
      ) : (
        <Popover open={open} onClose={close} align="right" role="dialog" label={t('location.button')}>
          <LocationPanel onDone={close} />
        </Popover>
      )}
    </div>
  )
}

function LocationPanel({ onDone, mobile = false }: { onDone: () => void; mobile?: boolean }) {
  const t = useT()
  const label = useRegionLabel()
  const country = useUI((u) => u.country)
  const region = useUI((u) => u.region)
  const recentRefs = useUI((u) => u.recentRegions)
  const setLocation = useUI((u) => u.setLocation)
  const counts = useCountries()
  const all = useAllRegions()
  // Switching the country tab only browses; nothing changes until a region is picked.
  const [browse, setBrowse] = useState<CountryCode>(country)
  const [filter, setFilter] = useState('')
  const q = filter.trim()

  const entries: Entry[] = useMemo(() => {
    if (q) return matchRegions(all, q).map((r) => ({ country: r.country, key: r.key, region: r }))
    return [
      { country: browse, key: '' },
      ...all.filter((r) => r.country === browse).map((r) => ({ country: r.country, key: r.key, region: r })),
    ]
  }, [all, q, browse])

  const recent = useMemo(
    () =>
      recentRefs
        .filter((r) => r.country !== country || r.key !== region)
        .map((ref) => all.find((r) => r.country === ref.country && r.key === ref.key))
        .filter((r): r is Located<RegionCount> => !!r)
        .slice(0, 4),
    [recentRefs, all, country, region],
  )

  const isCurrent = (e: Entry) => e.country === country && e.key === region
  const [active, setActive] = useState(0)
  // Start on the current region so the list opens scrolled to it; a filter starts on its best match.
  useEffect(() => {
    const i = q ? -1 : entries.findIndex((e) => e.country === country && e.key === region)
    setActive(Math.max(0, i))
  }, [entries, q, country, region])
  const id = (e: Entry) => `loc-${e.country}-${e.key || 'all'}`
  useEffect(() => {
    const e = entries[active]
    if (e) document.getElementById(id(e))?.scrollIntoView({ block: 'nearest' })
  }, [active, entries])

  const choose = (e: Entry) => {
    setLocation(e.country, e.key)
    onDone()
  }

  return (
    <div className={s.panel} data-mobile={mobile || undefined}>
      <div className={s.tabs} role="tablist" aria-label="Country">
        {COUNTRIES.map((c) => {
          const n = counts.data?.find((x) => x.code === c)?.count
          return (
            <button
              key={c}
              role="tab"
              aria-selected={!q && browse === c}
              className={s.tab}
              onClick={() => {
                setBrowse(c)
                setFilter('')
              }}
            >
              <span className={s.led} />
              {t(`country.${c}`)}
              {n != null && <span className={s.tabCount}>{n}</span>}
            </button>
          )
        })}
        {mobile && (
          <button className={s.done} onClick={onDone}>
            {t('location.close')}
          </button>
        )}
      </div>

      <div className={s.filterWrap}>
        <input
          aria-label={t('location.filter')}
          className={s.filter}
          autoFocus={!mobile}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('location.filter')}
          aria-controls="location-list"
          aria-activedescendant={entries[active] ? id(entries[active]!) : undefined}
          enterKeyHint="go"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(entries.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const en = entries[active]
              if (en) choose(en)
            }
          }}
        />
        {filter && (
          <button className={s.clearInput} aria-label={t('search.clear')} onClick={() => setFilter('')}>
            <IconClose size={15} />
          </button>
        )}
      </div>

      {!q && recent.length > 0 && (
        <div className={s.recent}>
          <IconClock size={14} />
          {recent.map((r) => (
            <button key={`${r.country}-${r.key}`} className={s.recentChip} onClick={() => choose({ country: r.country, key: r.key })}>
              {label(r, r.country)}
              {r.country !== country && <span className={s.cc}>{r.country}</span>}
            </button>
          ))}
        </div>
      )}

      <div id="location-list" className={s.list} role="listbox">
        {entries.length === 0 && <div className={s.empty}>{t('location.empty')}</div>}
        {entries.map((e, i) => (
          <button
            key={id(e)}
            id={id(e)}
            role="option"
            aria-selected={isCurrent(e)}
            data-active={i === active || undefined}
            className={s.option}
            onMouseMove={() => setActive(i)}
            onClick={() => choose(e)}
          >
            <span className={s.optLabel}>
              {e.region ? label(e.region, e.country) : t('region.all')}
              {q && <span className={s.cc}>{e.country}</span>}
            </span>
            <span className={s.count}>
              {e.region ? (
                <>
                  {e.region.fmCount > 0 && <em>FM {e.region.fmCount}</em>}
                  {e.region.count}
                </>
              ) : (
                counts.data?.find((x) => x.code === e.country)?.count
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
