/** Mac and iOS keyboards show ⌘; every other platform uses Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '') || /mac os x|iphone|ipad/i.test(navigator.userAgent)
}