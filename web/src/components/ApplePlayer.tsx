import { useCallback, useEffect } from 'react'
import { useDial } from '../api/hooks'
import { useIsMobile } from '../hooks/useMediaQuery'
import { useT } from '../i18n'
import { formatFreq } from '../lib/dial'
import { seek, setSleep, toggleFavorite, togglePlay } from '../player/controller'
import { isEnglish } from '../capture/session'
import { latestText, useCapture } from '../stores/capture'
import { useLibrary } from '../stores/library'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'
import { CaptureButtons } from './CaptureButtons'
import { Dialog } from './Dialog'
import { IconChevron, IconClose, IconHeart, IconPlay, IconSeekNext, IconSeekPrev, IconSpeaker, IconStop, IconWave } from './Icons'
import { Logo } from './Logo'
import { TunerPanel } from './TunerPanel'
import s from './ApplePlayer.module.css'

export function ApplePlayer() {
  const t = useT()
  const { station, status, title, sleepUntil } = usePlayer()
  const { volume, muted, setVolume, setMuted, favorites } = useLibrary()
  const { country, region, sheetOpen, setSheetOpen, dialOpen, setDialOpen } = useUI()
  const mobile = useIsMobile()
  const dial = useDial(country, region)
  const active = status === 'playing' || status === 'connecting' || status === 'buffering'
  const favorite = !!station && favorites.some((f) => f.id === station.id)
  const canSeek = !!dial.data?.slots.length
  // While captions run, the bar shows the latest line instead of the stream title.
  const caption = useCapture((c) =>
    c.captionsOn && status === 'playing' && isEnglish(station) ? (c.interim?.text ?? latestText(c.segments)?.text) : undefined,
  )
  const close = useCallback(() => {
    setSheetOpen(false)
    setDialOpen(false)
  }, [setSheetOpen, setDialOpen])
  useEffect(() => {
    if (dialOpen) setSheetOpen(true)
  }, [dialOpen, setSheetOpen])
  const description =
    status === 'playing'
      ? title || t('player.live')
      : status === 'idle'
        ? station
          ? t('player.paused')
          : t('player.hint')
        : t(`player.${status}`)
  const controls = (
    <div className={s.controls}>
      <button onClick={() => seek(-1)} disabled={!canSeek} aria-label={t('transport.seekPrev')}>
        <IconSeekPrev size={22} />
      </button>
      <button
        className={s.play}
        onClick={togglePlay}
        disabled={!station && !canSeek}
        aria-label={active ? t('transport.stop') : status === 'error' ? t('display.retry') : t('transport.play')}
      >
        {active ? <IconStop size={23} /> : <IconPlay size={25} />}
      </button>
      <button onClick={() => seek(1)} disabled={!canSeek} aria-label={t('transport.seekNext')}>
        <IconSeekNext size={22} />
      </button>
    </div>
  )
  const volumeControl = (
    <div className={s.volume}>
      <button onClick={() => setMuted(!muted)} aria-label={t('transport.mute')} aria-pressed={muted}>
        <IconSpeaker size={19} muted={muted} />
      </button>
      <input
        type="range"
        min="0"
        max="100"
        value={muted ? 0 : Math.round(volume * 100)}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
        aria-label={t('transport.volume')}
      />
    </div>
  )
  return (
    <>
      <section className={s.bar} aria-label={t('player.title')}>
        <div className={s.barInner}>
          <button className={s.station} onClick={() => setSheetOpen(true)} aria-label={t('player.details')}>
            {station ? (
              <Logo src={station.logo} name={station.name} size={48} />
            ) : (
              <span className={s.blank}>
                <IconWave size={25} />
              </span>
            )}
            <span className={s.text}>
              <strong>{station?.name ?? t('player.ready')}</strong>
              <span data-caption={caption ? true : undefined}>
                <i data-live={status === 'playing' || undefined} />
                {caption ?? description}
              </span>
            </span>
          </button>
          {controls}
          <div className={s.right}>
            <CaptureButtons />
            <button
              className={s.favorite}
              disabled={!station}
              aria-label={favorite ? t('transport.unfav') : t('transport.fav')}
              aria-pressed={favorite}
              onClick={() => toggleFavorite()}
            >
              <IconHeart size={21} filled={favorite} />
            </button>
            {volumeControl}
            <button className={s.details} onClick={() => setSheetOpen(true)} aria-label={t('player.details')} title={t('player.details')}>
              <IconChevron size={18} />
            </button>
          </div>
        </div>
      </section>
      <Dialog open={sheetOpen} onClose={close} label={t('player.title')} variant={mobile ? 'sheet' : 'center'}>
        <div className={s.sheet}>
          <div className={s.sheetHead}>
            <span>{t('player.title')}</span>
            <button onClick={close} aria-label={t('sheet.close')}>
              <IconClose size={19} />
            </button>
          </div>
          <div className={s.artwork}>{station ? <Logo src={station.logo} name={station.name} size={120} /> : <IconWave size={80} />}</div>
          <div className={s.sheetTitle}>
            <h2>{station?.name ?? t('player.ready')}</h2>
            <button
              disabled={!station}
              aria-label={favorite ? t('transport.unfav') : t('transport.fav')}
              aria-pressed={favorite}
              onClick={() => toggleFavorite()}
            >
              <IconHeart size={22} filled={favorite} />
            </button>
          </div>
          <p className={s.description}>
            {station && (station.freq == null ? t('display.net') : `${formatFreq(station.freq)} MHz`)}
            {station ? ' · ' : ''}
            {description}
          </p>
          {controls}
          <div className={s.sheetVolume}>{volumeControl}</div>
          <div className={s.settings}>
            <label>
              {t('transport.sleep')}
              <select
                aria-label={t('transport.sleep')}
                value={sleepUntil ? 'active' : ''}
                onChange={(e) => setSleep(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">{t('sleep.off')}</option>
                {sleepUntil && (
                  <option value="active" disabled>
                    {t('sleep.left', { n: Math.max(1, Math.ceil((sleepUntil - Date.now()) / 60000)) })}
                  </option>
                )}
                {[15, 30, 60, 90].map((n) => (
                  <option key={n} value={n}>
                    {t('sleep.min', { n })}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => setDialOpen(!dialOpen)} aria-expanded={dialOpen}>
              {t('transport.dial')}
              <IconChevron size={16} />
            </button>
          </div>
          <TunerPanel compact />
        </div>
      </Dialog>
    </>
  )
}
