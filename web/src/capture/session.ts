// Live captions and recording: taps the player's Web Audio graph, feeds
// Whisper in a worker, records with MediaRecorder, and keeps the stores in sync
// with what is playing.
import fixWebmDuration from 'fix-webm-duration'
import type { Station } from '../api/types'
import { audioContext } from '../player/audio'
import { engine } from '../player/engine'
import { useCapture } from '../stores/capture'
import { usePlayer } from '../stores/player'
import type { AsrRequest, AsrResponse } from './asr'
import { Chunker, cleanText, resample, rms, type Chunk } from './dsp'
import { buildZip, fileBase, inRange, saveFile, toSrt, toTxt } from './export'
import { createPcmTap } from './pcm'

/** Below this level a chunk is treated as silence and not transcribed. */
const SILENCE_RMS = 0.004
/** Utterances waiting while Whisper is busy; older ones are dropped so captions stay live. */
const MAX_QUEUE = 3
/** Utterances from a recording are kept even when Whisper falls behind (≈20 min of speech at 16 kHz). */
const MAX_QUEUE_RECORDING = 120
/** How long a recording download waits for its last utterances to be transcribed. */
const DRAIN_TIMEOUT_MS = 120_000
const ASR_RATE = 16_000
/** How often the unfinished utterance is re-transcribed for an interim caption. */
const INTERIM_MS = { webgpu: 1000, wasm: 2500 }
/** Interim requests also wait this many times the recent inference time, so Whisper never saturates the GPU/CPU. */
const INTERIM_DUTY = 2
/** Interim captions start once this much speech has been heard. */
const INTERIM_MIN_SPEECH_SEC = 0.6
const MAX_RECORDING_MS = 3 * 3600_000

export function isEnglish(st: Station | null): boolean {
  if (!st) return false
  const lang = st.language || ''
  return lang ? /\benglish\b/.test(lang) : st.country === 'US'
}

/** Recording and captions both need the decoded audio, which only the proxied path provides. */
export function canCapture(st: Station | null): boolean {
  return !!st && engine.canTap(st)
}

// --- captions ---

interface Job {
  /** Final jobs become transcript lines; interim ones only preview the utterance in progress. */
  kind: 'final' | 'interim'
  pcm: Float32Array
  /** Audio-clock frame where the utterance starts; ties an interim caption to its final line. */
  frame: number
  at: number
  dur: number
  /** Part of a recording: never dropped, so the downloaded transcript is complete. */
  keep: boolean
}

let worker: Worker | null = null
let jobId = 0
let inflight: (Job & { id: number }) | null = null
let queue: Job[] = []
let lastText = ''
let lastFinalFrame = -1
let interimFrame = -1
let lastInterimAt = 0
/** Smoothed time of one Whisper call, in ms. */
let inferMs = 0
let sentAt = 0
/** Whisper is needed (live captions, or a recording being transcribed); otherwise it is freed once idle. */
let asrWanted = false
let tapping = false
let tapNode: AudioWorkletNode | null = null
let untap: (() => void) | null = null
let chunker: Chunker | null = null

function send(m: AsrRequest, transfer: Transferable[] = []) {
  worker?.postMessage(m, transfer)
}

function ensureWorker() {
  if (worker) return
  const cap = useCapture.getState()
  cap.set({ asr: 'loading', progress: 0, busy: false })
  const w = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<AsrResponse>) => onWorker(e.data)
  w.onerror = () => {
    stopWorker()
    useCapture.getState().set({ asr: 'error' })
  }
  worker = w
  send({ type: 'load' })
}

function stopWorker() {
  worker?.terminate()
  worker = null
  inflight = null
  queue = []
  interimFrame = -1
  useCapture.getState().set({ asr: 'idle', progress: 0, busy: false, interim: null })
}

