import { useEffect, useRef } from 'react'
import { meterCapable } from '../player/audio'
import { engine } from '../player/engine'
import { nearestSlot, noiseLevel } from '../lib/dial'
import { currentSlots } from '../player/tuning'
import { usePlayer, useTuner } from '../stores/player'
import s from './SignalMeter.module.css'

const SIGNAL_SEGS = 12
const LEVEL_SEGS = 16

/**
 * SIGNAL shows how well the tuner is locked onto a station (like the
 * signal-strength meter on a receiver). LEVEL is the real audio level from
 * the Web Audio analyser, shown only where the analyser is available.
 */
export function SignalMeter() {
  const sig = useRef<HTMLSpanElement[]>([])
  const lvl = useRef<HTMLSpanElement[]>([])

  useEffect(() => {
    let raf = 0
    let sweep = 0
    let shownLevel = 0
    const bins = new Uint8Array(256)
    const paint = (els: HTMLSpanElement[], n: number) => {
      for (let i = 0; i < els.length; i++) {
        const on = i < n
        const el = els[i]!
        if ((el.dataset.on === '1') !== on) el.dataset.on = on ? '1' : ''
      }
    }
    const frame = () => {
      const { tuning, freq } = useTuner.getState()
      const { status, station } = usePlayer.getState()
      let signal = 0
      if (tuning) {
        const near = nearestSlot(currentSlots(), freq)
        signal = 1 - noiseLevel(near?.dist ?? Infinity)
      } else if (status === 'playing') {
        signal = station?.health === 'flaky' ? 0.62 : 0.92
      } else if (status === 'connecting' || status === 'buffering') {
        sweep = (sweep + 0.025) % 1
        signal = 0.15 + 0.35 * Math.abs(Math.sin(sweep * Math.PI))
      }
      paint(sig.current, Math.round(signal * SIGNAL_SEGS))

      let level = 0
      if (engine.levels(bins)) {
        let sum = 0
        for (let i = 2; i < 96; i++) sum += bins[i]!
        level = Math.min(1, (sum / 94 / 255) * 1.8)
      }
      // Fast attack, slow release, like a VU ballistic.
      shownLevel = level > shownLevel ? level : shownLevel * 0.9 + level * 0.1
      paint(lvl.current, Math.round(shownLevel * LEVEL_SEGS))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className={s.meter} aria-hidden>
      <div className={s.row}>
        <span className="silk">Signal</span>
        <span className={s.segs}>
          {Array.from({ length: SIGNAL_SEGS }, (_, i) => (
            <span key={i} ref={(el) => void (el && (sig.current[i] = el))} className={s.seg} data-hot={i >= SIGNAL_SEGS - 2 || undefined} />
          ))}
        </span>
      </div>
      {meterCapable && (
        <div className={s.row}>
          <span className="silk">Level</span>
          <span className={s.segs}>
            {Array.from({ length: LEVEL_SEGS }, (_, i) => (
              <span
                key={i}
                ref={(el) => void (el && (lvl.current[i] = el))}
                className={`${s.seg} ${s.thin}`}
                data-hot={i >= LEVEL_SEGS - 3 || undefined}
              />
            ))}
          </span>
        </div>
      )}
    </div>
  )
}
