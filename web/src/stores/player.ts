import { create } from 'zustand'
import type { Station } from '../api/types'

export type PlayerStatus = 'idle' | 'connecting' | 'buffering' | 'playing' | 'paused' | 'error'

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
