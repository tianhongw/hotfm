import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'
import { formatFreq } from '../lib/dial'
import { seek, togglePlay } from '../player/controller'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'
import { IconChevron, IconPlay, IconStop } from './Icons'
import { Logo } from './Logo'
import { Transport } from './Transport'
import { TunerPanel } from './TunerPanel'
import { VfdDisplay } from './VfdDisplay'
import { VolumeKnob } from './VolumeKnob'
import s from './MobilePlayer.module.css'

/** Bottom bar on phones; tap to open the full player sheet. */
export function MiniPlayer() {
  const t = useT()
  const { station, status, title } = usePlayer()
  const setSheet = useUI((u) => u.setSheetOpen)
  const active = status === 'playing' || status === 'connecting' || status === 'buffering'
  return (
    <div className={s.mini}>
      <button className={s.miniMain} onClick={() => setSheet(true)} aria-label={t('mini.expand')}>
        {station ? <Logo src={station.logo} name={station.name} size={40} /> : <span className={s.miniBlank} />}
        <span className={s.miniText}>
          <span className={s.miniName}>{station?.name ?? t('display.noStation')}</span>
          <span className={s.miniSub}>
            {station && <span className={s.miniFreq}>{station.freq != null ? `${formatFreq(station.freq)} MHz` : 'NET'}</span>}
            {status === 'playing' && title ? title : status !== 'idle' && status !== 'playing' ? t(`status.${status}`) : ''}
          </span>
        </span>
      </button>
      <button
        className={s.miniPlay}
        data-active={active || undefined}
        onClick={() => togglePlay()}
        aria-label={active ? t('transport.stop') : t('transport.play')}
      >
        {active ? <IconStop size={20} /> : <IconPlay size={22} />}
      </button>
    </div>
  )
}

/** Full-screen player: swipe the display sideways to seek, pull the handle down to close. */
export function PlayerSheet() {
  const t = useT()
  const open = useUI((u) => u.sheetOpen)
  const setOpen = useUI((u) => u.setSheetOpen)
  const sheet = useRef<HTMLDivElement>(null)
  const pull = useRef<{ y: number; dy: number } | null>(null)
  const swipe = useRef<{ x: number; y: number } | null>(null)

  if (!open) return null
  return createPortal(
    <div className={s.backdrop}>
      <div ref={sheet} className={s.sheet} role="dialog" aria-modal="true" aria-label="Player">
        <div
          className={s.handle}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            pull.current = { y: e.clientY, dy: 0 }
          }}
          onPointerMove={(e) => {
            if (!pull.current || !sheet.current) return
            pull.current.dy = Math.max(0, e.clientY - pull.current.y)
            sheet.current.style.transform = `translateY(${pull.current.dy}px)`
          }}
          onPointerUp={() => {
            const dy = pull.current?.dy ?? 0
            pull.current = null
            if (sheet.current) sheet.current.style.transform = ''
            if (dy > 90) setOpen(false)
          }}
        >
          <span />
          <button onClick={() => setOpen(false)} aria-label={t('sheet.close')} className={s.close}>
            <IconChevron size={20} />
          </button>
        </div>
        <div
          className={s.swipeArea}
          onPointerDown={(e) => (swipe.current = { x: e.clientX, y: e.clientY })}
          onPointerUp={(e) => {
            const st = swipe.current
            swipe.current = null
            if (!st) return
            const dx = e.clientX - st.x
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - st.y) * 1.5) seek(dx < 0 ? 1 : -1)
          }}
        >
          <VfdDisplay compact />
        </div>
        <TunerPanel compact />
        <div className={s.controls}>
          <Transport compact />
          <VolumeKnob size={64} />
        </div>
      </div>
    </div>,
    document.body,
  )
}
