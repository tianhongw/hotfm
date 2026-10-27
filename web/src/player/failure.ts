// Turning a failed stream request into something the listener can act on.

/** Why a station failed to play, as far as we can tell. */
export type FailureKind = 'too_many_streams' | 'rate_limited' | 'generic'

export interface HttpFailure {
  status: number | null
  code: string | null
}

/**
 * Maps the HTTP status (and the server's JSON error code, when we have it)
 * to a failure kind. A bare 429 comes from the rate limiter, the stream
 * limiter always names itself, and anything else is "the station is not
 * responding".
 */
export function classifyFailure(status: number | null | undefined, code: string | null | undefined): FailureKind {
  if (code === 'too_many_streams') return 'too_many_streams'
  if (code === 'rate_limited') return 'rate_limited'
  if (status === 429) return 'rate_limited'
  return 'generic'
}

/**
 * Asks the proxy what went wrong: reads only the status line and, for an
 * error response, the small JSON envelope. A successful response is aborted
 * as soon as headers arrive, so no audio is ever buffered a second time.
 */
export async function probeStreamFailure(url: string, timeoutMs = 4000): Promise<HttpFailure> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: { Accept: 'application/json' } })
    let code: string | null = null
    if (!res.ok) {
      try {
        const body = (await res.json()) as { error?: { code?: string } }
        code = body.error?.code ?? null
      } catch {
        /* not the JSON error envelope */
      }
    }
    return { status: res.status, code }
  } catch {
    return { status: null, code: null }
  } finally {
    clearTimeout(timer)
    ctrl.abort()
  }
}