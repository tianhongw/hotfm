import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDial } from '../api/hooks'
import type { DialSlot } from '../api/types'
import { useT } from '../i18n'
import { FM_MAX, FM_MIN, FM_SPAN, clampFreq, formatFreq, freqToRatio, nearestSlot } from '../lib/dial'
import { seek } from '../player/controller'
import { beginTuning, endTuning, nudge, updateTuning } from '../player/tuning'
import { usePlayer, useTuner } from '../stores/player'
import { useUI } from '../stores/ui'
import s from './TuningDial.module.css'

const PAD = 22
const HEIGHT = 112
const SCALE_Y = 52

interface Geometry {
  width: number // scale width in px
  inner: number
}

const xOf = (g: Geometry, f: number) => PAD + freqToRatio(f) * g.inner

/** Printed scale: ticks every 0.2 MHz, longer every 1 MHz, numbers every 2 MHz. */
const Scale = memo(function Scale({ g }: { g: Geometry }) {
  const ticks: JSX.Element[] = []
  for (let i = 0; i <= 205; i += 1) {
    const f = FM_MIN + i / 10
    const tenth = Math.round(f * 10)
    if (tenth % 2 !== 0 && tenth % 10 !== 5) continue
    const whole = tenth % 10 === 0
    const h = whole ? 16 : tenth % 10 === 5 ? 10 : 6
    const x = xOf(g, f)
    ticks.push(<line key={i} x1={x} x2={x} y1={SCALE_Y} y2={SCALE_Y + h} className={whole ? s.tickMajor : s.tick} />)
    if (whole && (tenth / 10) % 2 === 0) {
      ticks.push(
        <text key={'l' + i} x={x} y={SCALE_Y + 34} className={s.label} textAnchor="middle">
          {tenth / 10}
        </text>,
      )
    }
  }
  return (
    <svg className={s.scale} width={g.width} height={HEIGHT} aria-hidden>
      <line x1={PAD} x2={g.width - PAD} y1={SCALE_Y} y2={SCALE_Y} className={s.baseline} />
      {ticks}
      <text x={PAD - 4} y={SCALE_Y - 6} className={s.mhz}>
        MHz
      </text>
    </svg>
  )
})

/** Station markers above the scale; taller bars mean more stations share the frequency. */
const Markers = memo(function Markers({ g, slots, currentFreq }: { g: Geometry; slots: DialSlot[]; currentFreq: number | null }) {
  return (
    <div className={s.markers} aria-hidden>
      {slots.map((slot) => {
        const h = 8 + Math.min(slot.total, 8) * 2.6
        const flaky = slot.stations.every((st) => st.health === 'flaky')
        const on = currentFreq != null && Math.abs(currentFreq - slot.freq) < 0.05
        return (
          <span
            key={slot.freq}
            className={s.marker}
            data-on={on || undefined}
            data-flaky={flaky || undefined}
            style={{ left: xOf(g, slot.freq), height: h }}
          />
        )
      })}
    </div>
  )
})

