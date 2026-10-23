// Plays back an exported recording (audio + transcript) in the full-screen reader.
import { translate } from '../i18n'
import { engine } from '../player/engine'
import { useCapture } from '../stores/capture'
import { useLibrary } from '../stores/library'
import { usePlayer } from '../stores/player'
import { useReplay } from '../stores/replay'
import { useUI } from '../stores/ui'
import { isAudioName, readExport, type ImportFile } from './export'

const t = (k: Parameters<typeof translate>[1]) => translate(useLibrary.getState().lang, k)

export const REPLAY_RATES = [1, 1.25, 1.5, 2, 0.75]

let audio: HTMLAudioElement | null = null
let url = ''
let frame = 0

const live = (status: string) => status === 'playing' || status === 'buffering' || status === 'connecting'

function sync() {
  if (audio) useReplay.getState().set({ time: audio.currentTime * 1000 })
}

/** Follows playback every frame so the highlighted sentence keeps up with the voice. */
function tick() {
  sync()
  frame = audio && !audio.paused ? requestAnimationFrame(tick) : 0
}

function length(el: HTMLAudioElement): number {
  const cues = useReplay.getState().session?.cues ?? []
  // A WebM without a duration header reports Infinity; the last caption is the next best guess.
  return Number.isFinite(el.duration) ? el.duration * 1000 : (cues[cues.length - 1]?.to ?? 0)
}

function element(): HTMLAudioElement {
  if (audio) return audio
  const el = new Audio()
  el.preload = 'auto'
  const set = useReplay.getState().set
  el.addEventListener('durationchange', () => set({ duration: length(el) }))
  el.addEventListener('play', () => {
    set({ playing: true })
    if (!frame) frame = requestAnimationFrame(tick)
  })
  el.addEventListener('pause', () => set({ playing: false }))
  el.addEventListener('timeupdate', sync)
  el.addEventListener('seeked', sync)
  el.addEventListener('ratechange', () => set({ rate: el.playbackRate }))
  el.addEventListener('error', () => {
    if (!el.getAttribute('src')) return
    closeReplay()
    useUI.getState().showToast(t('capture.importError'))
  })
  const volume = () => {
    const { volume, muted } = useLibrary.getState()
    el.volume = muted ? 0 : volume
  }
  volume()
  useLibrary.subscribe((s, p) => {
    if (s.volume !== p.volume || s.muted !== p.muted) volume()
  })
  // Never play over the live stream: tuning in pauses the replay.
  usePlayer.subscribe((s, p) => {
    if (live(s.status) && !live(p.status)) el.pause()
  })
  audio = el
  return el
}

/** Opens an exported zip, or an audio file with its .srt, in place of live captions. */
export async function openReplay(files: File[]) {
  const toast = useUI.getState().showToast
  // Stopping the live stream would end the recording.
  if (useCapture.getState().rec.state === 'recording') return toast(t('capture.importRecording'))
  let found
  try {
    const read = await Promise.all(
      files.map(
        async (f): Promise<ImportFile> => ({
          name: f.name,
          data: f.type.startsWith('audio/') || isAudioName(f.name) ? f : new Uint8Array(await f.arrayBuffer()),
        }),
      ),
    )
    found = readExport(read)
  } catch {
    return toast(t('capture.importError'))
  }
  if (!found) return toast(t('capture.importNeedAudio'))
  closeReplay()
  if (live(usePlayer.getState().status)) engine.stop()
  const el = element()
  url = URL.createObjectURL(found.audio)
  useReplay.getState().set({
    session: { title: found.title, startedAt: found.startedAt, cues: found.cues },
    time: 0,
    duration: found.cues[found.cues.length - 1]?.to ?? 0,
    playing: false,
  })
  el.src = url
  el.playbackRate = useReplay.getState().rate
  void el.play().catch(() => {})
}

export function closeReplay() {
  cancelAnimationFrame(frame)
  frame = 0
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  if (url) URL.revokeObjectURL(url)
  url = ''
  if (useReplay.getState().session) useReplay.getState().set({ session: null, time: 0, duration: 0, playing: false })
}

export function toggleReplay() {
  if (!audio || !useReplay.getState().session) return
  if (audio.paused) {
    if (live(usePlayer.getState().status)) engine.stop()
    void audio.play().catch(() => {})
  } else audio.pause()
}

export function seekReplay(ms: number) {
  if (!audio || !useReplay.getState().session) return
  const to = Math.max(0, Math.min(ms, useReplay.getState().duration || Infinity))
  audio.currentTime = to / 1000
  useReplay.getState().set({ time: to })
}

export function skipReplay(ms: number) {
  if (audio) seekReplay(audio.currentTime * 1000 + ms)
}

/** Steps through REPLAY_RATES. */
export function cycleReplayRate() {
  const { rate } = useReplay.getState()
  const next = REPLAY_RATES[(REPLAY_RATES.indexOf(rate) + 1) % REPLAY_RATES.length]!
  if (audio) audio.playbackRate = next
  useReplay.getState().set({ rate: next })
}
