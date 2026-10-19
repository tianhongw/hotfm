import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Station } from '../api/types'
import { useT } from '../i18n'
import { useLibrary } from '../stores/library'
import { usePlayer } from '../stores/player'
import { StationRow } from './StationRow'
import s from './StationList.module.css'

interface Props {
  stations: Station[]
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  onRemove?: (id: string) => void
  empty: string
}

/** Window-scrolled virtual list; fetches the next page as the end comes into view. */
export function StationList({ stations, hasMore, loadingMore, onLoadMore, onRemove, empty }: Props) {
  const t = useT()
  const playingId = usePlayer((p) => p.station?.id)
  const favorites = useLibrary((l) => l.favorites)
  const favIds = new Set(favorites.map((f) => f.id))
  const parent = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const rowHeight = window.matchMedia('(max-width: 767px)').matches ? 60 : 64

  useLayoutEffect(() => {
    const measure = () => setOffset((parent.current?.getBoundingClientRect().top ?? 0) + window.scrollY)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(document.body)
    return () => ro.disconnect()
  }, [])

  const virtualizer = useWindowVirtualizer({
    count: stations.length,
    estimateSize: () => rowHeight,
    overscan: 8,
    scrollMargin: offset,
  })
  const items = virtualizer.getVirtualItems()
  const last = items[items.length - 1]

  useEffect(() => {
    if (last && last.index >= stations.length - 6 && hasMore && !loadingMore) onLoadMore?.()
  }, [last, stations.length, hasMore, loadingMore, onLoadMore])

  if (stations.length === 0) {
    return <div className={s.empty}>{empty}</div>
  }

  return (
    <div ref={parent} className={s.list} style={{ height: virtualizer.getTotalSize() }} role="list">
      {items.map((it) => {
        const st = stations[it.index]!
        return (
          <div
            key={st.id}
            role="listitem"
            className={s.item}
            style={{ height: it.size, transform: `translateY(${it.start - virtualizer.options.scrollMargin}px)` }}
          >
            <StationRow
              station={st}
              playing={st.id === playingId}
              favorite={favIds.has(st.id)}
              onRemove={onRemove ? () => onRemove(st.id) : undefined}
            />
          </div>
        )
      })}
      {loadingMore && (
        <div className={s.more} style={{ top: virtualizer.getTotalSize() }}>
          {t('list.loading')}
        </div>
      )}
    </div>
  )
}
