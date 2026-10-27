// App-level playback actions shared by the dial, list, keyboard and Media Session.
import { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Dial, DialSlot, Station } from '../api/types'
import { translate } from '../i18n'
import { glideTo } from '../lib/glide'
import { FM_MAX, FM_MIN, seek as seekSlot } from '../lib/dial'
import { writeUrl } from '../lib/url'
import { useLibrary } from '../stores/library'
import { failureKey, usePlayer, useTuner } from '../stores/player'
import { useUI } from '../stores/ui'
import { engine } from './engine'
import { tuningNoise } from './noise'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(useLibrary.getState().lang, k, v)

/** Stations that already used their one automatic stream-info reload. */
const reloadedTypes = new Set<string>()
/** Latest tune request; by-id loads that finish late must not win. */
let tuneSeq = 0

/** Wires engine events into the stores. Call once at startup. */
export function initPlayer() {
  const lib = useLibrary.getState()
  engine.setVolume(lib.volume, lib.muted)
  useLibrary.subscribe((s) => engine.setVolume(s.volume, s.muted))

  engine.on((e) => {
    const st = engine.current
    switch (e.type) {
      case 'status':
        usePlayer.getState().set({ status: e.status, ...(e.status === 'connecting' ? { errorCode: null } : {}) })
        updateConnectNoise()
        break
      case 'title':
        usePlayer.getState().set({ title: e.title })
        break
      case 'started':
        if (st) {
          reloadedTypes.delete(st.id)
          void api.click(st.id).catch(() => {})
          // Only a load that actually reaches audio enters Recent and becomes the resume point.
          useLibrary.getState().pushRecent(st)
          useLibrary.getState().setLastStation(st.id)
        }
        break
      case 'failed':
        usePlayer.getState().set({ errorCode: e.code })
        if (st) void onFailed(st, e.code)
        break
    }
  })
}

/** While connecting after a tune, a little static keeps the radio feel. */
function updateConnectNoise() {
  const { status } = usePlayer.getState()
  const { noise, volume, muted } = useLibrary.getState()
  if (useTuner.getState().tuning) return
  const level = noise && !muted && (status === 'connecting' || status === 'buffering') ? 0.35 : 0
  tuningNoise.setLevel(level, volume)
}

async function onFailed(st: Station, code: string) {
  // A per-IP stream limit or our own rate limiter says nothing about the station's health.
  if (code === 'generic') void api.report(st.id, 'playback_error').catch(() => {})
  // The server may have learned the real stream type (e.g. it is HLS) or failed over to a mirror.
  let fresh: Station | null = null
  try {
    fresh = await api.station(st.id)
  } catch {
    /* keep the original error */
  }
  // The listener may have tuned elsewhere (or retried) while this request was in flight.
  if (engine.current?.id !== st.id || usePlayer.getState().station?.id !== st.id || engine.playing) return
  if (fresh && !reloadedTypes.has(st.id) && (fresh.stream.type !== st.stream.type || fresh.stream.url !== st.stream.url)) {
    reloadedTypes.add(st.id)
    playStation(fresh, { glide: false })
    return
  }
  useUI.getState().showToast(translate(useLibrary.getState().lang, failureKey(code)))
}

export function playStation(st: Station, opts: { glide?: boolean } = {}) {
  if (st.offline) {
    useUI.getState().showToast(t('toast.offline'))
    return
  }
  tuneSeq++
  // A station from another country/dial never changes what the listener is browsing.
  const ui = useUI.getState()
  if (st.freq != null && opts.glide !== false) glideTo(st.freq)
  engine.unlock()
  engine.load(st)
  usePlayer.getState().set({ station: st, title: '', errorCode: null })
  if (ui.searchTerm) useLibrary.getState().pushSearch(ui.searchTerm)
  // Recent + resume point are recorded when audio actually starts (see the engine 'started' event).
  writeUrl({ country: ui.country, region: ui.region || undefined, station: st.id })
}

export async function playStationById(id: string, opts?: { autoplay?: boolean }) {
  const seq = ++tuneSeq
  const st = await queryClient.fetchQuery({ queryKey: ['station', id], queryFn: () => api.station(id), staleTime: 60_000 })
  // Latest tune wins: a slower fetch must not override a station picked meanwhile.
  if (seq !== tuneSeq) return
  if (opts?.autoplay === false) {
    // Deep link: show the station but wait for a gesture (browsers block autoplay).
    if (st.freq != null) useTuner.getState().set({ freq: st.freq })
    engine.load(st, false)
    usePlayer.getState().set({ station: st, status: 'idle', title: '' })
    return
  }
  playStation(st)
}

