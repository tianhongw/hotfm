// Taps raw PCM from the Web Audio graph with an AudioWorklet.

// Inlined so it needs no bundler support; it only copies mono frames out.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.len = 0
    this.start = 0
  }
  process(inputs) {
    const chans = inputs[0]
    if (!chans || chans.length === 0) return true
    const n = chans[0].length
    if (this.len === 0) this.start = currentFrame
    for (let i = 0; i < n; i++) {
      let v = 0
      for (let c = 0; c < chans.length; c++) v += chans[c][i]
      this.buf[this.len++] = v / chans.length
      if (this.len === this.buf.length) {
        this.port.postMessage({ pcm: this.buf, frame: this.start }, [this.buf.buffer])
        this.buf = new Float32Array(4096)
        this.len = 0
        this.start = currentFrame + i + 1
      }
    }
    return true
  }
}
registerProcessor('hotfm-pcm-tap', PcmTap)
`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

function ensureModule(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx)
  if (!p) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    loaded.set(ctx, p)
  }
  return p
}

/**
 * Creates a PCM tap node. Its (silent) output must reach the destination so
 * every browser keeps rendering it.
 */
export async function createPcmTap(
  ctx: AudioContext,
  onFrames: (pcm: Float32Array, frame: number) => void,
): Promise<AudioWorkletNode> {
  await ensureModule(ctx)
  const node = new AudioWorkletNode(ctx, 'hotfm-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max' })
  node.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; frame: number }>) => onFrames(e.data.pcm, e.data.frame)
  node.connect(ctx.destination)
  return node
}
