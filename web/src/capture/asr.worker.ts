/// <reference lib="webworker" />
// Speech recognition off the main thread: Whisper via transformers.js,
// WebGPU when available, otherwise WASM with a smaller model.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import type { AsrRequest, AsrResponse } from './asr'
import { resample } from './dsp'

declare const self: DedicatedWorkerGlobalScope

env.allowLocalModels = false

const post = (m: AsrResponse) => self.postMessage(m)

async function hasWebGPU(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null

function load(): Promise<AutomaticSpeechRecognitionPipeline> {
  return (asr ??= (async () => {
    const webgpu = await hasWebGPU()
    const p = await pipeline(
      'automatic-speech-recognition',
      webgpu ? 'onnx-community/whisper-base.en' : 'onnx-community/whisper-tiny.en',
      {
        device: webgpu ? 'webgpu' : 'wasm',
        dtype: webgpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: (info) => {
          if (info.status === 'progress_total') post({ type: 'progress', progress: info.progress })
        },
      },
    )
    post({ type: 'ready', backend: webgpu ? 'webgpu' : 'wasm' })
    return p
  })().catch((err: unknown) => {
    asr = null
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    throw err
  }))
}

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const m = e.data
  if (m.type === 'load') {
    void load().catch(() => {})
    return
  }
  let text = ''
  try {
    const p = await load()
    const out = await p(resample(m.pcm, m.rate, 16_000))
    text = (Array.isArray(out) ? out[0]?.text : out.text) ?? ''
  } catch {
    /* reported via 'error' on load; a failed chunk just yields no text */
  }
  post({ type: 'result', id: m.id, text })
}