/** Tune to a dial slot: plays its most popular healthy station. */
export async function playSlot(slot: DialSlot) {
  const pick = slot.stations.find((s) => s.health !== 'flaky') ?? slot.stations[0]
  if (!pick) return
  const current = usePlayer.getState().station
  if (current?.id === pick.id && engine.playing) return
  try {
    await playStationById(pick.id)
  } catch {
    useUI.getState().showToast(t('toast.playFail', { name: pick.name }))
  }
}

function currentSlots(): DialSlot[] {
  const { country, region } = useUI.getState()
  return queryClient.getQueryData<Dial>(['dial', country, region])?.slots ?? []
}

export function seek(dir: 1 | -1) {
  const slots = currentSlots()
  // Seek within the browsed dial. A station from another dial (favorites/deep link) still gives the
  // starting point; a network-only station without an FM frequency starts from the band edge.
  const station = usePlayer.getState().station
  const from = station ? (station.freq ?? (dir === 1 ? FM_MIN - 1 : FM_MAX + 1)) : useTuner.getState().freq
  const target = seekSlot(slots, from, dir)
  if (!target) return
  glideTo(target.freq)
  void playSlot(target)
}

export function togglePlay() {
  engine.unlock()
  const { station } = usePlayer.getState()
  if (station) {
    if (engine.current?.id !== station.id) engine.load(station)
    else engine.toggle()
    return
  }
  const lastId = useLibrary.getState().lastStationId
  if (lastId) void playStationById(lastId).catch(() => seek(1))
  else seek(1)
}

export function toggleFavorite(st?: Station | null) {
  const target = st ?? usePlayer.getState().station
  if (!target) return
  const favorites = useLibrary.getState().favorites
  const index = favorites.findIndex((f) => f.id === target.id)
  const added = useLibrary.getState().toggleFavorite(target)
  if (added) {
    useUI.getState().showToast(t('toast.fav'))
    return
  }
  const removed = favorites[index] ?? target
  undoableToast(t('toast.removedFav'), () => useLibrary.getState().insertFavorite(removed, index))
}

/** Remove a saved station and offer Undo in the toast. */
export function removeFavoriteWithUndo(id: string) {
  const favorites = useLibrary.getState().favorites
  const index = favorites.findIndex((f) => f.id === id)
  const removed = favorites[index]
  if (!removed) return
  useLibrary.getState().removeFavorite(id)
  undoableToast(t('toast.removedFav'), () => useLibrary.getState().insertFavorite(removed, index))
}

/** Remove one entry from Recent and offer Undo in the toast. */
export function removeRecentWithUndo(id: string) {
  const recent = useLibrary.getState().recent
  const index = recent.findIndex((r) => r.id === id)
  const removed = recent[index]
  if (!removed) return
  useLibrary.getState().removeRecent(id)
  undoableToast(t('toast.removedRecent'), () => useLibrary.getState().insertRecent(removed, index))
}

/** Empty Recent, offering Undo that restores the whole list. */
export function clearRecentWithUndo() {
  const recent = useLibrary.getState().recent
  if (recent.length === 0) return
  useLibrary.getState().clearRecent()
  undoableToast(t('toast.recentCleared'), () => useLibrary.getState().restoreRecent(recent))
}

function undoableToast(text: string, run: () => void) {
  useUI.getState().showToast(text, { label: t('toast.undo'), run })
}

// --- sleep timer ---

let sleepTimer: number | undefined
const FADE_MS = 30_000

export function setSleep(minutes: number | null) {
  window.clearInterval(sleepTimer)
  engine.setFade(1)
  if (!minutes) {
    usePlayer.getState().set({ sleepUntil: null })
    useUI.getState().showToast(t('toast.sleepOff'))
    return
  }
  const until = Date.now() + minutes * 60_000
  usePlayer.getState().set({ sleepUntil: until })
  useUI.getState().showToast(t('toast.sleepSet', { n: minutes }))
  sleepTimer = window.setInterval(() => {
    const left = until - Date.now()
    if (left <= 0) {
      window.clearInterval(sleepTimer)
      engine.stop()
      engine.setFade(1)
      usePlayer.getState().set({ sleepUntil: null })
    } else if (left < FADE_MS) {
      engine.setFade(left / FADE_MS)
    }
  }, 250)
}

/** Refresh locally stored stations so offline ones are flagged and stream info stays current. */
export async function refreshLibrary(ids: string[]) {
  if (ids.length === 0) return
  try {
    const fresh = await api.batch(ids.slice(0, 200))
    useLibrary.getState().refresh(fresh, ids.slice(0, 200))
  } catch {
    /* offline: keep snapshots */
  }
}
