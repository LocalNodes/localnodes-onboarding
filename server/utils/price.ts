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
import type { CodeOffer } from '../../shared/code-offer'
import { inviteKey, type InviteRecord } from './invites'
import { classifyCode, type PromoStripe } from './promo'

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
/**
 * An amount in the currency's smallest unit, as "$20" or "$19.50": a whole
 * amount drops its decimals, a part amount keeps all of them. Null for a
 * currency Intl does not know.
 */
export function formatMoney(minor: number, currency: string): string | null {
  if (!Number.isFinite(minor)) return null
  let digits: number
  try {
    digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return null
  }
  const amount = minor / 10 ** digits
  const shown = Number.isInteger(amount) ? 0 : digits
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: shown, maximumFractionDigits: shown }).format(amount)
}

export function formatPrice(price: PriceLike, currency: string): string | null {
  if (price.unit_amount === null || price.unit_amount === undefined || !price.recurring) return null
  const money = formatMoney(price.unit_amount, currency)
  if (money === null) return null
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

/** The Redis call the invite's code needs: the invite hash, as check-code reads it. */
export interface PriceRedis {
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
}

export interface PriceDeps {
  /** NUXT_LAUNCH_OPEN. */
  open: boolean
  /** The invited session behind the cookie (getInvitedSession), or null. */
  session: InviteRecord | null
  /** Prices, and promotion codes for an invite that carries a code. */
  stripe: PriceStripe & Partial<PromoStripe>
  /** For the invite hash. Without it an invite's code reads unknown. */
  redis?: PriceRedis
  priceId: string
  /** NUXT_STRIPE_CURRENCY. */
  currency: string
  /** runtimeConfig paidSignupsEnabled. Missing reads as closed: a code that is not a pilot then reads none. */
  paidSignupsEnabled?: boolean
  /** Milliseconds. Tests inject it. */
  now?: () => number
  log?: (msg: string) => void
}

export type PriceOutcome =
  | { status: 200, body: { line: string, invited?: true, inviteCode?: { code: string } & CodeOffer } }
  | { status: 404 | 503, body: { message: string } }

/**
 * What the invited session's code offers, so the form words the page before
 * anyone presses "Apply code". The session carries the code text but not the
 * code's id, so the invite hash is read for it (as verifying the invite does).
 * A hash that is another invite's gives none; a read that fails gives unknown.
 */
async function inviteCodeOffer(deps: PriceDeps): Promise<({ code: string } & CodeOffer) | null> {
  const session = deps.session
  const code = session?.promoCode?.trim()
  if (!session || !code) return null
  try {
    if (!deps.redis || !deps.stripe.promotionCodes) throw new Error('not wired')
    const invite = await deps.redis.hgetall(inviteKey(session.emailHmac))
    if (invite && Object.keys(invite).length > 0 && String(invite.inviteId) !== session.inviteId) return { code, offer: 'none' }
    const offer = await classifyCode(
      { code, invite: { inviteId: session.inviteId, promoCodeId: invite?.promoCodeId } },
      { stripe: { promotionCodes: deps.stripe.promotionCodes }, now: deps.now }
    )
    // Closed to paid sign-ups, a code that is not a pilot can't be used (check-code and checkout refuse it).
    if (offer.offer === 'paid' && deps.paidSignupsEnabled !== true) return { code, offer: 'none' }
    return { code, ...offer }
  } catch {
    deps.log?.('price: invite code unreadable')
    return { code, offer: 'unknown' }
  }
}

/** GET /api/price: invited-only while the launch is closed. */
export async function handlePrice(deps: PriceDeps): Promise<PriceOutcome> {
  if (!deps.open && !deps.session) return { status: 404, body: { message: 'Not Found' } }
  try {
    const result = await priceLine(deps.stripe, deps.priceId, deps.currency, (deps.now ?? Date.now)())
    if (result.ok) {
      const inviteCode = await inviteCodeOffer(deps)
      // `invited` says a live invited session stands behind the cookie, whether or
      // not the launch is open: checkout honours that session's code either way,
      // so the form reads it from here and not from the details it was given.
      return { status: 200, body: { line: result.line, ...(deps.session ? { invited: true as const } : {}), ...(inviteCode ? { inviteCode } : {}) } }
    }
    deps.log?.(`price: ${result.reason}`)
  } catch {
    deps.log?.('price: unavailable')
  }
  return { status: 503, body: { message: PRICE_UNAVAILABLE_MESSAGE } }
}
