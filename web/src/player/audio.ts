// One AudioContext for the whole app (level meter + tuning static).

let ctx: AudioContext | null = null

/** Returns the shared context, creating/resuming it. Call from a user gesture the first time. */
export function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/**
 * Routing the <audio> element through Web Audio lets us draw a real level
 * meter, but on touch devices a suspended AudioContext (screen lock) would
 * silence playback, so only do it on desktop-class pointers.
 */
export const meterCapable = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true