function onWorker(m: AsrResponse) {
  const cap = useCapture.getState()
  switch (m.type) {
    case 'progress':
      cap.set({ progress: Math.round(m.progress) })
      break
    case 'ready':
      cap.set({ asr: 'ready', backend: m.backend, progress: 100 })
      pump()
      break
    case 'error':
      stopWorker()
      useCapture.getState().set({ asr: 'error' })
      break
    case 'result': {
      const job = inflight
      if (job?.id !== m.id) return
      inflight = null
      const took = performance.now() - sentAt
      inferMs = inferMs ? inferMs * 0.8 + took * 0.2 : took
      if (job.kind === 'final') {
        const text = cleanText(m.text, lastText)
        if (text) {
          lastText = text
          cap.addText(job.at, job.dur, text)
        }
        lastFinalFrame = Math.max(lastFinalFrame, job.frame)
        // The final line replaces the interim caption of the same utterance.
        if (interimFrame !== -1 && interimFrame <= job.frame) {
          interimFrame = -1
          cap.set({ busy: false, interim: null })
        } else {
          cap.set({ busy: false })
        }
      } else if (job.frame > lastFinalFrame) {
        const text = cleanText(m.text)
        if (text) {
          interimFrame = job.frame
          cap.set({ interim: { at: job.at, text } })
        }
      }
      pump()
      if (!asrWanted && !inflight) stopWorker()
      break
    }
  }
}

function pump() {
  if (!worker || inflight || useCapture.getState().asr !== 'ready') return
  const job = queue.shift()
  if (!job) return
  inflight = { ...job, id: ++jobId }
  if (job.kind === 'final') useCapture.getState().set({ busy: true })
  sentAt = performance.now()
  send({ type: 'transcribe', id: inflight.id, pcm: job.pcm, rate: ASR_RATE }, [job.pcm.buffer])
}

function job(kind: Job['kind'], c: Chunk, ctx: AudioContext): Job {
  // Map the audio clock to wall-clock time.
  const dur = (c.pcm.length / ctx.sampleRate) * 1000
  const at = Date.now() - ((ctx.currentTime * ctx.sampleRate - c.frame) / ctx.sampleRate) * 1000
  // Whisper wants 16 kHz; resampling here also keeps a recording's backlog small.
  const pcm = resample(c.pcm, ctx.sampleRate, ASR_RATE)
  return { kind, pcm, frame: c.frame, at, dur, keep: useCapture.getState().rec.state === 'recording' }
}

function onChunk(c: Chunk, ctx: AudioContext) {
  if (rms(c.pcm) < SILENCE_RMS) return
  queue.push(job('final', c, ctx))
  // Drop the oldest live-only utterances first; a recording's are kept up to a hard cap.
  const live = queue.filter((j) => !j.keep)
  while (live.length > MAX_QUEUE) queue.splice(queue.indexOf(live.shift()!), 1)
  while (queue.length > MAX_QUEUE_RECORDING) queue.shift()
  pump()
}

/** Sends the utterance in progress for transcription now (e.g. when a recording stops mid-sentence). */
function flushUtterance() {
  const ctx = audioContext()
  const c = chunker?.flush()
  if (c && ctx) onChunk(c, ctx)
}

/** True while utterances that started before `until` are still waiting for Whisper. */
function transcribing(until: number): boolean {
  return (inflight?.kind === 'final' && inflight.at < until) || queue.some((j) => j.at < until)
}

/** While someone is still talking, re-transcribe the utterance so far whenever Whisper is idle. */
function maybeInterim(ctx: AudioContext) {
  const cap = useCapture.getState()
  if (!worker || !chunker || inflight || queue.length || cap.asr !== 'ready') return
  const now = performance.now()
  if (now - lastInterimAt < Math.max(INTERIM_MS[cap.backend ?? 'wasm'], inferMs * INTERIM_DUTY)) return
  if (chunker.speechSec < INTERIM_MIN_SPEECH_SEC) return
  const c = chunker.peek()
  if (!c || c.frame <= lastFinalFrame || rms(c.pcm) < SILENCE_RMS) return
  lastInterimAt = now
  const j = job('interim', c, ctx)
  inflight = { ...j, id: ++jobId }
  sentAt = now
  send({ type: 'transcribe', id: inflight.id, pcm: j.pcm, rate: ASR_RATE }, [j.pcm.buffer])
}

