// Which words the sign-up form shows for the code in its field, and how the
// submit button checks the code before sending anyone to the card page.
// Plain module with no Nuxt globals, so the rules are tested without a browser.
//
// The words follow the CURRENT field value, never the last reply that arrived:
// an empty field reads as a paid sign-up, a code the server has classified
// reads as what it offers, and a code nobody has classified (or whose check
// failed) reads in neutral words that promise nothing.
import { normalizeCode, readCodeOffer, type CodeOffer } from '#shared/code-offer'
import type { CodeResult } from '~/utils/onboarding-flow'

/** The three sets of words: a free pilot (with its months), a paid sign-up, and neutral. */
export type Words = { kind: 'pilot', months: number } | { kind: 'paid' } | { kind: 'neutral' }

/** What the server has said about each code, keyed by the code as the server reads it (trimmed). */
export type KnownOffers = Readonly<Record<string, CodeOffer>>

/**
 * The words for the field's current value. `codesApply` is false when the
 * server ignores codes at checkout (the public flow, no invite): then whatever
 * is typed has no effect and the page reads as a paid sign-up.
 */
export function wordsFor(code: string, known: KnownOffers, codesApply = true): Words {
  const normal = normalizeCode(code)
  if (!normal || !codesApply) return { kind: 'paid' }
  const offer = Object.prototype.hasOwnProperty.call(known, normal) ? known[normal] : undefined
  if (offer?.offer === 'pilot') return { kind: 'pilot', months: offer.months }
  if (offer?.offer === 'paid') return { kind: 'paid' }
  return { kind: 'neutral' }
}

/** True when two sets of words are the same words (same kind and, for a pilot, same months). */
export function sameWords(a: Words, b: Words): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'pilot' || (b.kind === 'pilot' && a.months === b.months)
}

/** The offer GET /api/price carried for the invited session's code, keyed by that code; nothing when it carried none. */
export function offersFromPrice(reply: unknown): KnownOffers {
  const invite = (reply as { inviteCode?: { code?: unknown } } | null)?.inviteCode
  if (!invite || typeof invite.code !== 'string') return {}
  const code = normalizeCode(invite.code)
  return code ? { [code]: readCodeOffer(invite) } : {}
}

/**
 * Tells a check that has been overtaken from one that has not. Starting a check
 * takes a ticket; any edit to the field voids every ticket given so far, and a
 * reply is used only while its ticket is still current.
 */
export function createApplyGuard() {
  let current = 0
  return {
    begin: (): number => ++current,
    invalidate: (): void => { current++ },
    isCurrent: (ticket: number): boolean => ticket === current
  }
}

/** What pressing the submit button does about the code. */
export type SubmitDecision =
  /** Go on to the card page. */
  | { kind: 'continue' }
  /** The code's offer changes the words on screen: show the new words and wait for a second press. */
  | { kind: 'show', code: string, offer: CodeOffer }
  /** The check refused the code or could not be made: show the message and stay. */
  | { kind: 'stop', code: string, offer: CodeOffer, message: string }
  /** The field changed while the check ran: its answer is for a code that is gone. Do nothing. */
  | { kind: 'overtaken' }

/**
 * The check before the card page. No code (or a public sign-up, whose codes the
 * server ignores) goes straight on. Otherwise the server checks the code, which
 * also places the hold on it, and the answer is compared with the words already
 * on screen: if they differ the person sees the new words first and a second
 * press continues.
 */
export async function decideSubmit(input: {
  code: string
  codesApply: boolean
  known: KnownOffers
  check: (code: string) => Promise<CodeResult>
  /** The field's value right now, read after the check returns. */
  current: () => string
}): Promise<SubmitDecision> {
  const code = normalizeCode(input.code)
  if (!code || !input.codesApply) return { kind: 'continue' }
  const onScreen = wordsFor(code, input.known, input.codesApply)
  const result = await input.check(code)
  if (normalizeCode(input.current()) !== code) return { kind: 'overtaken' }
  if (result.kind === 'refused') return { kind: 'stop', code, offer: result.offer, message: result.message }
  const next = wordsFor(code, { ...input.known, [code]: result.offer }, input.codesApply)
  return sameWords(onScreen, next) ? { kind: 'continue' } : { kind: 'show', code, offer: result.offer }
}
