import { useEffect } from 'react'
import { api } from '../api/client'
import { playStationById, queryClient, refreshLibrary } from '../player/controller'
import { readUrl, writeUrl } from '../lib/url'
import { libraryIds, useLibrary } from '../stores/library'
import { usePlayer } from '../stores/player'
import { useUI } from '../stores/ui'

/** One-time startup: deep link, library refresh, URL <-> state sync, dial prefetch. */
export function useBootstrap() {
  useEffect(() => {
    const url = readUrl()
    const ui = useUI.getState()
    if (url.country) ui.setCountry(url.country)
    if (url.region) ui.setRegion(url.region)

    const lastId = useLibrary.getState().lastStationId
    const initial = url.station ?? lastId
    if (initial) {
      // Show the station on the display, ready to play (autoplay is blocked without a gesture).
      void playStationById(initial, { autoplay: false }).catch(() => {})
    }
    void refreshLibrary(libraryIds())

    // Keep the URL in step with country/region; station changes push history entries in playStation.
    const unsub = useUI.subscribe((s, prev) => {
      if (s.country !== prev.country || s.region !== prev.region) {
        writeUrl({ country: s.country, region: s.region || undefined, station: usePlayer.getState().station?.id }, 'replace')
        void queryClient.prefetchQuery({ queryKey: ['dial', s.country, s.region], queryFn: () => api.dial(s.country, s.region || undefined) })
      }
    })

    const onPop = () => {
      const u = readUrl()
      const st = useUI.getState()
      if (u.country && u.country !== st.country) st.setCountry(u.country)
      if ((u.region ?? '') !== st.region) st.setRegion(u.region ?? '')
      const current = usePlayer.getState().station?.id
      if (u.station && u.station !== current) void playStationById(u.station).catch(() => {})
    }
    window.addEventListener('popstate', onPop)

    return () => {
      unsub()
      window.removeEventListener('popstate', onPop)
    }
  }, [])
}
