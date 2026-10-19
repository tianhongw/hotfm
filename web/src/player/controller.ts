// App-level playback actions shared by the dial, list, keyboard and Media Session.
import { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type { Dial, DialSlot, Station } from '../api/types'
import { translate } from '../i18n'
import { glideTo } from '../lib/glide'
import { seek as seekSlot } from '../lib/dial'
import { writeUrl } from '../lib/url'
import { useLibrary } from '../stores/library'
import { usePlayer, useTuner } from '../stores/player'
import { useUI } from '../stores/ui'
import { engine } from './engine'
import { tuningNoise } from './noise'

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

const t = (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(useLibrary.getState().lang, k, v)

let reloadedForType = false

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
        reloadedForType = false
        if (st) void api.click(st.id).catch(() => {})
        break
      case 'failed':
        usePlayer.getState().set({ errorCode: e.code })
        if (st) void onFailed(st)
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

async function onFailed(st: Station) {
  void api.report(st.id, 'playback_error').catch(() => {})
  // The server may have learned the real stream type (e.g. it is HLS) or failed over to a mirror.
  try {
    const fresh = await api.station(st.id)
    if (!reloadedForType && (fresh.stream.type !== st.stream.type || fresh.stream.url !== st.stream.url)) {
      reloadedForType = true
      playStation(fresh, { glide: false })
      return
    }
  } catch {
    /* keep the original error */
  }
  useUI.getState().showToast(t('toast.playFail', { name: st.name }))
}

export function playStation(st: Station, opts: { glide?: boolean; push?: boolean } = {}) {
  if (st.offline) {
    useUI.getState().showToast(t('toast.offline'))
    return
  }
  const ui = useUI.getState()
  if (st.country !== ui.country) ui.setCountry(st.country)
  if (st.freq != null && opts.glide !== false) glideTo(st.freq)
  engine.unlock()
  engine.load(st)
  usePlayer.getState().set({ station: st, title: '', errorCode: null })
  const lib = useLibrary.getState()
  if (ui.searchTerm) lib.pushSearch(ui.searchTerm)
  lib.pushRecent(st)
  lib.setLastStation(st.id)
  const u = useUI.getState()
  writeUrl({ country: u.country, region: u.region || undefined, station: st.id }, opts.push === false ? 'replace' : 'push')
}

export async function playStationById(id: string, opts?: { autoplay?: boolean }) {
  const st = await queryClient.fetchQuery({ queryKey: ['station', id], queryFn: () => api.station(id), staleTime: 60_000 })
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
  const target = seekSlot(slots, useTuner.getState().freq, dir)
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
  const added = useLibrary.getState().toggleFavorite(target)
  useUI.getState().showToast(t(added ? 'toast.fav' : 'toast.unfav'))
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
