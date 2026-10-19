import type { Country, CountryCode, Dial, Page, RegionCount, Station, StationQuery } from './types'

const BASE = '/api/v1'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  if (!res.ok) {
    let code = 'http_' + res.status
    let message = res.statusText
    try {
      const body = (await res.json()) as { error?: { code: string; message: string } }
      if (body.error) ({ code, message } = body.error)
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, code, message)
  }
  if (res.status === 204 || res.status === 202) return undefined as T
  return (await res.json()) as T
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? '?' + s : ''
}

export const api = {
  countries: () => request<{ items: Country[] }>('/countries').then((r) => r.items),
  regions: (country: CountryCode) => request<{ items: RegionCount[] }>('/regions' + qs({ country })).then((r) => r.items),
  tags: (country: CountryCode, region?: string) =>
    request<{ items: { tag: string; count: number }[] }>('/tags' + qs({ country, region })).then((r) => r.items),
  stations: (q: StationQuery, cursor?: string, signal?: AbortSignal) =>
    request<Page<Station>>('/stations' + qs({ ...q, cursor }), { signal }),
  station: (id: string) => request<Station>('/stations/' + encodeURIComponent(id)),
  batch: (ids: string[]) =>
    request<{ items: Station[] }>('/stations/batch', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => r.items),
  dial: (country: CountryCode, region?: string) => request<Dial>('/dial' + qs({ country, region })),
  click: (id: string) => request<void>(`/stations/${encodeURIComponent(id)}/click`, { method: 'POST' }),
  report: (id: string, kind: 'playback_error' | 'stalled') =>
    request<void>(`/stations/${encodeURIComponent(id)}/report`, { method: 'POST', body: JSON.stringify({ kind }) }),
  metaURL: (id: string, sid: string) => `${BASE}/stream/${encodeURIComponent(id)}/meta${qs({ sid })}`,
}
