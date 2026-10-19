import type { components } from './schema'

type S = components['schemas']

export type CountryCode = S['CountryCode']
export type Country = S['Country']
export type Region = S['Region']
export type RegionCount = S['RegionCount']
export type Station = S['Station']
export type Health = S['Health']
export type Dial = S['Dial']
export type DialSlot = Dial['slots'][number]
export type DialStation = S['DialStation']

export interface Page<T> {
  items: T[]
  total: number
  nextCursor: string | null
}

export interface StationQuery {
  country?: CountryCode
  region?: string
  tag?: string
  band?: 'fm' | 'net'
  freq?: number
  q?: string
  sort?: 'popular' | 'freq' | 'name'
  limit?: number
}
