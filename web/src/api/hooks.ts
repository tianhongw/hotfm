import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { CountryCode, StationQuery } from './types'

const MIN = 60_000

export function useCountries() {
  return useQuery({ queryKey: ['countries'], queryFn: api.countries, staleTime: 10 * MIN })
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
