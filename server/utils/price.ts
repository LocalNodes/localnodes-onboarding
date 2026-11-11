// The price line the sign-up form shows above "Continue to card details"
// (Phase 23, plan 23-31, T-3, UI-SPEC section 3). Checkout runs in setup mode, so
// Stripe's own page shows no price; this reads it from the Stripe price on the
// server, for example "$20 a month". Plain module, no Nitro globals: Stripe is
// injected, so tests import it directly and server/api/price.get.ts only wires it.
//
// The Stripe price is cached in module memory for 10 minutes. A Stripe error is
// never cached. A price that is not in the configured currency (the currency
// setup-mode checkout will use), has no amount, or is not recurring is refused:
// the form must never show a price the card will not be charged.
//
// Privacy rule: logs hold the short fixed lines below, never an error text.
import type { InviteRecord } from './invites'

/** How long a retrieved Stripe price is reused. */
export const PRICE_CACHE_SECONDS = 600

/** UI-SPEC "Checkout could not start". */
export const PRICE_UNAVAILABLE_MESSAGE = "We couldn't start checkout. Try again in a moment."

/** The subset of a Stripe price the line reads. */
export interface PriceLike {
  unit_amount: number | null
  currency: string
  recurring: { interval: 'day' | 'week' | 'month' | 'year', interval_count: number } | null
}

export interface PriceStripe {
  prices: { retrieve: (id: string) => Promise<PriceLike> }
}

export type PriceLineResult = { ok: true, line: string } | { ok: false, reason: 'unavailable' | 'currency mismatch' }

const cache = new Map<string, { price: PriceLike, at: number }>()

/** Forget every cached price. For tests. */
export function resetPriceCache(): void {
  cache.clear()
}

/** "$20 a month" for a recurring price in `currency`, or null when it has no amount or no interval. */
export function formatPrice(price: PriceLike, currency: string): string | null {
  if (price.unit_amount === null || price.unit_amount === undefined || !price.recurring) return null
  let digits: number
  try {
    digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return null
  }
  const amount = price.unit_amount / 10 ** digits
  // A whole amount reads "$20", never "$20.00"; a part amount keeps all its decimals ("$19.50").
  const shown = Number.isInteger(amount) ? 0 : digits
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: shown, maximumFractionDigits: shown }).format(amount)
  const { interval, interval_count: count } = price.recurring
  return count === 1 ? `${money} a ${interval}` : `${money} every ${count} ${interval}s`
}

/**
 * The price line for a Stripe price, or a refusal. `currency` is the
 * configured one (lowercase). Throws what Stripe throws; the caller turns that
 * into "unavailable" and nothing is cached.
 */
export async function priceLine(stripe: PriceStripe, priceId: string, currency: string, now: number = Date.now()): Promise<PriceLineResult> {
  const wanted = currency.trim().toLowerCase()
  if (!priceId || !wanted) return { ok: false, reason: 'unavailable' }
  let hit = cache.get(priceId)
  if (!hit || now - hit.at >= PRICE_CACHE_SECONDS * 1000) {
    const price = await stripe.prices.retrieve(priceId)
    hit = { price, at: now }
    cache.set(priceId, hit)
  }
  if (String(hit.price.currency).toLowerCase() !== wanted) return { ok: false, reason: 'currency mismatch' }
  const line = formatPrice(hit.price, wanted)
  return line === null ? { ok: false, reason: 'unavailable' } : { ok: true, line }
}

export interface PriceDeps {
  /** NUXT_LAUNCH_OPEN. */
  open: boolean
  /** The invited session behind the cookie (getInvitedSession), or null. */
  session: InviteRecord | null
  stripe: PriceStripe
  priceId: string
  /** NUXT_STRIPE_CURRENCY. */
  currency: string
  /** Milliseconds. Tests inject it. */
  now?: () => number
  log?: (msg: string) => void
}

export type PriceOutcome =
  | { status: 200, body: { line: string } }
  | { status: 404 | 503, body: { message: string } }

/** GET /api/price: invited-only while the launch is closed. */
export async function handlePrice(deps: PriceDeps): Promise<PriceOutcome> {
  if (!deps.open && !deps.session) return { status: 404, body: { message: 'Not Found' } }
  try {
    const result = await priceLine(deps.stripe, deps.priceId, deps.currency, (deps.now ?? Date.now)())
    if (result.ok) return { status: 200, body: { line: result.line } }
    deps.log?.(`price: ${result.reason}`)
  } catch {
    deps.log?.('price: unavailable')
  }
  return { status: 503, body: { message: PRICE_UNAVAILABLE_MESSAGE } }
}
