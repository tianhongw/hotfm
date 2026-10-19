import { useEffect, useRef } from 'react'
import { useT } from '../i18n'
import { useLibrary } from '../stores/library'
import { IconSpeaker } from './Icons'
import s from './VolumeKnob.module.css'

const MIN_ANGLE = -135
const MAX_ANGLE = 135
const DEFAULT = 0.7

function arcPath(r: number, from: number, to: number) {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180
  const p = (a: number) => [50 + r * Math.cos(rad(a)), 50 + r * Math.sin(rad(a))]
  const [x1, y1] = p(from)
  const [x2, y2] = p(to)
  const large = to - from > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

/** Rotary volume knob: drag up/down, scroll, arrow keys; double-click resets. */
export function VolumeKnob({ size = 76 }: { size?: number }) {
  const t = useT()
  const volume = useLibrary((l) => l.volume)
  const muted = useLibrary((l) => l.muted)
  const setVolume = useLibrary((l) => l.setVolume)
  const setMuted = useLibrary((l) => l.setMuted)
  const knob = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; v: number } | null>(null)

  const shown = muted ? 0 : volume
  const angle = MIN_ANGLE + shown * (MAX_ANGLE - MIN_ANGLE)

  useEffect(() => {
    const el = knob.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const lib = useLibrary.getState()
      lib.setVolume(lib.volume - Math.sign(e.deltaY) * 0.04)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div className={s.wrap}>
      <div
        ref={knob}
        className={s.knob}
        style={{ width: size, height: size }}
        role="slider"
        tabIndex={0}
        aria-label={t('transport.volume')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, v: volume }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          setVolume(drag.current.v + (drag.current.y - e.clientY) / 160)
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setVolume(DEFAULT)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.05
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setVolume(volume + step)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setVolume(volume - step)
          else return
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <svg viewBox="0 0 100 100" className={s.ring} aria-hidden>
          <path d={arcPath(46, MIN_ANGLE, MAX_ANGLE)} className={s.track} />
          {shown > 0.005 && <path d={arcPath(46, MIN_ANGLE, angle)} className={s.level} />}
        </svg>
        <div className={s.cap} style={{ transform: `rotate(${angle}deg)` }}>
          <span className={s.notch} />
        </div>
      </div>
      <button
        className={s.mute}
        onClick={() => setMuted(!muted)}
        aria-label={t('transport.mute')}
        aria-pressed={muted}
        title={`${t('transport.mute')} (M)`}
      >
        <IconSpeaker size={15} muted={muted} />
        <span className={s.value}>{Math.round(shown * 100)}</span>
      </button>
    </div>
  )
}
