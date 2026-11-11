// Which words the sign-up form shows for the code in its field, and the check
// the submit button makes first (app/utils/offer.ts). Plain logic: the "late
// reply", "edit after apply" and "press without applying" cases are decided
// here, so they are tested here without a browser.
import { describe, it, expect, vi } from 'vitest'
import { createApplyGuard, decideSubmit, offersFromPrice, sameWords, wordsFor, type KnownOffers } from '~/utils/offer'
import { CODE_UNCHECKED_MESSAGE, type CodeResult } from '~/utils/onboarding-flow'

const PILOT: KnownOffers = { 'PILOT-ONE': { offer: 'pilot', months: 3 } }
const accepted = (offer: { offer: 'pilot', months: number } | { offer: 'paid' }): CodeResult => ({ kind: 'accepted', offer })

describe('wordsFor: the words follow the field now', () => {
  it('an empty field, or only spaces, reads as a paid sign-up', () => {
    expect(wordsFor('', PILOT)).toEqual({ kind: 'paid' })
    expect(wordsFor('   ', PILOT)).toEqual({ kind: 'paid' })
  })

  it('a code the server called a pilot reads as that pilot, with spaces around it ignored', () => {
    expect(wordsFor('PILOT-ONE', PILOT)).toEqual({ kind: 'pilot', months: 3 })
    expect(wordsFor('  PILOT-ONE\t', PILOT)).toEqual({ kind: 'pilot', months: 3 })
  })

  it('a discount code reads as paid', () => {
    expect(wordsFor('TEN-OFF', { 'TEN-OFF': { offer: 'paid' } })).toEqual({ kind: 'paid' })
  })

  it('a code nobody has classified, a refused code and an unknown reply all read neutral', () => {
    expect(wordsFor('OTHER', PILOT)).toEqual({ kind: 'neutral' })
    expect(wordsFor('GONE', { GONE: { offer: 'none' } })).toEqual({ kind: 'neutral' })
    expect(wordsFor('PILOT-ONE', { 'PILOT-ONE': { offer: 'unknown' } })).toEqual({ kind: 'neutral' })
  })

  it('editing a pilot code after it was applied returns the page to neutral, and clearing it to paid', () => {
    expect(wordsFor('PILOT-ONE', PILOT).kind).toBe('pilot')
    expect(wordsFor('PILOT-ONEx', PILOT).kind).toBe('neutral')
    expect(wordsFor('', PILOT).kind).toBe('paid')
  })

  it('a late reply for a code that is no longer in the field changes nothing on screen', () => {
    // The person applied PILOT-ONE, then typed a different code; PILOT-ONE's reply lands now.
    expect(wordsFor('SECOND-CODE', { ...PILOT })).toEqual({ kind: 'neutral' })
    expect(wordsFor('', { ...PILOT })).toEqual({ kind: 'paid' })
  })

  it('a name such as constructor is not a known code', () => {
    expect(wordsFor('constructor', {})).toEqual({ kind: 'neutral' })
  })

  it('a public sign-up, whose codes the server ignores, always reads paid', () => {
    expect(wordsFor('PILOT-ONE', PILOT, false)).toEqual({ kind: 'paid' })
  })

  it('sameWords compares kind and, for a pilot, the months', () => {
    expect(sameWords({ kind: 'pilot', months: 3 }, { kind: 'pilot', months: 3 })).toBe(true)
    expect(sameWords({ kind: 'pilot', months: 3 }, { kind: 'pilot', months: 6 })).toBe(false)
    expect(sameWords({ kind: 'paid' }, { kind: 'neutral' })).toBe(false)
  })
})

describe('offersFromPrice', () => {
  it('reads the invite code\'s offer from the price reply, keyed by the trimmed code', () => {
    expect(offersFromPrice({ line: '$20 a month', inviteCode: { code: ' PILOT-ONE ', offer: 'pilot', months: 3 } })).toEqual(PILOT)
    expect(offersFromPrice({ line: '$20 a month', inviteCode: { code: 'TEN-OFF', offer: 'paid' } })).toEqual({ 'TEN-OFF': { offer: 'paid' } })
  })

  it('a reply with no invite code, or one with an offer it cannot read, gives nothing or unknown', () => {
    expect(offersFromPrice({ line: '$20 a month' })).toEqual({})
    expect(offersFromPrice(null)).toEqual({})
    expect(offersFromPrice({ inviteCode: { code: 'X', offer: 'free-forever' } })).toEqual({ X: { offer: 'unknown' } })
  })
})

describe('createApplyGuard: a check that was overtaken by an edit is dropped', () => {
  it('a ticket is current until the field is edited', () => {
    const guard = createApplyGuard()
    const ticket = guard.begin()
    expect(guard.isCurrent(ticket)).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(ticket)).toBe(false)
  })

  it('a newer check voids an older one that is still on its way', () => {
    const guard = createApplyGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
  })
})

