import type Hls from 'hls.js'
import type { Station } from '../api/types'
import type { PlayerStatus } from '../stores/player'
import { api } from '../api/client'
import { audioContext, meterCapable } from './audio'

export type EngineEvent =
  | { type: 'status'; status: PlayerStatus }
  | { type: 'title'; title: string }
  | { type: 'started' } // audio actually started for the current load
  | { type: 'failed'; code: string } // gave up after retries

type Listener = (e: EngineEvent) => void

// hls.js is large; only HLS stations need it.
let hlsModule: Promise<typeof import('hls.js').default> | null = null
const loadHls = () => (hlsModule ??= import('hls.js').then((m) => m.default))

const MAX_RETRIES = 2
const STALL_MS = 15_000
const STABLE_MS = 30_000

function randomId(): string {
  const a = new Uint8Array(12)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * UI-independent playback engine: plain audio streams through <audio>, HLS
 * through hls.js (or native HLS on Safari), "now playing" via SSE, automatic
 * reconnects, and an analyser for the level meter. Porting to another
 * platform means re-implementing this class only.
 */
export class PlayerEngine {
  /** Same-origin (proxied) streams; routed through Web Audio for the meter. */
  private proxiedEl = new Audio()
  /** Direct cross-origin streams; never touched by Web Audio (it would be muted by CORS). */
  private directEl = new Audio()
  private el = this.proxiedEl
  private hls: Hls | null = null
  private meta: EventSource | null = null
  private analyser: AnalyserNode | null = null
  private graphReady = false
  private station: Station | null = null
  private listeners = new Set<Listener>()
  private wantPlaying = false
  private retries = 0
  private retryTimer: number | undefined
  private stallTimer: number | undefined
  private startedAt = 0
  private announced = false
  private volume = 0.7
  private muted = false
  private duck = 1
  private fade = 1
  /** Bumped on every teardown so async work from an older load can tell it is stale. */
  private generation = 0
  /** Elements we paused ourselves; their async 'pause' event must not count as an external pause. */
  private selfPaused = new WeakSet<HTMLAudioElement>()

  constructor() {
    for (const el of [this.proxiedEl, this.directEl]) {
      el.preload = 'none'
      el.addEventListener('playing', () => el === this.el && this.onPlaying())
      el.addEventListener('waiting', () => el === this.el && this.onWaiting())
      el.addEventListener('stalled', () => el === this.el && this.onWaiting())
      el.addEventListener('error', () => el === this.el && this.wantPlaying && !this.hls && this.fail('media_error'))
      el.addEventListener('ended', () => el === this.el && this.wantPlaying && this.fail('ended'))
      el.addEventListener('pause', () => {
        if (this.selfPaused.has(el)) {
          this.selfPaused.delete(el)
          return
        }
        // Paused by the OS / headset rather than by us.
        if (el === this.el && this.wantPlaying && !el.ended && el.error == null) {
          this.wantPlaying = false
          this.emit({ type: 'status', status: 'paused' })
        }
      })
    }
    this.proxiedEl.crossOrigin = 'anonymous'
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e)
  }

  get current(): Station | null {
    return this.station
  }

  get playing(): boolean {
    return this.wantPlaying
  }

  /** Call inside a user gesture: unlocks audio and builds the meter graph once. */
  unlock() {
    if (!meterCapable || this.graphReady) return
    const ctx = audioContext()
    if (!ctx) return
    try {
      const src = ctx.createMediaElementSource(this.proxiedEl)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      src.connect(analyser)
      analyser.connect(ctx.destination)
      this.analyser = analyser
      this.graphReady = true
    } catch {
      this.graphReady = true // never retry; playback still works without the meter
    }
  }

  load(station: Station, autoplay = true) {
    this.teardown()
    this.station = station
    this.retries = 0
    this.announced = false
    this.el = station.stream.proxied ? this.proxiedEl : this.directEl
    this.applyVolume()
    if (autoplay) this.start()
    else this.emit({ type: 'status', status: 'idle' })
  }

  play() {
    if (!this.station || this.wantPlaying) return
    this.retries = 0
    this.start()
  }

  stop() {
    this.wantPlaying = false
    this.teardown()
    this.emit({ type: 'status', status: this.station ? 'paused' : 'idle' })
  }

  toggle() {
    if (this.wantPlaying) this.stop()
    else this.play()
  }

  setVolume(v: number, muted: boolean) {
    this.volume = v
    this.muted = muted
    this.applyVolume()
  }

  /** Attenuates the station while the dial moves away from it (0..1). */
  setDuck(factor: number) {
    this.duck = Math.max(0, Math.min(1, factor))
    this.applyVolume()
  }

  /** Sleep-timer fade (0..1). */
  setFade(factor: number) {
    this.fade = Math.max(0, Math.min(1, factor))
    this.applyVolume()
  }

  private applyVolume() {
    const v = this.muted ? 0 : this.volume * this.duck * this.fade
    for (const el of [this.proxiedEl, this.directEl]) el.volume = Math.max(0, Math.min(1, v))
  }

  /** Fills `out` with frequency data; returns false when no meter is available. */
  levels(out: Uint8Array): boolean {
    if (!this.analyser || this.el !== this.proxiedEl || !this.wantPlaying) return false
    this.analyser.getByteFrequencyData(out)
    return true
  }

  private start() {
    const st = this.station
    if (!st) return
    this.teardown()
    this.wantPlaying = true
    this.emit({ type: 'status', status: 'connecting' })
    const el = this.el
    const sid = randomId()

    if (st.stream.type === 'hls') {
      void this.startHls(st, el, this.generation)
      return
    }
    el.src = st.stream.proxied ? `${st.stream.url}?sid=${sid}` : st.stream.url
    if (st.stream.proxied) this.openMeta(st.id, sid)
    this.begin(el)
  }

  private async startHls(st: Station, el: HTMLAudioElement, gen: number) {
    // Safari plays HLS natively; everything else uses hls.js over MSE.
    if (el.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) {
      el.src = st.stream.url
      this.begin(el)
      return
    }
    let HlsCtor: typeof import('hls.js').default
    try {
      HlsCtor = await loadHls()
    } catch {
      if (gen === this.generation) this.fail('hls_load')
      return
    }
    if (gen !== this.generation || !this.wantPlaying) return
    if (!HlsCtor.isSupported()) {
      if (el.canPlayType('application/vnd.apple.mpegurl')) {
        el.src = st.stream.url
        this.begin(el)
      } else this.fail('hls_unsupported')
      return
    }
    const hls = new HlsCtor({
      maxBufferLength: 20,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 3,
      fragLoadingMaxRetry: 3,
    })
    hls.on(HlsCtor.Events.ERROR, (_e, data) => {
      if (data.fatal && this.hls === hls) this.fail('hls_' + data.type)
    })
    hls.loadSource(st.stream.url)
    hls.attachMedia(el)
    this.hls = hls
    this.begin(el)
  }

  private begin(el: HTMLAudioElement) {
    const gen = this.generation
    this.armStallTimer()
    el.play().catch((err: DOMException) => {
      if (gen !== this.generation) return
      if (err.name === 'NotAllowedError') {
        // Autoplay blocked: wait for the listener to press play.
        this.wantPlaying = false
        this.teardown()
        this.emit({ type: 'status', status: 'paused' })
      } else if (err.name !== 'AbortError' && this.wantPlaying) {
        this.fail('play_' + err.name)
      }
    })
  }

  private openMeta(id: string, sid: string) {
    const es = new EventSource(api.metaURL(id, sid))
    es.addEventListener('title', (e) => {
      try {
        const { title } = JSON.parse((e as MessageEvent<string>).data) as { title: string }
        this.emit({ type: 'title', title })
      } catch {
        /* ignore malformed event */
      }
    })
    this.meta = es
  }

  private onPlaying() {
    window.clearTimeout(this.stallTimer)
    this.startedAt = Date.now()
    this.emit({ type: 'status', status: 'playing' })
    if (!this.announced) {
      this.announced = true
      this.emit({ type: 'started' })
    }
  }

  private onWaiting() {
    if (!this.wantPlaying) return
    this.emit({ type: 'status', status: 'buffering' })
    this.armStallTimer()
  }

  private armStallTimer() {
    window.clearTimeout(this.stallTimer)
    this.stallTimer = window.setTimeout(() => this.wantPlaying && this.fail('stalled'), STALL_MS)
  }

  private fail(code: string) {
    if (!this.wantPlaying) return
    this.teardown()
    if (this.startedAt && Date.now() - this.startedAt > STABLE_MS) this.retries = 0
    this.startedAt = 0
    if (this.retries < MAX_RETRIES) {
      this.retries++
      this.emit({ type: 'status', status: 'connecting' })
      this.retryTimer = window.setTimeout(() => this.wantPlaying && this.start(), 1000 * 2 ** this.retries)
      return
    }
    this.wantPlaying = false
    this.emit({ type: 'status', status: 'error' })
    this.emit({ type: 'failed', code })
  }

  /** Releases network resources without changing wantPlaying. */
  private teardown() {
    this.generation++
    window.clearTimeout(this.retryTimer)
    window.clearTimeout(this.stallTimer)
    this.meta?.close()
    this.meta = null
    const els = [this.proxiedEl, this.directEl]
    for (const el of els) {
      if (!el.paused) {
        this.selfPaused.add(el)
        el.pause()
      }
    }
    if (this.hls) {
      const h = this.hls
      this.hls = null
      h.destroy()
    }
    for (const el of els) {
      if (el.getAttribute('src') !== null) {
        el.removeAttribute('src')
        el.load()
      }
    }
  }
}

export const engine = new PlayerEngine()