export function TuningDial({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const country = useUI((u) => u.country)
  const region = useUI((u) => u.region)
  const dial = useDial(country, region)
  const slots = useMemo(() => dial.data?.slots ?? [], [dial.data])
  const freq = useTuner((u) => u.freq)
  const station = usePlayer((p) => p.station)
  const wrap = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setViewport(e!.contentRect.width))
    ro.observe(el)
    setViewport(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // Narrow screens get a wider-than-viewport scale that scrolls under a centred needle.
  const minWidth = compact ? 1180 : 860
  const g = useMemo<Geometry>(() => {
    const width = Math.max(viewport, minWidth)
    return { width, inner: width - PAD * 2 }
  }, [viewport, minWidth])
  const scrolling = g.width > viewport + 1
  const needleX = xOf(g, freq)
  const offset = scrolling ? Math.min(Math.max(needleX - viewport / 2, 0), g.width - viewport) : 0

  // --- pointer: drag like a tuning knob, click to jump, flick for inertia ---
  const drag = useRef<{ x0: number; f0: number; f: number; t0: number; lastT: number; v: number; moved: boolean } | null>(null)
  const inertia = useRef(0)

  const freqAtClientX = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect()
    return clampFreq(FM_MIN + ((clientX - rect.left + offset - PAD) / g.inner) * FM_SPAN)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    cancelAnimationFrame(inertia.current)
    e.currentTarget.setPointerCapture(e.pointerId)
    beginTuning()
    const now = performance.now()
    drag.current = { x0: e.clientX, f0: freq, f: freq, t0: now, lastT: now, v: 0, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) {
      if (e.pointerType === 'mouse') setHover(freqAtClientX(e.clientX))
      return
    }
    const dx = e.clientX - d.x0
    if (Math.abs(dx) > 3) d.moved = true
    if (!d.moved) return
    const f = clampFreq(d.f0 + (scrolling ? -dx : dx) * (FM_SPAN / g.inner))
    const now = performance.now()
    const dt = Math.max(1, now - d.lastT)
    d.v = 0.7 * d.v + 0.3 * ((f - d.f) / dt)
    d.f = f
    d.lastT = now
    updateTuning(f)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      endTuning(freqAtClientX(e.clientX), 0.3)
      return
    }
    let v = performance.now() - d.lastT > 80 ? 0 : d.v
    let f = d.f
    if (Math.abs(v) < 0.0004) {
      endTuning(f)
      return
    }
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      f = clampFreq(f + v * dt)
      v *= Math.pow(0.93, dt / 16)
      updateTuning(f)
      if (Math.abs(v) < 0.0003 || f <= FM_MIN || f >= FM_MAX) endTuning(f)
      else inertia.current = requestAnimationFrame(step)
    }
    inertia.current = requestAnimationFrame(step)
  }

  // --- wheel / trackpad: 0.1 MHz per notch ---
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    let acc = 0
    let timer: number | undefined
    let active = false
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      acc += e.deltaMode === 1 ? delta * 30 : delta
      const steps = Math.trunc(acc / 30)
      if (steps === 0) return
      acc -= steps * 30
      if (!active) {
        beginTuning()
        active = true
      }
      const f = clampFreq(Math.round((useTuner.getState().freq + steps * 0.1) * 10) / 10)
      updateTuning(f)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        active = false
        endTuning(useTuner.getState().freq)
      }, 280)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.clearTimeout(timer)
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const map: Record<string, () => void> = {
      ArrowLeft: () => (e.shiftKey ? seek(-1) : nudge(-0.1)),
      ArrowRight: () => (e.shiftKey ? seek(1) : nudge(0.1)),
      ArrowDown: () => nudge(-0.1),
      ArrowUp: () => nudge(0.1),
      PageDown: () => nudge(-1),
      PageUp: () => nudge(1),
      Home: () => nudge(FM_MIN - freq),
      End: () => nudge(FM_MAX - freq),
    }
    const fn = map[e.key]
    if (fn) {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
  }

  const hovered = hover != null ? nearestSlot(slots, hover) : null
  const tip = hovered && hovered.dist < 0.25 && !drag.current ? hovered.slot : null
  const current = slots.find((sl) => station?.freq != null && Math.abs(sl.freq - station.freq) < 0.05)
  const valueText = `${formatFreq(freq)} MHz${current?.stations[0] ? ' ' + current.stations[0].name : ''}`

  return (
    <div className={s.dial} data-compact={compact || undefined}>
      <div
        ref={wrap}
        className={s.window}
        role="slider"
        tabIndex={0}
        aria-label={t('dial.label')}
        aria-valuemin={FM_MIN}
        aria-valuemax={FM_MAX}
        aria-valuenow={Math.round(freq * 10) / 10}
        aria-valuetext={valueText}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        style={{ height: HEIGHT }}
      >
        <div className={s.track} style={{ width: g.width, transform: `translate3d(${-offset}px,0,0)` }}>
          <Markers g={g} slots={slots} currentFreq={station?.freq ?? null} />
          <Scale g={g} />
          {tip && (
            <div className={s.tip} style={{ left: xOf(g, tip.freq) }}>
              <div className={s.tipFreq}>
                {formatFreq(tip.freq)} <span>MHz</span>
              </div>
              {tip.stations.slice(0, 4).map((st) => (
                <div key={st.id} className={s.tipName}>
                  {st.name}
                  {st.city && <span>{st.city}</span>}
                </div>
              ))}
              {tip.total > 4 && <div className={s.tipMore}>+{tip.total - 4}</div>}
            </div>
          )}
        </div>
        <div className={s.needle} style={{ transform: `translate3d(${needleX - offset}px,0,0)` }} aria-hidden>
          <span className={s.cap} />
        </div>
        {dial.isSuccess && slots.length === 0 && <div className={s.empty}>{t('dial.empty')}</div>}
        <div className={s.edgeL} aria-hidden />
        <div className={s.edgeR} aria-hidden />
      </div>
    </div>
  )
}
