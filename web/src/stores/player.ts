import { create } from 'zustand'
import type { Station } from '../api/types'
import type { TKey } from '../i18n'

export type PlayerStatus = 'idle' | 'connecting' | 'buffering' | 'playing' | 'paused' | 'error' | 'offline'

/** The one place a failure code becomes user-facing copy, so every appearance agrees. */
export function failureKey(code: string | null | undefined): TKey {
  switch (code) {
    case 'too_many_streams':
      return 'error.tooManyStreams'
    case 'rate_limited':
      return 'error.rateLimited'
    default:
      return 'error.generic'
  }
}

interface PlayerState {
  station: Station | null
  status: PlayerStatus
  /** "Now playing" from ICY metadata, if the stream provides it. */
  title: string
  errorCode: string | null
  sleepUntil: number | null
  set: (p: Partial<Omit<PlayerState, 'set'>>) => void
}

export const usePlayer = create<PlayerState>()((set) => ({
  station: null,
  status: 'idle',
  title: '',
  errorCode: null,
  sleepUntil: null,
  set: (p) => set(p),
}))

interface TunerState {
  /** Needle position in MHz. */
  freq: number
  /** True while the listener is dragging / scrolling the dial. */
  tuning: boolean
  set: (p: Partial<Omit<TunerState, 'set'>>) => void
}

export const useTuner = create<TunerState>()((set) => ({
  freq: 98.0,
  tuning: false,
  set: (p) => set(p),
}))
