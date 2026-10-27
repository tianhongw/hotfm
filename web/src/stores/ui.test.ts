import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let useUI: (typeof import('./ui'))['useUI']
let useLibrary: (typeof import('./library'))['useLibrary']
const saved = new Map<string, string>()

beforeAll(async () => {
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  }
  vi.stubGlobal('window', { localStorage: storage })
  saved.set(
    'hotfm.library',
    JSON.stringify({ version: 1, state: { theme: 'braun', lang: 'zh', volume: 0.4, favorites: [{ id: 'kept' }] } }),
  )
  useUI = (await import('./ui')).useUI
  useLibrary = (await import('./library')).useLibrary
})

beforeEach(() => {
  useUI.setState({ country: 'CN', region: 'beijing', sort: 'freq', searchText: '', searchTerm: '', searchScope: 'current', tab: 'all' })
})

describe('search and filter transitions', () => {
  it('clear search removes pending text and the submitted term but keeps the location', () => {
    useUI.getState().setSearchText('音乐')
    useUI.getState().commitSearch()
    useUI.getState().setSearchScope('all')
    useUI.getState().setSearchText('')
    expect(useUI.getState()).toMatchObject({ country: 'CN', region: 'beijing', searchText: '', searchTerm: '', searchScope: 'current' })
  })
  it('clear filters preserves country and resets keyword, region, sorting and tab together', () => {
    useUI.setState({ searchText: '音乐', searchTerm: '音乐', searchScope: 'all' })
    useUI.getState().resetFilters()
    expect(useUI.getState()).toMatchObject({
      country: 'CN',
      region: '',
      searchText: '',
      searchTerm: '',
      searchScope: 'current',
      sort: 'popular',
      tab: 'all',
    })
  })
  it('searches locally by default and keeps a widened search while editing it', () => {
    useUI.getState().setSearchText('KEXP')
    useUI.getState().commitSearch()
    expect(useUI.getState().searchScope).toBe('current')
    useUI.getState().setSearchScope('all')
    expect(useUI.getState()).toMatchObject({ country: 'CN', region: 'beijing', searchText: 'KEXP', searchTerm: 'KEXP', searchScope: 'all' })
    useUI.getState().setSort('popular')
    expect(useUI.getState().searchScope).toBe('all')
    useUI.getState().setSearchScope('current')
    expect(useUI.getState()).toMatchObject({ searchTerm: 'KEXP', searchScope: 'current' })
    useUI.getState().setSearchScope('all')
    // Editing the same query keeps the widened scope instead of snapping back to the region.
    useUI.getState().setSearchText('音乐')
    expect(useUI.getState().searchScope).toBe('all')
    // Clearing the text narrows the next search to the browsed region again.
    useUI.getState().setSearchText('')
    expect(useUI.getState()).toMatchObject({ searchText: '', searchTerm: '', searchScope: 'current' })
    useUI.getState().setSearchText('jazz')
    expect(useUI.getState().searchScope).toBe('current')
  })
  it('picking a location re-runs the active search there', () => {
    useUI.setState({ searchText: 'jazz', searchTerm: 'jazz', searchScope: 'all' })
    useUI.getState().setLocation('US', 'texas')
    expect(useUI.getState()).toMatchObject({ country: 'US', region: 'texas', searchText: 'jazz', searchTerm: 'jazz', searchScope: 'current' })
  })
  it('keeps the active search when switching library tabs', () => {
    useUI.getState().setSearchText('new')
    useUI.getState().commitSearch()
    useUI.getState().setSearchScope('all')
    useUI.getState().setTab('fav')
    expect(useUI.getState()).toMatchObject({ tab: 'fav', searchText: 'new', searchTerm: 'new', searchScope: 'all' })
    useUI.getState().setTab('recent')
    expect(useUI.getState()).toMatchObject({ tab: 'recent', searchText: 'new', searchTerm: 'new', searchScope: 'all' })
    useUI.getState().setTab('all')
    expect(useUI.getState()).toMatchObject({ tab: 'all', searchText: 'new', searchTerm: 'new', searchScope: 'all' })
  })
  it('stores a toast action so the toast can offer undo', () => {
    const run = vi.fn()
    useUI.getState().showToast('Removed from Favorites', { label: 'Undo', run })
    expect(useUI.getState().toast).toMatchObject({ text: 'Removed from Favorites', action: { label: 'Undo', run } })
    useUI.getState().toast?.action?.run()
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('persisted appearance', () => {
  it('migrates the old library once and preserves subsequent choices on rehydration', async () => {
    expect(useLibrary.getState()).toMatchObject({
      theme: 'apple',
      colorMode: 'light',
      lang: 'zh',
      volume: 0.4,
      favorites: [{ id: 'kept' }],
    })
    useLibrary.getState().setTheme('hifi')
    await useLibrary.persist.rehydrate()
    expect(useLibrary.getState().theme).toBe('hifi')
    expect(JSON.parse(saved.get('hotfm.library')!).version).toBe(3)
  })
  it('upgrades v2 storage without losing stations saved only as presets', async () => {
    saved.set(
      'hotfm.library',
      JSON.stringify({
        version: 2,
        state: {
          theme: 'braun',
          colorMode: 'dark',
          lang: 'zh',
          volume: 0.4,
          favorites: [{ id: 'kept' }],
          presets: [null, { id: 'kept' }, { id: 'from-preset' }],
        },
      }),
    )
    await useLibrary.persist.rehydrate()
    expect(useLibrary.getState()).toMatchObject({
      theme: 'apple',
      colorMode: 'dark',
      lang: 'zh',
      volume: 0.4,
      favorites: [{ id: 'kept' }, { id: 'from-preset' }],
    })
    const persisted = JSON.parse(saved.get('hotfm.library')!)
    expect(persisted.version).toBe(3)
    expect(persisted.state).not.toHaveProperty('presets')
    await useLibrary.persist.rehydrate()
    expect(useLibrary.getState().favorites.map((station) => station.id)).toEqual(['kept', 'from-preset'])
  })
})
