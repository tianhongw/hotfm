import { describe, expect, it } from 'vitest'
import { classifyFailure } from './failure'

describe('classifyFailure', () => {
  it('names the two server-side 429s', () => {
    expect(classifyFailure(429, 'too_many_streams')).toBe('too_many_streams')
    expect(classifyFailure(429, 'rate_limited')).toBe('rate_limited')
  })

  it('treats a bare 429 as the rate limiter', () => {
    expect(classifyFailure(429, null)).toBe('rate_limited')
  })

  it('falls back to generic for upstream and unknown errors', () => {
    expect(classifyFailure(502, 'upstream_unreachable')).toBe('generic')
    expect(classifyFailure(500, 'internal')).toBe('generic')
    expect(classifyFailure(200, null)).toBe('generic')
    expect(classifyFailure(null, null)).toBe('generic')
  })
})