describe('decideSubmit: the check before the card page', () => {
  const never = vi.fn(async (): Promise<CodeResult> => { throw new Error('should not be asked') })

  it('submitting with no code at all goes straight on, without asking the server (the paid path)', async () => {
    expect(await decideSubmit({ code: '', codesApply: true, known: {}, check: never, current: () => '' })).toEqual({ kind: 'continue' })
    expect(await decideSubmit({ code: '   ', codesApply: true, known: {}, check: never, current: () => '   ' })).toEqual({ kind: 'continue' })
    expect(never).not.toHaveBeenCalled()
  })

  it('a public sign-up goes straight on even with something typed, since the server ignores its code', async () => {
    expect(await decideSubmit({ code: 'PILOT-ONE', codesApply: false, known: {}, check: never, current: () => 'PILOT-ONE' })).toEqual({ kind: 'continue' })
    expect(never).not.toHaveBeenCalled()
  })

  it('a code whose offer matches the words on screen goes on', async () => {
    const check = vi.fn(async () => accepted({ offer: 'pilot', months: 3 }))
    expect(await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: PILOT, check, current: () => 'PILOT-ONE' })).toEqual({ kind: 'continue' })
    expect(check).toHaveBeenCalledWith('PILOT-ONE')
  })

  it('submitting without pressing Apply: the offer changes the words, so the new words show and nothing continues', async () => {
    const check = async () => accepted({ offer: 'pilot', months: 3 })
    expect(await decideSubmit({ code: ' PILOT-ONE ', codesApply: true, known: {}, check, current: () => ' PILOT-ONE ' }))
      .toEqual({ kind: 'show', code: 'PILOT-ONE', offer: { offer: 'pilot', months: 3 } })
  })

  it('the second press continues, because the words on screen now match', async () => {
    const check = async () => accepted({ offer: 'pilot', months: 3 })
    const first = await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: {}, check, current: () => 'PILOT-ONE' })
    expect(first.kind).toBe('show')
    const known: KnownOffers = { 'PILOT-ONE': first.kind === 'show' ? first.offer : { offer: 'unknown' } }
    expect(await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known, check, current: () => 'PILOT-ONE' })).toEqual({ kind: 'continue' })
  })

  it('a code that was believed to be a pilot but is now a discount shows the new words', async () => {
    const check = async () => accepted({ offer: 'paid' })
    expect(await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: PILOT, check, current: () => 'PILOT-ONE' }))
      .toEqual({ kind: 'show', code: 'PILOT-ONE', offer: { offer: 'paid' } })
  })

  it('a pilot whose months changed shows the new words', async () => {
    const check = async () => accepted({ offer: 'pilot', months: 6 })
    expect((await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: PILOT, check, current: () => 'PILOT-ONE' })).kind).toBe('show')
  })

  it('a discount code not yet applied shows its words first (neutral were on screen); once applied it goes on', async () => {
    const check = async () => accepted({ offer: 'paid' })
    expect((await decideSubmit({ code: 'TEN-OFF', codesApply: true, known: {}, check, current: () => 'TEN-OFF' })).kind).toBe('show')
    expect(await decideSubmit({ code: 'TEN-OFF', codesApply: true, known: { 'TEN-OFF': { offer: 'paid' } }, check, current: () => 'TEN-OFF' })).toEqual({ kind: 'continue' })
  })

  it('a refused code stops, with the server\'s message and the offer none', async () => {
    const check = async (): Promise<CodeResult> => ({ kind: 'refused', message: 'That code can\'t be used.', offer: { offer: 'none' } })
    expect(await decideSubmit({ code: 'USED', codesApply: true, known: {}, check, current: () => 'USED' }))
      .toEqual({ kind: 'stop', code: 'USED', offer: { offer: 'none' }, message: 'That code can\'t be used.' })
  })

  it('an unknown reply stops with the "could not check" message and never reads as paid', async () => {
    const check = async (): Promise<CodeResult> => ({ kind: 'refused', message: CODE_UNCHECKED_MESSAGE, offer: { offer: 'unknown' } })
    const decision = await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: PILOT, check, current: () => 'PILOT-ONE' })
    expect(decision).toEqual({ kind: 'stop', code: 'PILOT-ONE', offer: { offer: 'unknown' }, message: CODE_UNCHECKED_MESSAGE })
    expect(wordsFor('PILOT-ONE', { 'PILOT-ONE': decision.kind === 'stop' ? decision.offer : { offer: 'paid' } })).toEqual({ kind: 'neutral' })
  })

  it('a reply that lands after the field was edited is dropped: nothing continues and nothing shows', async () => {
    let field = 'PILOT-ONE'
    const check = async () => { field = 'SOMETHING-ELSE'; return accepted({ offer: 'pilot', months: 3 }) }
    expect(await decideSubmit({ code: 'PILOT-ONE', codesApply: true, known: {}, check, current: () => field })).toEqual({ kind: 'overtaken' })
  })
})
