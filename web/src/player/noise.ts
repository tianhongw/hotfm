import { audioContext } from './audio'

/**
 * Band-limited white noise that imitates the hiss between FM stations.
 * The level follows the dial position while the listener is tuning.
 */
class TuningNoise {
  private gain: GainNode | null = null
  private started = false

  private ensure(): GainNode | null {
    if (this.gain) return this.gain
    const ctx = audioContext()
    if (!ctx) return null
    const seconds = 2
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate)
    const data = buf.getChannelData(0)
    // Lightly smoothed noise sounds closer to FM hiss than raw white noise.
    let last = 0
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1
      last = 0.82 * last + 0.18 * white
      data[i] = last * 2.6 + white * 0.25
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 280
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 5200
    const gain = ctx.createGain()
    gain.gain.value = 0
    src.connect(hp).connect(lp).connect(gain).connect(ctx.destination)
    src.start()
    this.started = true
    this.gain = gain
    return gain
  }

  /** level 0..1, scaled by the master volume. */
  setLevel(level: number, volume: number) {
    if (level <= 0 && !this.started) return
    const g = this.ensure()
    if (!g) return
    const ctx = g.context
    g.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.16 * volume, ctx.currentTime, 0.04)
  }
}

export const tuningNoise = new TuningNoise()
