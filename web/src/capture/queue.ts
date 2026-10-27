/** Queue policy for utterances waiting on Whisper: live-only ones are capped, a recording's kept up to a hard total. */

/** Adds `job`; live-only utterances are capped so captions stay live, kept ones only by the hard total cap. */
export function enqueue<T extends { keep: boolean }>(
  q: readonly T[],
  job: T,
  maxLive: number,
  maxTotal: number,
): { next: T[]; dropped: T[] } {
  const next = [...q, job]
  let live = 0
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]!.keep) continue
    if (++live > maxLive) next.splice(i, 1)
  }
  const dropped: T[] = []
  while (next.length > maxTotal) dropped.push(next.shift()!)
  return { next, dropped }
}