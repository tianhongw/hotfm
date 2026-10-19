// Dial interaction model shared by pointer, wheel and keyboard tuning.
//
// While the listener tunes, static rises between stations and the current
// station fades as the needle leaves it. On release the needle snaps to a
// nearby station; if none is close it rests on "SEARCHING" briefly and then
// auto-locks onto the nearest station, like a digital tuner.
import type { Dial, DialSlot } from '../api/types'
import { cancelGlide, glideTo } from '../lib/glide'
import { nearestSlot, noiseLevel, roundFreq, slotAt, snapTarget } from '../lib/dial'
import { useLibrary } from '../stores/library'
import { usePlayer, useTuner } from '../stores/player'
import { useUI } from '../stores/ui'
import { playSlot, queryClient } from './controller'
import { engine } from './engine'
import { tuningNoise } from './noise'

const SETTLE_MS = 380
const AUTO_LOCK_MS = 1200

let settleTimer: number | undefined
let lockTimer: number | undefined

export function currentSlots(): DialSlot[] {
  const { country, region } = useUI.getState()
  return queryClient.getQueryData<Dial>(['dial', country, region])?.slots ?? []
}

export function initTuning() {
  useTuner.subscribe((s, prev) => {
    if (!s.tuning || s.freq === prev.freq) return
    const { noise, volume, muted } = useLibrary.getState()
    const near = nearestSlot(currentSlots(), s.freq)
    tuningNoise.setLevel(noise && !muted ? noiseLevel(near?.dist ?? Infinity) : 0, volume)
    const st = usePlayer.getState().station
    engine.setDuck(st?.freq != null ? 1 - noiseLevel(Math.abs(s.freq - st.freq)) : 1)
  })
}

export function beginTuning() {
  window.clearTimeout(settleTimer)
  window.clearTimeout(lockTimer)
  cancelGlide()
  engine.unlock()
  useTuner.getState().set({ tuning: true })
}

export function updateTuning(freq: number) {
  useTuner.getState().set({ freq })
}

/** Release the dial at `freq`. radius: how far to look for a station to snap onto. */
export function endTuning(freq: number, radius?: number) {
  window.clearTimeout(settleTimer)
  window.clearTimeout(lockTimer)
  const slots = currentSlots()
  const target = snapTarget(slots, freq, radius)
  const slot = slotAt(slots, target)
  if (slot) {
    glideTo(target, 220)
    settleTimer = window.setTimeout(() => finish(slot), SETTLE_MS)
    return
  }
  useTuner.getState().set({ freq: roundFreq(target) })
  lockTimer = window.setTimeout(() => {
    const near = nearestSlot(currentSlots(), useTuner.getState().freq)
    if (!near) {
      finish(null)
      return
    }
    glideTo(near.slot.freq, 360)
    settleTimer = window.setTimeout(() => finish(near.slot), 480)
  }, AUTO_LOCK_MS)
}

function finish(slot: DialSlot | null) {
  useTuner.getState().set({ tuning: false })
  engine.setDuck(1)
  // Connecting static (if any) is driven by the player status from here on.
  tuningNoise.setLevel(0, useLibrary.getState().volume)
  if (slot) void playSlot(slot)
}

/** Keyboard fine tuning: step the needle by delta MHz. */
export function nudge(delta: number) {
  beginTuning()
  const f = Math.min(108, Math.max(87.5, roundFreq(useTuner.getState().freq + delta)))
  updateTuning(f)
  endTuning(f, 0.05)
}