async function startTap() {
  if (tapping) return
  const ctx = audioContext()
  if (!ctx || !engine.capable) return
  tapping = true
  let node: AudioWorkletNode
  try {
    node = await createPcmTap(ctx, (pcm, frame) => {
      for (const c of chunker?.push(pcm, frame) ?? []) onChunk(c, ctx)
      maybeInterim(ctx)
    })
  } catch {
    tapping = false
    useCapture.getState().set({ asr: 'error' })
    return
  }
  if (!tapping) {
    node.disconnect()
    return
  }
  chunker = new Chunker(ctx.sampleRate)
  tapNode = node
  untap = engine.tap(node)
}

function stopTap() {
  tapping = false
  untap?.()
  untap = null
  tapNode?.disconnect()
  tapNode = null
  chunker = null
  queue = []
  interimFrame = -1
  useCapture.getState().set({ interim: null })
}

// --- recording ---

let recorder: MediaRecorder | null = null
let recCap: number | undefined
let recEndedAt = 0

function recordingFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  const options = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
    { mime: 'audio/mp4', ext: 'm4a' },
  ]
  return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? null
}

export function canRecord(): boolean {
  return recordingFormat() != null
}

export function startRecording(): boolean {
  const { station, status } = usePlayer.getState()
  const fmt = recordingFormat()
  const ctx = audioContext()
  if (!station || !canCapture(station) || !fmt || !ctx || recorder) return false
  if (status !== 'playing' && status !== 'buffering' && status !== 'connecting') return false
  const dest = ctx.createMediaStreamDestination()
  const disconnect = engine.tap(dest)
  let mr: MediaRecorder
  try {
    mr = new MediaRecorder(dest.stream, { mimeType: fmt.mime, audioBitsPerSecond: 96_000 })
  } catch {
    disconnect()
    return false
  }
  const parts: Blob[] = []
  let bytes = 0
  const startedAt = Date.now()
  const withCaptions = isEnglish(station)
  recEndedAt = 0
  mr.ondataavailable = (e) => {
    if (!e.data.size) return
    parts.push(e.data)
    bytes += e.data.size
    const rec = useCapture.getState().rec
    if (rec.state === 'recording') useCapture.getState().set({ rec: { ...rec, bytes } })
  }
  mr.onstop = () => {
    disconnect()
    window.clearTimeout(recCap)
    recorder = null
    useCapture.getState().set({
      rec: {
        state: 'done',
        startedAt,
        endedAt: recEndedAt || Date.now(),
        bytes,
        stationName: station.name,
        withCaptions,
        blob: new Blob(parts, { type: fmt.mime }),
        ext: fmt.ext,
        saved: false,
      },
    })
  }
  mr.start(1000)
  recorder = mr
  recCap = window.setTimeout(stopRecording, MAX_RECORDING_MS)
  useCapture.getState().set({
    rec: { state: 'recording', startedAt, bytes: 0, stationId: station.id, stationName: station.name, withCaptions },
  })
  return true
}

export function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return
  recEndedAt = Date.now()
  // The last sentence is usually unfinished: transcribe what was heard so far.
  flushUtterance()
  recorder.stop()
}

export function discardRecording() {
  if (useCapture.getState().rec.state === 'done') useCapture.getState().set({ rec: { state: 'idle' } })
}

/**
 * Waits until every utterance of the recording has been transcribed. A first-time
 * model download is waited out; after that the wait is bounded.
 */
