export type Theme = 'apple' | 'hifi'
export type ColorMode = 'light' | 'dark' | 'system'
export const LIBRARY_VERSION = 3

export function migrateLibrary(old: unknown, fromVersion = 0) {
  const { presets, ...state } = (old ?? {}) as Record<string, unknown>
  // Keep saved stations accessible after removing the preset bank.
  const favorites = Array.isArray(state.favorites) ? [...state.favorites] : []
  const ids = new Set(favorites.map((station) => station.id))
  for (const station of Array.isArray(presets) ? presets : []) {
    if (station && typeof station.id === 'string' && !ids.has(station.id)) {
      favorites.push(station)
      ids.add(station.id)
    }
  }
  // Preserve v2 appearance choices; retired themes fall back to Default.
  const theme: Theme = fromVersion >= 2 && state.theme === 'hifi' ? 'hifi' : 'apple'
  const colorMode: ColorMode = fromVersion >= 2 && (state.colorMode === 'dark' || state.colorMode === 'system') ? state.colorMode : 'light'
  return { ...state, favorites, theme, colorMode }
}

export function resolvedTheme(theme: Theme, mode: ColorMode, systemDark: boolean) {
  return theme === 'apple' && (mode === 'dark' || (mode === 'system' && systemDark)) ? 'apple-dark' : theme
}
