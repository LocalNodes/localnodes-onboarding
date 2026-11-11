// Runtime voice and banned-claims check (Phase 23, plan 23-33, T-2). A twin of
// scripts/check-landing-claims.mjs: it reads the same fixture rows (banned and
// voiceRules.rules), so there is one list for the build check and this one.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { voiceHits } from '../../server/utils/voice-check'
import { templateSeed } from '../../server/utils/community-seed'
// @ts-expect-error plain .mjs script, no type declarations
import { findBannedHits } from '../../scripts/check-landing-claims.mjs'

type Row = { pattern: string, regex?: boolean, flags?: string }
const fixture = JSON.parse(readFileSync(new URL('../fixtures/banned-claims.json', import.meta.url), 'utf8')) as {
  banned: Row[]
  voiceRules: { rules: Row[] }
  buyerWords: Row[]
}
const ROWS: Row[] = [...fixture.banned, ...fixture.voiceRules.rules]
const patterns = (rows: Row[]) => rows.map(r => r.pattern)

describe('voiceHits', () => {
  it.each([
    ['Find groups near you'],
    ['AI-powered'],
    ['a seamless way to meet'],
    ['It is an immutable record'],
    ['Empower your members']
  ])('flags "%s"', (sample) => {
    expect(voiceHits(sample).length).toBeGreaterThan(0)
  })

  it('flags a banned honesty row from the fixture', () => {
    const row = fixture.banned[0]!
    expect(patterns(voiceHits(`We spoke with the ${row.pattern} last week.`))).toContain(row.pattern)
  })

  it('returns the matching rows, with their pattern', () => {
    expect(patterns(voiceHits('Find groups near you'))).toContain('find groups near you')
  })

  it('flags none of the four templates filled with "Dry run A reading circle"', () => {
    for (const [kind, t] of Object.entries(templateSeed('Dry run A reading circle'))) {
      expect(voiceHits(t), kind).toEqual([])
    }
  })

  it('flags none of plain community wording', () => {
    expect(voiceHits('A reading group that meets online every second Sunday to talk about books.')).toEqual([])
  })

  it('does not apply the sign-up buyer words to a community\'s own words', () => {
    expect(fixture.buyerWords.length).toBeGreaterThan(0)
    const buyer = fixture.buyerWords[0]!
    const sample = `A group of ${buyer.pattern}`
    // The build check applies buyerWords to sign-up screens only; the runtime check must not.
    expect(patterns(voiceHits(sample))).not.toContain(buyer.pattern)
  })
})

describe('voiceHits agrees with the build check (the twin)', () => {
  const samples = [
    'Find groups near you',
    'a local group for your town',
    'AI-powered search',
    'a SEAMLESS experience, seamlessly',
    'auto-executes proposals',
    'executes automatically',
    'Building a Second Brain is a book; a second brain is fine',
    'your area of expertise and your area',
    'It is immutable and unstoppable and revolutionary',
    'We empower, empowering, empowered',
    'censorship-resistant',
    'A reading group that meets online every second Sunday.',
    'Dry run A reading circle uses this site to keep its shared library in one place.',
    ...fixture.banned.map(r => `we are ${r.pattern} today`),
    ...fixture.voiceRules.rules.filter(r => !r.regex).map(r => `about ${r.pattern.toUpperCase()} and more`)
  ]

  it.each(samples.map(s => [s]))('same rows for: %s', (sample) => {
    expect(patterns(voiceHits(sample))).toEqual(patterns(findBannedHits(sample, ROWS)))
  })

  it('every one of the rows is compiled, so a row of its own pattern text is found by both', () => {
    for (const row of ROWS.filter(r => !r.regex)) {
      expect(patterns(voiceHits(`x ${row.pattern} x`)), row.pattern).toContain(row.pattern)
    }
  })
})
