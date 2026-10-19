import { describe, expect, it } from 'vitest'
import { parseFreqQuery } from './freq'
import { matchRegions, pinyinInitials, regionScore } from './regionMatch'

describe('parseFreqQuery', () => {
  it('reads common frequency spellings', () => {
    expect(parseFreqQuery('101.7')).toBe(101.7)
    expect(parseFreqQuery('FM 101.7')).toBe(101.7)
    expect(parseFreqQuery('fm101.7')).toBe(101.7)
    expect(parseFreqQuery('97.4MHz')).toBe(97.4)
    expect(parseFreqQuery('调频97.4')).toBe(97.4)
    expect(parseFreqQuery('1017')).toBe(101.7)
    expect(parseFreqQuery('905')).toBe(90.5)
    expect(parseFreqQuery('101')).toBe(101)
    expect(parseFreqQuery('98')).toBe(98)
  })

  it('rejects text and out-of-band numbers', () => {
    expect(parseFreqQuery('kroq')).toBeNull()
    expect(parseFreqQuery('50')).toBeNull()
    expect(parseFreqQuery('120.5')).toBeNull()
    expect(parseFreqQuery('2024')).toBeNull()
    expect(parseFreqQuery('101.7 jazz')).toBeNull()
  })
})

describe('region matching', () => {
  it('splits pinyin into initials', () => {
    expect(pinyinInitials('guangdong')).toBe('gd')
    expect(pinyinInitials('neimenggu')).toBe('nmg')
    expect(pinyinInitials('henan')).toBe('hn')
    expect(pinyinInitials('hunan')).toBe('hn')
    expect(pinyinInitials('heilongjiang')).toBe('hlj')
    expect(pinyinInitials('yunnan')).toBe('yn')
    expect(pinyinInitials('xinjiang')).toBe('xj')
    expect(pinyinInitials('chongqing')).toBe('cq')
  })

  const regions = [
    { country: 'CN' as const, key: 'guangdong', name: '广东', nameEn: 'Guangdong' },
    { country: 'CN' as const, key: 'guangxi', name: '广西', nameEn: 'Guangxi' },
    { country: 'US' as const, key: 'california', name: 'California', nameEn: 'California' },
    { country: 'US' as const, key: 'texas', name: 'Texas', nameEn: 'Texas' },
    { country: 'US' as const, key: 'new-york', name: 'New York', nameEn: 'New York' },
  ]
  const keys = (q: string) => matchRegions(regions, q).map((r) => r.key)

  it('matches names, pinyin, initials and USPS codes across countries', () => {
    expect(keys('广东')).toEqual(['guangdong'])
    expect(keys('广')).toEqual(['guangdong', 'guangxi'])
    expect(keys('gd')).toEqual(['guangdong'])
    expect(keys('guangx')).toEqual(['guangxi'])
    expect(keys('tx')).toEqual(['texas'])
    expect(keys('ny')).toEqual(['new-york'])
    expect(keys('york')).toEqual(['new-york'])
    expect(keys('calif')).toEqual(['california'])
    expect(keys('zzz')).toEqual([])
  })

  it('ranks exact matches first', () => {
    expect(regionScore(regions[0]!, 'CN', 'guangdong')).toBe(0)
    expect(keys('ca')[0]).toBe('california')
  })
})
