import { useTuner } from '../stores/player'

let raf = 0

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Animates the dial needle to `target` MHz (ease-out), like a motorised tuner. */
export function glideTo(target: number, ms = 420) {
  cancelAnimationFrame(raf)
  const from = useTuner.getState().freq
  if (reducedMotion() || Math.abs(target - from) < 0.01) {
    useTuner.getState().set({ freq: target })
    return
  }
  const dur = Math.min(900, ms + Math.abs(target - from) * 18)
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / dur)
    const e = 1 - Math.pow(1 - t, 3)
    useTuner.getState().set({ freq: from + (target - from) * e })
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

export function cancelGlide() {
  cancelAnimationFrame(raf)
}
