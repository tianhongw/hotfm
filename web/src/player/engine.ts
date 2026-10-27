import type Hls from 'hls.js'
import type { Station } from '../api/types'
import type { PlayerStatus } from '../stores/player'
import { api } from '../api/client'
import { audioContext, meterCapable } from './audio'
import { classifyFailure, probeStreamFailure, type FailureKind } from './failure'
import { nextTitle, parseId3Title } from './titles'

export type EngineEvent =
  | { type: 'status'; status: PlayerStatus }
  | { type: 'title'; title: string }
  | { type: 'started' } // audio actually started for the current load
  | { type: 'failed'; code: string } // gave up after retries
  | { type: 'handover'; state: 'done' | 'failed'; stationId: string } // moved a live stream onto the proxy, or could not

type Listener = (e: EngineEvent) => void

// hls.js is large; only HLS stations need it.
let hlsModule: Promise<typeof import('hls.js').default> | null = null
const loadHls = () => (hlsModule ??= import('hls.js').then((m) => m.default))

const MAX_RETRIES = 2
const STALL_MS = 15_000
const STABLE_MS = 30_000
/** How long the proxied stream may take to start before the handover is abandoned. */
const HANDOVER_MS = 6000
const HANDOVER_FADE_MS = 300
const HANDOVER_FADE_STEPS = 10

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
  /** Last title emitted for the current load; SSE and ID3 both dedupe against it. */
  private lastTitle = ''
  private analyser: AnalyserNode | null = null
  /** proxiedEl's node in the Web Audio graph; captions and recording tap it before volume. */
  private source: MediaElementAudioSourceNode | null = null
  private gain: GainNode | null = null
  private graphReady = false
  /** Play direct stations through the proxy so the graph can hear them. */
  private preferProxy = false
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
  /** Last status handed to the UI; reconnects key off it. */
  private status: PlayerStatus = 'idle'
  /** True while the network is down; failures then wait instead of burning retries. */
  private offline = false
  /** Elements we paused ourselves; their async 'pause' event must not count as an external pause. */
  private selfPaused = new WeakSet<HTMLAudioElement>()
  /** The proxied element warming up for a handover, and the session it was opened for. */
  private pending: { el: HTMLAudioElement; sid: string; id: number; timer: number } | null = null
  private handoverId = 0
  private handoverTimer: number | undefined
  /** 0..1 level factors for the two elements during warm-up and crossfade. */
  private proxyFade = 1
  private directFade = 1
  /** Station whose warm-up failed; canTap stays false for it until the next start. */
  private handoverFailedFor: string | null = null

  constructor() {
    for (const el of [this.proxiedEl, this.directEl]) {
      el.preload = 'none'
      el.addEventListener('playing', () => {
        if (el === this.el) this.onPlaying()
        else if (el === this.pending?.el) this.handoverReady()
      })
      el.addEventListener('waiting', () => el === this.el && this.onWaiting())
      el.addEventListener('stalled', () => el === this.el && this.onWaiting())
      el.addEventListener('error', () => {
        if (el === this.pending?.el) this.abortHandover('error')
        else if (el === this.el && this.wantPlaying && !this.hls) this.fail('media_error')
      })
      el.addEventListener('ended', () => el === this.el && this.wantPlaying && this.fail('ended'))
      el.addEventListener('pause', () => {
        if (this.selfPaused.has(el)) {
          this.selfPaused.delete(el)
          return
        }
        // Paused by the OS / headset rather than by us.
        if (el === this.el && this.wantPlaying && !el.ended && el.error == null) {
          this.wantPlaying = false
          this.setStatus('paused')
        }
      })
    }
    this.proxiedEl.crossOrigin = 'anonymous'
    // Losing the network is not a station failure: hold the load and wait.
    window.addEventListener('offline', this.onOffline)
    window.addEventListener('online', this.onOnline)
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: EngineEvent) {
    for (const fn of this.listeners) fn(e)
  }

  private setStatus(status: PlayerStatus) {
    this.status = status
    this.emit({ type: 'status', status })
  }

  /** The OS went offline: stop retrying and wait for the network to come back. */
  private onOffline = () => {
    this.offline = true
    if (!this.wantPlaying) return
    window.clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.status !== 'offline') this.setStatus('offline')
  }

  /** Back online after an offline pause: start over with a clean retry budget. */
  private onOnline = () => {
    this.offline = false
    if (!this.wantPlaying || this.status !== 'offline') return
    this.retries = 0
    this.start()
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
      // Volume lives in the gain node so taps get full-level audio even when muted.
      const src = ctx.createMediaElementSource(this.proxiedEl)
      const gain = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      src.connect(gain)
      gain.connect(analyser)
      analyser.connect(ctx.destination)
      this.source = src
      this.gain = gain
      this.analyser = analyser
      this.graphReady = true
      this.applyVolume()
    } catch {
      this.graphReady = true // never retry; playback still works without the meter
    }
  }

  /** True once the graph exists, i.e. proxied audio can be tapped. */
  get capable(): boolean {
    return this.source != null
  }

  /** Feeds the station's audio (pre-volume) into `node`; returns a disconnect function. */
  tap(node: AudioNode): () => void {
    const src = this.source
    if (!src) return () => {}
    src.connect(node)
    return () => {
      try {
        src.disconnect(node)
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Whether a station can be routed through the graph (proxied, or with a proxy fallback). */
  canTap(st: Station): boolean {
    return this.capable && (st.stream.proxied || !!st.stream.proxy) && this.handoverFailedFor !== st.id
  }

  /**
   * Captions and recording need the proxy. Turning it on warms the proxied
   * stream up beside a playing direct station and switches once it plays;
   * turning it off waits for the next start so playback is not interrupted.
   */
  setPreferProxy(v: boolean) {
    if (this.preferProxy === v) return
    this.preferProxy = v
    const st = this.station
    if (!v) {
      this.abortHandover('preference')
      return
    }
    if (!st) return
    const el = this.route(st).el
    if (el === this.el) return
    if (this.wantPlaying && this.el === this.directEl && st.stream.type !== 'hls' && st.stream.proxy) {
      // The load in flight has not picked its element yet: it will route to the proxy by itself.
      if (this.status === 'connecting') return
      if (this.status === 'playing' || this.status === 'buffering') {
        this.startHandover(st)
        return
      }
    }
    // HLS and paused/starting loads have nothing to lose: switch outright.
    const playing = this.wantPlaying
    this.teardown()
    this.el = el
    if (playing) {
      this.retries = 0
      this.start()
    }
  }

  private route(st: Station): { el: HTMLAudioElement; url: string; proxied: boolean } {
    if (st.stream.proxied) return { el: this.proxiedEl, url: st.stream.url, proxied: true }
    if (this.preferProxy && this.capable && st.stream.proxy) return { el: this.proxiedEl, url: st.stream.proxy, proxied: true }
    return { el: this.directEl, url: st.stream.url, proxied: false }
  }

  /** Warms up the proxied element muted while the direct one keeps playing; `playing` starts the handover. */
  private startHandover(st: Station) {
    this.cancelPending()
    const el = this.proxiedEl
    const sid = randomId()
    const id = ++this.handoverId
    this.proxyFade = 0
    this.applyVolume()
    el.src = `${st.stream.proxy}?sid=${sid}`
    this.pending = {
      el,
      sid,
      id,
      timer: window.setTimeout(() => {
        if (this.pending?.id === id) this.abortHandover('timeout')
      }, HANDOVER_MS),
    }
    el.play().catch(() => {
      if (this.pending?.id === id) this.abortHandover('error')
    })
  }

  private handoverReady() {
    const p = this.pending
    const st = this.station
    if (!p || !st) return
    window.clearTimeout(p.timer)
    this.pending = null
    this.el = p.el
    this.handoverFailedFor = null
    // ICY metadata now belongs to the proxied session.
    this.meta?.close()
    this.openMeta(st.id, p.sid)
    this.crossfade()
    this.emit({ type: 'handover', state: 'done', stationId: st.id })
  }

  /** ~300 ms crossfade, then the direct element is released. */
  private crossfade() {
    const started = performance.now()
    window.clearInterval(this.handoverTimer)
    this.handoverTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - started) / HANDOVER_FADE_MS)
      this.proxyFade = k
      this.directFade = 1 - k
      this.applyVolume()
      if (k < 1) return
      window.clearInterval(this.handoverTimer)
      this.handoverTimer = undefined
      this.releaseDirect()
    }, HANDOVER_FADE_MS / HANDOVER_FADE_STEPS)
  }

  private releaseDirect() {
    const el = this.directEl
    this.selfPaused.add(el)
    if (!el.paused) el.pause()
    if (el.getAttribute('src') !== null) {
      el.removeAttribute('src')
      el.load()
    }
    this.directFade = 1
    this.proxyFade = 1
    this.applyVolume()
  }

  private cancelPending() {
    const p = this.pending
    this.handoverId++
    if (!p) return
    window.clearTimeout(p.timer)
    this.pending = null
    this.selfPaused.add(p.el)
    if (!p.el.paused) p.el.pause()
    if (p.el.getAttribute('src') !== null) {
      p.el.removeAttribute('src')
      p.el.load()
    }
  }

  /** Drops a warm-up; playback stays where it is, and only timeout/error mark the station as uncapturable. */
  private abortHandover(reason: 'timeout' | 'error' | 'preference' | 'restart') {
    const committed = this.el === this.proxiedEl && this.directEl.getAttribute('src') !== null
    this.cancelPending()
    window.clearInterval(this.handoverTimer)
    this.handoverTimer = undefined
    this.proxyFade = 1
    this.directFade = 1
    this.applyVolume()
    // A crossfade cut short would otherwise leave both streams audible.
    if (committed) this.releaseDirect()
    if (reason !== 'timeout' && reason !== 'error') return
    this.handoverFailedFor = this.station?.id ?? null
    this.emit({ type: 'handover', state: 'failed', stationId: this.handoverFailedFor ?? '' })
  }

  load(station: Station, autoplay = true) {
    this.teardown()
    this.station = station
    this.retries = 0
    this.announced = false
    this.lastTitle = ''
    this.el = this.route(station).el
    if (autoplay) this.start()
    else this.setStatus('idle')
  }

  play() {
    if (!this.station || this.wantPlaying) return
    this.retries = 0
    this.start()
  }

  stop() {
    this.wantPlaying = false
    this.teardown()
    this.setStatus(this.station ? 'paused' : 'idle')
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
    const v = Math.max(0, Math.min(1, this.muted ? 0 : this.volume * this.duck * this.fade))
    this.directEl.volume = v * this.directFade
    if (this.gain) {
      this.proxiedEl.volume = 1
      this.gain.gain.value = v * this.proxyFade
    } else {
      this.proxiedEl.volume = v * this.proxyFade
    }
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
    this.setStatus('connecting')
    // Re-route on every start: the proxy preference may have changed since load.
    const r = this.route(st)
    this.el = r.el
    const el = this.el
    const sid = randomId()

    if (st.stream.type === 'hls') {
      void this.startHls(st, el, this.generation)
      return
    }
    el.src = r.proxied ? `${r.url}?sid=${sid}` : r.url
    // Proxied audio carries ICY titles through our own relay; direct audio is
    // read by a shared server-side watcher instead.
    if (r.proxied) this.openMeta(st.id, sid)
    else this.openNowPlaying(st.id)
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
      if (data.fatal && this.hls === hls) this.fail('hls_' + data.type, data.response?.code || undefined)
    })
    // Radio titles travel as ID3 timed metadata inside the stream.
    hls.on(HlsCtor.Events.FRAG_PARSING_METADATA, (_e, data) => {
      if (this.hls !== hls) return
      for (const sample of data.samples) {
        if (sample.type !== HlsCtor.MetadataSchema.audioId3) continue
        const title = parseId3Title(sample.data)
        if (title) this.emitTitle(title)
      }
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
        this.setStatus('paused')
      } else if (err.name !== 'AbortError' && this.wantPlaying) {
        this.fail('play_' + err.name)
      }
    })
  }

  private openMeta(id: string, sid: string) {
    this.titleSource(api.metaURL(id, sid))
  }

  /** Direct streams get shared, station-wide titles from the server (one upstream per station). */
  private openNowPlaying(id: string) {
    const es = this.titleSource(api.nowPlayingURL(id))
    // A non-200 answer fails an EventSource permanently (e.g. 429 watcher
    // capacity), so there is no retry storm; the "Live now" fallback stays.
    es.addEventListener('error', () => {
      if (es.readyState !== EventSource.CLOSED) return
      es.close()
      if (this.meta === es) this.meta = null
    })
  }

  /** Opens a title SSE stream through emitTitle and remembers it for teardown. */
  private titleSource(url: string): EventSource {
    const es = new EventSource(url)
    es.addEventListener('title', (e) => {
      if (this.meta !== es) return
      try {
        const { title } = JSON.parse((e as MessageEvent<string>).data) as { title: string }
        this.emitTitle(title)
      } catch {
        /* ignore malformed event */
      }
    })
    this.meta = es
    return es
  }

  /** Emits a title unless it repeats the last one for this load. */
  private emitTitle(raw: string) {
    const title = nextTitle(this.lastTitle, raw)
    if (title == null) return
    this.lastTitle = title
    this.emit({ type: 'title', title })
  }

  private onPlaying() {
    window.clearTimeout(this.stallTimer)
    this.startedAt = Date.now()
    this.setStatus('playing')
    if (!this.announced) {
      this.announced = true
      this.emit({ type: 'started' })
    }
  }

  private onWaiting() {
    if (!this.wantPlaying) return
    this.setStatus('buffering')
    this.armStallTimer()
  }

  private armStallTimer() {
    window.clearTimeout(this.stallTimer)
    this.stallTimer = window.setTimeout(() => this.wantPlaying && this.fail('stalled'), STALL_MS)
  }

  private fail(_code: string, httpStatus?: number) {
    if (!this.wantPlaying) return
    // No network is not the station's fault: hold the load until 'online' fires.
    if (this.offline || navigator.onLine === false) {
      this.offline = true
      this.teardown()
      this.setStatus('offline')
      return
    }
    this.teardown()
    const gen = this.generation
    if (this.startedAt && Date.now() - this.startedAt > STABLE_MS) this.retries = 0
    this.startedAt = 0
    if (this.retries < MAX_RETRIES) {
      this.retries++
      this.setStatus('connecting')
      this.retryTimer = window.setTimeout(() => this.wantPlaying && this.start(), 1000 * 2 ** this.retries)
      return
    }
    this.wantPlaying = false
    this.setStatus('error')
    const st = this.station
    void this.probeFailure(st, httpStatus).then((kind) => {
      // The listener may have tuned elsewhere while the probe ran.
      if (gen !== this.generation) return
      this.emit({ type: 'failed', code: kind })
    })
  }

  /**
   * Works out why the load failed without downloading audio again: a proxied
   * stream is probed for its status and JSON error code, HLS reports its HTTP
   * status through hls.js, and direct streams hide it behind CORS.
   */
  private async probeFailure(st: Station | null, httpStatus?: number): Promise<FailureKind> {
    if (!st) return 'generic'
    if (st.stream.type === 'hls') return classifyFailure(httpStatus ?? null, null)
    const r = this.route(st)
    if (!r.proxied) return 'generic'
    const probe = await probeStreamFailure(r.url)
    return classifyFailure(probe.status, probe.code)
  }

  /** Releases network resources without changing wantPlaying. */
  private teardown() {
    this.generation++
    this.cancelPending()
    window.clearInterval(this.handoverTimer)
    this.handoverTimer = undefined
    this.proxyFade = 1
    this.directFade = 1
    this.handoverFailedFor = null
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