async function drain(until: number) {
  let deadline = Infinity
  while (worker && transcribing(until)) {
    const { asr } = useCapture.getState()
    if (asr === 'error') return
    if (asr === 'ready') deadline = Math.min(deadline, Date.now() + DRAIN_TIMEOUT_MS)
    if (Date.now() > deadline) return
    await new Promise((r) => window.setTimeout(r, 250))
  }
}

/** Downloads the recording; English stations come with their transcript (zip), others as plain audio. */
export async function downloadRecording() {
  const rec = useCapture.getState().rec
  if (rec.state !== 'done') return
  if (rec.withCaptions) await drain(rec.endedAt)
  const base = fileBase(rec.stationName, rec.startedAt)
  // MediaRecorder leaves the duration out of WebM headers, so players can't show or seek it.
  const audio = rec.ext === 'webm' ? await fixWebmDuration(rec.blob, rec.endedAt - rec.startedAt, { logger: false }) : rec.blob
  const segs = inRange(useCapture.getState().segments, rec.startedAt, rec.endedAt)
  if (segs.some((s) => s.kind === 'text')) {
    const txt = toTxt(segs, rec.stationName, rec.startedAt, rec.endedAt)
    const srt = toSrt(segs, rec.startedAt, rec.endedAt)
    const zip = buildZip(new Uint8Array(await audio.arrayBuffer()), rec.ext, txt, srt)
    saveFile(new Blob([zip], { type: 'application/zip' }), `${base}.zip`)
  } else {
    saveFile(audio, `${base}.${rec.ext}`)
  }
  const now = useCapture.getState().rec
  if (now.state === 'done' && now.blob === rec.blob) useCapture.getState().set({ rec: { ...now, saved: true } })
}

export function downloadTranscript() {
  const { segments } = useCapture.getState()
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (!first || !last) return
  const name = usePlayer.getState().station?.name ?? 'Transcript'
  const end = last.at + (last.kind === 'text' ? last.dur : 0)
  saveFile(new Blob([toTxt(segments, name, first.at, end)], { type: 'text/plain;charset=utf-8' }), `${fileBase(name, first.at)}.txt`)
}

// --- wiring ---

function reconcile() {
  const { station, status } = usePlayer.getState()
  const cap = useCapture.getState()
  const rec = cap.rec
  const recording = rec.state === 'recording'
  // A recording follows one station; tuning away or stopping finishes it.
  if (rec.state === 'recording' && (station?.id !== rec.stationId || status === 'paused' || status === 'idle' || status === 'error')) {
    stopRecording()
  }
  const tappable = canCapture(station)
  const wantCaptions = tappable && cap.captionsOn && isEnglish(station)
  // Recordings of English stations are transcribed even with captions off, so the download includes them.
  const recCaptions = rec.state === 'recording' && rec.withCaptions && tappable && station?.id === rec.stationId
  engine.setPreferProxy(wantCaptions || (recording && tappable))
  if ((wantCaptions || recCaptions) && station) {
    cap.markStation(station.id, station.name)
    ensureWorker()
    void startTap()
  } else {
    stopTap()
  }
  // Keep the model warm across stations while captions are on; otherwise free it once the backlog is done.
  asrWanted = cap.captionsOn || recCaptions
  if (!asrWanted && worker && !inflight && queue.length === 0) stopWorker()
}

/** After a model load error. */
export function retryCaptions() {
  stopWorker()
  reconcile()
}

/** Call once at startup. */
export function initCapture() {
  usePlayer.subscribe((s, p) => {
    if (s.station !== p.station || s.status !== p.status) reconcile()
  })
  useCapture.subscribe((s, p) => {
    if (s.captionsOn !== p.captionsOn || s.rec.state !== p.rec.state) reconcile()
  })
  window.addEventListener('beforeunload', (e) => {
    const { rec } = useCapture.getState()
    if (rec.state === 'recording' || (rec.state === 'done' && !rec.saved)) e.preventDefault()
  })
}
