import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from './client'
import { pollInterval, snapshot, syncedChanged } from './syncWatch'
import type { CountryCode, StationQuery } from './types'

const MIN = 60_000

const countriesQuery = {
  queryKey: ['countries'] as const,
  queryFn: api.countries,
  staleTime: 10 * MIN,
}

export function useCountries() {
  return useQuery(countriesQuery)
}

/** Mount once (StationBrowser): polls /countries during a sync and refetches catalog data when one lands. */
export function useCountriesSyncWatch() {
  const qc = useQueryClient()
  const prev = useRef<Record<string, string | null> | null>(null)
  const q = useQuery({ ...countriesQuery, refetchInterval: (query) => pollInterval(query.state.data) })
  useEffect(() => {
    if (!q.data) return
    if (prev.current) {
      for (const code of syncedChanged(prev.current, q.data)) {
        void qc.invalidateQueries({ queryKey: ['stations'] })
        void qc.invalidateQueries({ queryKey: ['regions', code] })
        void qc.invalidateQueries({ queryKey: ['dial', code] })
      }
    }
    prev.current = snapshot(q.data)
  }, [q.data, qc])
  return q
}

export function useRegions(country: CountryCode) {
  return useQuery({ queryKey: ['regions', country], queryFn: () => api.regions(country), staleTime: 30 * MIN })
}

export function useDial(country: CountryCode, region: string) {
  return useQuery({
    queryKey: ['dial', country, region],
    queryFn: () => api.dial(country, region || undefined),
    staleTime: 10 * MIN,
  })
}

export function useStationList(q: StationQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['stations', q],
    queryFn: ({ pageParam, signal }) => api.stations({ limit: 50, ...q }, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 5 * MIN,
    enabled,
  })
}
