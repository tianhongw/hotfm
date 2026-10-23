// Messages between the main thread and asr.worker.ts.

export type AsrRequest = { type: 'load' } | { type: 'transcribe'; id: number; pcm: Float32Array; rate: number }

export type AsrResponse =
  | { type: 'progress'; progress: number }
  | { type: 'ready'; backend: 'webgpu' | 'wasm' }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; text: string }
