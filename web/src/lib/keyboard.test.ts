import { describe, expect, it } from 'vitest'
import { ownsArrowKeys } from './keyboard'

const el = (tagName: string, inside: string[] = [], contentEditable = false) =>
  ({
    tagName,
    isContentEditable: contentEditable,
    closest: (selector: string) => (inside.some((marker) => selector.includes(marker)) ? ({} as Element) : null),
  }) as unknown as Element

describe('ownsArrowKeys', () => {
  it('leaves text fields, selects and editable content alone', () => {
    expect(ownsArrowKeys(el('INPUT'))).toBe(true)
    expect(ownsArrowKeys(el('TEXTAREA'))).toBe(true)
    expect(ownsArrowKeys(el('SELECT'))).toBe(true)
    expect(ownsArrowKeys(el('DIV', [], true))).toBe(true)
  })

  it('detects the station panel, menus, listboxes, radio groups, sliders and dialogs', () => {
    expect(ownsArrowKeys(el('BUTTON', ['#station-panel']))).toBe(true)
    expect(ownsArrowKeys(el('A', ['[role="menu"]']))).toBe(true)
    expect(ownsArrowKeys(el('DIV', ['[role="listbox"]']))).toBe(true)
    expect(ownsArrowKeys(el('LABEL', ['[role="radiogroup"]']))).toBe(true)
    expect(ownsArrowKeys(el('DIV', ['[role="slider"]']))).toBe(true)
    expect(ownsArrowKeys(el('BUTTON', ['[role="dialog"]']))).toBe(true)
  })

  it('keeps volume shortcuts on the page body and on player controls', () => {
    expect(ownsArrowKeys(el('BODY'))).toBe(false)
    expect(ownsArrowKeys(el('BUTTON'))).toBe(false)
    expect(ownsArrowKeys(null)).toBe(false)
  })
})