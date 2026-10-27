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
  /** Model bytes fetched and expected; 0 until the download reports them. */
  loaded: number
  total: number
  backend: 'webgpu' | 'wasm' | null
  /** A chunk is being transcribed right now. */
  busy: boolean
  segments: Segment[]
  /** Best guess at the utterance still in progress; replaced by a final line when it ends. */
  interim: { at: number; text: string } | null
  rec: Recording
  /** Station whose stream could not be taken over for captions; cleared when it changes. */
  proxyFail: string | null
  /** Captions changed since the last save or clear; leaving the page would lose them. */
  dirty: boolean

  setCaptions: (on: boolean) => void
  set: (
    p: Partial<Pick<CaptureState, 'asr' | 'progress' | 'loaded' | 'total' | 'backend' | 'busy' | 'interim' | 'rec' | 'proxyFail' | 'dirty'>>,
  ) => void
  addText: (at: number, dur: number, text: string) => void
  /** Records that utterances of a recording were lost before transcription. */
  addGap: (at: number, dur: number, count: number) => void
  /** Adds a divider when captions continue on another station. */
  markStation: (id: string, name: string) => void
  clear: () => void
}

let seq = 0
let lastStationId = ''

const GAP_MERGE_MS = 2000

/** Inserts in time order: a chunk transcribed after a station switch still belongs before its divider. */
function insert(segments: Segment[], seg: Segment): Segment[] {
  let i = segments.length
  while (i > 0 && segments[i - 1]!.at > seg.at) i--
  segments.splice(i, 0, seg)
  return segments.slice(-MAX_SEGMENTS)
}

export const useCapture = create<CaptureState>()(
  persist(
    (set) => ({
      captionsOn: false,
      asr: 'idle',
      progress: 0,
      loaded: 0,
      total: 0,
      backend: null,
      busy: false,
      segments: [],
      interim: null,
      rec: { state: 'idle' },
      proxyFail: null,
      dirty: false,

      setCaptions: (captionsOn) => set({ captionsOn }),
      set: (p) => set(p),
      addText: (at, dur, text) => set((s) => ({ segments: insert([...s.segments], { kind: 'text', id: ++seq, at, dur, text }), dirty: true })),
      addGap: (at, dur, count) =>
        set((s) => {
          const last = s.segments[s.segments.length - 1]
          // Losing more of the same stretch of speech reads as one gap.
          if (last?.kind === 'gap' && at - (last.at + last.dur) <= GAP_MERGE_MS) {
            return { segments: [...s.segments.slice(0, -1), { ...last, dur: at + dur - last.at, count: last.count + count }], dirty: true }
          }
          return { segments: insert([...s.segments], { kind: 'gap', id: ++seq, at, dur, count }), dirty: true }
        }),
      markStation: (id, name) =>
        set((s) => {
          if (id === lastStationId) return s
          lastStationId = id
          // The first station needs no divider; the panel header already names it.
          if (!s.segments.some((x) => x.kind === 'text')) return s
          return { segments: [...s.segments, { kind: 'station' as const, id: ++seq, at: Date.now(), name }].slice(-MAX_SEGMENTS) }
        }),
      clear: () => set({ segments: [], dirty: false }),
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
