import { formatFreq } from '../lib/dial'
import { usePlayer } from '../stores/player'
import { engine } from './engine'
import { seek, togglePlay } from './controller'

/** Lock-screen / headset / OS media controls. */
export function initMediaSession() {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => togglePlay()],
    ['pause', () => engine.stop()],
    ['stop', () => engine.stop()],
    ['previoustrack', () => seek(-1)],
    ['nexttrack', () => seek(1)],
  ]
  for (const [action, fn] of handlers) {
    try {
      ms.setActionHandler(action, fn)
    } catch {
      /* unsupported action */
    }
  }
  usePlayer.subscribe((s, prev) => {
    if (s.station !== prev.station || s.title !== prev.title) {
      const st = s.station
      if (!st) {
        ms.metadata = null
        return
      }
      const band = st.freq != null ? `${formatFreq(st.freq)} MHz` : 'NET'
      ms.metadata = new MediaMetadata({
        title: s.title || st.name,
        artist: s.title ? st.name : [st.city, st.region.name].filter(Boolean).join(' · '),
        album: `HotFM · ${band}`,
        artwork: st.logo ? [{ src: st.logo, sizes: '256x256' }] : [],
      })
    }
    if (s.status !== prev.status) {
      ms.playbackState = s.status === 'playing' || s.status === 'buffering' || s.status === 'connecting' ? 'playing' : 'paused'
    }
  })
}
