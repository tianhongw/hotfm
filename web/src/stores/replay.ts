import { create } from 'zustand'
import type { Cue } from '../capture/export'

export interface ReplaySession {
  /** Station name, or the file name when the export doesn't say. */
  title: string
  /** Wall-clock start of the recording, to the minute, when known. */
  startedAt: number | null
  cues: Cue[]
}

interface ReplayState {
  /** An imported recording open in the full-screen reader; null shows live captions. */
  session: ReplaySession | null
  /** Playback position and length, in ms. */
  time: number
  duration: number
  playing: boolean
  rate: number
  set: (p: Partial<Omit<ReplayState, 'set'>>) => void
}

export const useReplay = create<ReplayState>()((set) => ({
  session: null,
  time: 0,
  duration: 0,
  playing: false,
  rate: 1,
  set: (p) => set(p),
}))
