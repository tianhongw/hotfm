import { useState } from 'react'
import { useT } from '../i18n'
import { seek, setSleep, toggleFavorite, togglePlay } from '../player/controller'
import { useLibrary } from '../stores/library'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'
import { IconDial, IconHeart, IconMoon, IconPlay, IconSeekNext, IconSeekPrev, IconStop } from './Icons'
import { MenuItem, Popover } from './Popover'
import s from './Transport.module.css'

const SLEEP_OPTIONS = [15, 30, 60, 90]

export function Transport({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const status = usePlayer((p) => p.status)
  const station = usePlayer((p) => p.station)
  const sleepUntil = usePlayer((p) => p.sleepUntil)
  const isFav = useLibrary((l) => (station ? l.favorites.some((f) => f.id === station.id) : false))
  const dialOpen = useUI((u) => u.dialOpen)
  const setDialOpen = useUI((u) => u.setDialOpen)
  const [sleepOpen, setSleepOpen] = useState(false)

  const active = status === 'playing' || status === 'connecting' || status === 'buffering'

  return (
    <div className={s.transport} data-compact={compact || undefined}>
      <div className={s.main}>
        <button className={s.key} onClick={() => seek(-1)} aria-label={t('transport.seekPrev')} title={`${t('transport.seekPrev')} (Shift+←)`}>
          <IconSeekPrev size={18} />
          <span className="silk">Seek</span>
        </button>
        <button
          className={s.power}
          data-active={active || undefined}
          onClick={() => togglePlay()}
          aria-label={active ? t('transport.stop') : t('transport.play')}
          title={`${active ? t('transport.stop') : t('transport.play')} (Space)`}
        >
          {active ? <IconStop size={26} /> : <IconPlay size={28} />}
        </button>
        <button className={s.key} onClick={() => seek(1)} aria-label={t('transport.seekNext')} title={`${t('transport.seekNext')} (Shift+→)`}>
          <IconSeekNext size={18} />
          <span className="silk">Seek</span>
        </button>
      </div>
      <div className={s.aux}>
        <button
          className={s.small}
          data-on={isFav || undefined}
          disabled={!station}
          onClick={() => toggleFavorite()}
          aria-pressed={isFav}
          aria-label={isFav ? t('transport.unfav') : t('transport.fav')}
          title={`${isFav ? t('transport.unfav') : t('transport.fav')} (F)`}
        >
          <IconHeart size={17} filled={isFav} />
        </button>
        <div className={s.anchor}>
          <button
            className={s.small}
            data-on={sleepUntil != null || undefined}
            onClick={() => setSleepOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={sleepOpen}
            aria-label={t('transport.sleep')}
            title={t('transport.sleep')}
          >
            <IconMoon size={17} />
          </button>
          <Popover open={sleepOpen} onClose={() => setSleepOpen(false)} align="center" placement={compact ? 'top' : 'bottom'}>
            <div className={`silk ${s.menuTitle}`}>{t('transport.sleep')}</div>
            {SLEEP_OPTIONS.map((m) => (
              <MenuItem
                key={m}
                onClick={() => {
                  setSleep(m)
                  setSleepOpen(false)
                }}
              >
                {t('sleep.min', { n: m })}
              </MenuItem>
            ))}
            {sleepUntil != null && (
              <MenuItem
                onClick={() => {
                  setSleep(null)
                  setSleepOpen(false)
                }}
              >
                {t('sleep.off')}
              </MenuItem>
            )}
          </Popover>
        </div>
        <button
          className={s.small}
          data-on={dialOpen || undefined}
          onClick={() => setDialOpen(!dialOpen)}
          aria-expanded={dialOpen}
          aria-label={t('transport.dial')}
          title={`${t('transport.dial')} (T)`}
        >
          <IconDial size={17} />
        </button>
      </div>
    </div>
  )
}
