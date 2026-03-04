import { describe, it, expect } from 'vitest'
import { slugify } from '~/utils/slugify'

describe('slugify', () => {
  it('converts community name to lowercase hyphenated slug', () => {
    expect(slugify('My Community')).toBe('my-community')
  })

  it('trims whitespace', () => {
    expect(slugify('  Cascadia  ')).toBe('cascadia')
  })

  it('strips special characters', () => {
    expect(slugify('Hello World!!!')).toBe('hello-world')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('--leading-trailing--')).toBe('leading-trailing')
  })

  it('collapses consecutive hyphens', () => {
    expect(slugify('a--b---c')).toBe('a-b-c')
  })

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('')
  })

  it('returns empty string when all characters are special', () => {
    expect(slugify('!!!')).toBe('')
  })

  it('enforces DNS label max length of 63 characters', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long)).toHaveLength(63)
  })

  it('preserves alphanumeric characters including numbers', () => {
    expect(slugify('Cascadia Bioregion 2026')).toBe('cascadia-bioregion-2026')
  })
})
