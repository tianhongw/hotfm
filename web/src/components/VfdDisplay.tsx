import { useEffect, useState } from 'react'
import { useDial } from '../api/hooks'
import { useT } from '../i18n'
import { formatFreq, nearestSlot } from '../lib/dial'
import { seek, togglePlay } from '../player/controller'
import { usePlayer, useTuner } from '../stores/player'
import { useUI } from '../stores/ui'
import { Marquee } from './Marquee'
import s from './VfdDisplay.module.css'

/** Text on 14-segment digits with the unlit segments faintly visible. */
function Seg14({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`${s.seg14} ${className ?? ''}`}>
      <span className={s.ghost} aria-hidden>
        {'~'.repeat(text.length)}
      </span>
      <span className={s.lit}>{text}</span>
    </span>
  )
}

function useMinutesLeft(until: number | null): number | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!until) return
    const id = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [until])
  return until ? Math.max(1, Math.ceil((until - now) / 60000)) : null
}

export function VfdDisplay({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const { station, status, title } = usePlayer()
  const sleepUntil = usePlayer((p) => p.sleepUntil)
  const { freq, tuning } = useTuner()
  const country = useUI((u) => u.country)
  const region = useUI((u) => u.region)
  const dial = useDial(country, region)
  const sleepLeft = useMinutesLeft(sleepUntil)

  // While tuning, the display follows the needle and previews what is under it.
  const near = tuning ? nearestSlot(dial.data?.slots ?? [], freq) : null
  const preview = near && near.dist < 0.051 ? near.slot : null
  const showFreq = tuning || !station ? freq : station.freq
  const isNet = !tuning && station != null && station.freq == null

  const statusText = tuning && !preview ? t('status.searching') : t(`status.${status}` as const)
  const statusKind = tuning && !preview ? 'searching' : status

  const name = tuning ? (preview?.stations[0]?.name ?? '') : (station?.name ?? '')
  const extra = tuning && preview && preview.total > 1 ? ` +${preview.total - 1}` : ''
  const place = tuning
    ? (preview?.stations[0]?.city ?? '')
    : station
      ? [station.city, station.region.key !== 'other' ? station.region.name : ''].filter(Boolean).join(' · ')
      : ''

  return (
    <section className={s.display} data-compact={compact || undefined} aria-live="polite" aria-label="Display">
      <div className={s.scan} aria-hidden />
      <header className={s.top}>
        <div className={s.chips}>
          <span className={s.chip} data-on={!isNet || undefined}>
            FM
          </span>
          <span className={s.chip} data-on={isNet || undefined}>
            NET
          </span>
          {station && !tuning && (
            <span className={s.codec}>
              {station.stream.type === 'hls' ? 'HLS' : station.codec || 'AUDIO'}
              {station.bitrate > 0 && ` ${station.bitrate}K`}
            </span>
          )}
        </div>
        <div className={s.status} data-kind={statusKind}>
          {sleepLeft != null && <Seg14 text={`SLP ${sleepLeft}`} className={s.sleep} />}
          {statusKind === 'playing' && <span className={s.liveDot} aria-hidden />}
          <Seg14 text={statusText.toUpperCase()} />
        </div>
      </header>

      <div className={s.freqRow}>
        {isNet ? (
          <span className={s.netBig}>
            <span className={s.ghost} aria-hidden>
              ~~~
            </span>
            <span className={s.lit}>NET</span>
          </span>
        ) : (
          <span className={s.freq} aria-label={`${formatFreq(showFreq ?? freq)} MHz`}>
            <span className={s.ghost} aria-hidden>
              888.8
            </span>
            <span className={s.lit}>{formatFreq(showFreq ?? freq, true)}</span>
          </span>
        )}
        <span className={s.unit}>{isNet ? t('display.net') : 'MHz'}</span>
      </div>

      <div className={s.info}>
        {name ? (
          <div className={s.name} data-preview={tuning || undefined}>
            <Marquee>
              {name}
              {extra && <span className={s.extra}>{extra}</span>}
            </Marquee>
          </div>
        ) : (
          <div className={s.placeholder}>{tuning ? '' : t('display.noStation')}</div>
        )}
        <div className={s.meta}>
          {place && <span>{place}</span>}
          {!tuning &&
            station?.tags.slice(0, 3).map((tag) => (
              <span key={tag} className={s.tag}>
                {tag}
              </span>
            ))}
        </div>
        {!tuning && title && status === 'playing' && (
          <Marquee className={s.now}>
            <span className={s.note} aria-hidden>
              ♪
            </span>
            {title}
          </Marquee>
        )}
        {!tuning && status === 'error' && (
          <div className={s.errorActions}>
            <button onClick={() => togglePlay()}>{t('display.retry')}</button>
            <button onClick={() => seek(1)}>{t('display.next')}</button>
          </div>
        )}
      </div>
    </section>
  )
}
