import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { Segment } from '../capture/export'

export type AsrStatus = 'idle' | 'loading' | 'ready' | 'error'

export type Recording =
  | { state: 'idle' }
  | {
      state: 'recording'
      startedAt: number
      bytes: number
      stationId: string
      stationName: string
      /** English station: transcribed while recording, whether or not live captions are on. */
      withCaptions: boolean
    }
  | {
      state: 'done'
      startedAt: number
      endedAt: number
      bytes: number
      stationName: string
      withCaptions: boolean
      blob: Blob
      ext: string
      /** Downloaded at least once; leaving the page no longer warns. */
      saved: boolean
    }

const MAX_SEGMENTS = 3000

interface CaptureState {
  /** The listener wants live captions (remembered across visits). */
  captionsOn: boolean
  asr: AsrStatus
  /** Model download progress, 0–100. */
  progress: number
  backend: 'webgpu' | 'wasm' | null
  /** A chunk is being transcribed right now. */
  busy: boolean
  segments: Segment[]
  /** Best guess at the utterance still in progress; replaced by a final line when it ends. */
  interim: { at: number; text: string } | null
  rec: Recording

  setCaptions: (on: boolean) => void
  set: (p: Partial<Pick<CaptureState, 'asr' | 'progress' | 'backend' | 'busy' | 'interim' | 'rec'>>) => void
  addText: (at: number, dur: number, text: string) => void
  /** Adds a divider when captions continue on another station. */
  markStation: (id: string, name: string) => void
  clear: () => void
}

let seq = 0
let lastStationId = ''

export const useCapture = create<CaptureState>()(
  persist(
    (set) => ({
      captionsOn: false,
      asr: 'idle',
      progress: 0,
      backend: null,
      busy: false,
      segments: [],
      interim: null,
      rec: { state: 'idle' },

      setCaptions: (captionsOn) => set({ captionsOn }),
      set: (p) => set(p),
      addText: (at, dur, text) =>
        set((s) => {
          // Keep time order: a chunk transcribed after a station switch still belongs before its divider.
          const segments = [...s.segments]
          let i = segments.length
          while (i > 0 && segments[i - 1]!.at > at) i--
          segments.splice(i, 0, { kind: 'text', id: ++seq, at, dur, text })
          return { segments: segments.slice(-MAX_SEGMENTS) }
        }),
      markStation: (id, name) =>
        set((s) => {
          if (id === lastStationId) return s
          lastStationId = id
          // The first station needs no divider; the panel header already names it.
          if (!s.segments.some((x) => x.kind === 'text')) return s
          return { segments: [...s.segments, { kind: 'station' as const, id: ++seq, at: Date.now(), name }].slice(-MAX_SEGMENTS) }
        }),
      clear: () => set({ segments: [] }),
    }),
    {
      name: 'hotfm.capture',
      storage: createJSONStorage(() => window.localStorage),
      version: 1,
      partialize: ({ captionsOn }) => ({ captionsOn }),
    },
  ),
)

/** The newest caption line, if any. */
export function latestText(segments: Segment[]): Extract<Segment, { kind: 'text' }> | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i]!
    if (s.kind === 'text') return s
    return null // a station divider: nothing said here yet
  }
  return null
}
