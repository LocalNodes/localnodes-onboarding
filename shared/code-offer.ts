// What a promotion code offers, as the sign-up form needs to word the page.
// Plain module shared by the server (which reads Stripe) and the form (which
// reads the server's reply). The server decides; this file only names the
// four answers and reads them back defensively.

/**
 * pilot: a free pilot of `months` months. paid: a valid code that is not a free
 * pilot (a discount). none: refused, unknown or empty. unknown: Stripe could
 * not be read, so nothing is known. Unknown is never treated as paid.
 */
export type CodeOffer =
  | { offer: 'pilot', months: number }
  | { offer: 'paid' }
  | { offer: 'none' }
  | { offer: 'unknown' }

/** A reply body's offer, or unknown when it has none or a shape that is not one of the four. */
export function readCodeOffer(body: unknown): CodeOffer {
  const b = (body ?? {}) as { offer?: unknown, months?: unknown }
  if (b.offer === 'pilot' && typeof b.months === 'number' && Number.isInteger(b.months) && b.months >= 1) {
    return { offer: 'pilot', months: b.months }
  }
  if (b.offer === 'paid') return { offer: 'paid' }
  if (b.offer === 'none') return { offer: 'none' }
  return { offer: 'unknown' }
}

/** The code the way the server reads it: trimmed. Offers are kept per normalized code. */
export const normalizeCode = (code: string): string => code.trim()

/** "three" for 3, a numeral for any other count. */
export const monthsWord = (months: number): string => (months === 3 ? 'three' : String(months))

/** "three months", "1 month", "6 months". */
export const monthsPhrase = (months: number): string => `${monthsWord(months)} ${months === 1 ? 'month' : 'months'}`
