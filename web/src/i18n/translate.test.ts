import { describe, expect, it } from 'vitest'
import { translate } from './index'

describe('translate plurals', () => {
  it('picks English one/other forms from the count', () => {
    expect(translate('en', 'list.count', { n: 0 })).toBe('0 stations')
    expect(translate('en', 'list.count', { n: 1 })).toBe('1 station')
    expect(translate('en', 'list.count', { n: 2 })).toBe('2 stations')
    expect(translate('en', 'sleep.left', { n: 1 })).toBe('Stops in 1 minute')
    expect(translate('en', 'toast.sleepSet', { n: 2 })).toBe('Stopping in 2 minutes')
  })

  it('keeps Chinese messages plain', () => {
    expect(translate('zh', 'list.count', { n: 0 })).toBe('0 个电台')
    expect(translate('zh', 'list.count', { n: 1 })).toBe('1 个电台')
    expect(translate('zh', 'toast.sleepSet', { n: 2 })).toBe('2 分钟后自动停止')
  })

  it('formats counts with the UI locale', () => {
    expect(translate('en', 'list.count', { n: 1234 })).toBe('1,234 stations')
    expect(translate('zh', 'dial.stations', { n: 1234 })).toBe('1,234 个电台')
  })

  it('leaves string variables untouched', () => {
    expect(translate('en', 'search.results', { q: 'KEXP' })).toBe('Results for “KEXP”')
    expect(translate('en', 'toast.playFail', { name: 'KEXP' })).toBe('KEXP is not playing right now — reported for re-check')
    expect(translate('en', 'search.group.freq', { f: '101.7' })).toBe('101.7 MHz')
  })

  it('falls back to the other form without a numeric count', () => {
    expect(translate('en', 'list.count')).toBe('{n} stations')
  })
})

describe('translate failure copy', () => {
  it('has distinct copy for each stream failure kind', () => {
    expect(translate('en', 'error.tooManyStreams')).toContain('Close another HotFM tab')
    expect(translate('en', 'error.rateLimited')).toContain('Wait a moment')
    expect(translate('en', 'error.generic')).toContain('next station')
    expect(translate('zh', 'error.tooManyStreams')).toContain('标签页')
  })

  it('has offline copy for the player and the display', () => {
    expect(translate('en', 'player.offline')).toContain('resumes when')
    expect(translate('zh', 'player.offline')).toContain('网络已断开')
    expect(translate('en', 'status.offline')).toBe('OFFLINE')
  })
})