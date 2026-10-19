import { memo, useState } from 'react'
import type { Station } from '../api/types'
import { useLang, useT } from '../i18n'
import { formatFreq } from '../lib/dial'
import { shareUrl } from '../lib/url'
import { playStation, toggleFavorite } from '../player/controller'
import { useUI } from '../stores/ui'
import { IconExternal, IconHeart, IconLink, IconMore, IconPlay, IconTrash } from './Icons'
import { Logo } from './Logo'
import { MenuItem, Popover } from './Popover'
import s from './StationRow.module.css'

interface Props {
  station: Station
  playing: boolean
  favorite: boolean
  onRemove?: () => void
}

export const StationRow = memo(function StationRow({ station: st, playing, favorite, onRemove }: Props) {
  const t = useT()
  const lang = useLang()
  const [menu, setMenu] = useState(false)

  const region = st.region.key === 'other' ? '' : lang === 'en' || st.country === 'US' ? st.region.nameEn : st.region.name
  const place = [t(`country.${st.country}`), st.city, region].filter(Boolean).join(' · ')

  return (
    <div className={s.row} data-playing={playing || undefined} data-offline={st.offline || undefined}>
      <button className={s.main} onClick={() => playStation(st)} disabled={st.offline} aria-label={`${t('transport.play')} ${st.name}`}>
        <span className={s.logoWrap}>
          <Logo src={st.logo} name={st.name} size={40} />
          <span className={s.playOverlay} aria-hidden>
            {playing ? (
              <span className={s.eq}>
                <i />
                <i />
                <i />
              </span>
            ) : (
              <IconPlay size={16} />
            )}
          </span>
        </span>
        <span className={s.text}>
          <span className={s.name}>{st.name}</span>
          <span className={s.meta}>
            {st.offline && <span className={s.offline}>{t('list.offline')}</span>}
            {place && <span>{place}</span>}
          </span>
        </span>
        <span className={s.freq} data-net={st.freq == null || undefined}>
          {st.freq != null ? formatFreq(st.freq) : 'NET'}
        </span>
        <span className={s.codec}>
          {st.stream.type === 'hls' ? 'HLS' : st.codec}
          {st.bitrate > 0 && <em>{st.bitrate}k</em>}
        </span>
      </button>
      <div className={s.actions}>
        {onRemove ? (
          <button className={s.icon} onClick={onRemove} aria-label={t('list.remove')} title={t('list.remove')}>
            <IconTrash size={16} />
          </button>
        ) : (
          <button
            className={s.icon}
            data-on={favorite || undefined}
            onClick={() => toggleFavorite(st)}
            aria-pressed={favorite}
            aria-label={favorite ? t('menu.unfav') : t('menu.fav')}
          >
            <IconHeart size={16} filled={favorite} />
          </button>
        )}
        <div className={s.anchor}>
          <button className={s.icon} onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="More">
            <IconMore size={16} />
          </button>
          <Popover open={menu} onClose={() => setMenu(false)}>
            <MenuItem
              onClick={() => {
                toggleFavorite(st)
                setMenu(false)
              }}
            >
              <IconHeart size={15} filled={favorite} /> {favorite ? t('menu.unfav') : t('menu.fav')}
            </MenuItem>
            {st.homepage && (
              <MenuItem
                onClick={() => {
                  window.open(st.homepage, '_blank', 'noopener,noreferrer')
                  setMenu(false)
                }}
              >
                <IconExternal size={15} /> {t('menu.homepage')}
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                void navigator.clipboard?.writeText(shareUrl(st.id, st.country)).then(() => useUI.getState().showToast(t('toast.copied')))
                setMenu(false)
              }}
            >
              <IconLink size={15} /> {t('menu.share')}
            </MenuItem>
          </Popover>
        </div>
      </div>
    </div>
  )
})
