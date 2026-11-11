// Promotion codes (Phase 23, plan 23-15; Tom's decisions D-06 and D-09, ONB-04).
// Plain module, no Nitro globals: Stripe and Redis are injected, so tests import
// it directly; server/api/check-code.post.ts and the checkout and webhook wiring
// use it.
//
// A pilot gets a single-use Stripe promotion code (max_redemptions 1, 100% off);
// a wave can share one code with a higher limit. A code is checked BEFORE
// checkout and before any site is built:
//   1. Stripe is asked for the active code. None, expired, or at its
//      max_redemptions: refused.
//   2. A code bound to an invite (the invite's promoCodeId, or the invite id
//      Stripe has on the code) works only for that invite.
//   3. The code is held in Redis for the checkout's life, counting live holds
//      against what is left of max_redemptions, so two open checkouts cannot
//      both take the last use (Stripe's own behaviour when two sessions race on
//      a one-use code is not documented, so this hold is the guard).
// Every refusal gets the same words (T-23-48): nothing says which codes exist.
//
// Who holds: the invite id, not the provision id. The form's check-code call
// and create-checkout both run for the same invited person, and the provision
// id is only made inside create-checkout; with one stable holder the second
// call refreshes the first hold instead of counting against it. The webhook
// finds the holder again in the session metadata (invite_id).
//
// Under T-3 (23-31) checkout only saves a card, so Stripe counts a redemption
// when 23-32 starts the subscription, not at checkout. The hold therefore has to
// outlive the build: a completed session re-arms it for the provisioning window
// (PROVISIONING_HOLD_SECONDS), 23-32 releases it once the first invoice is paid
// (and re-arms it until the deadline of a held 3DS payment), and 23-14 on a
// final stop. An expired session still releases it at once.
//
// Privacy rule: the code, the invite id and the holder are never logged.
import type Stripe from 'stripe'
import { pilotMonthsOf } from './pilot-end'

/** The one refusal, for every kind of failure. Words from 22-UI-SPEC Part 7. */
export const PROMO_REFUSED_MESSAGE = 'This code has already been used. Ask whoever gave it to you for a new one.'

/** A hold outlives the Stripe session it backs: Stripe's session life is 1830 s, a hold is 1860 s. */
export const HOLD_TTL_SECONDS = 1860

/**
 * How long a completed session's hold lasts: the provisioning lock's 1 hour,
 * plus one retry's hour, plus 10 minutes (T-3 step 2).
 */
export const PROVISIONING_HOLD_SECONDS = 7800

/** The subset of the Upstash client the promo code uses. */
export interface PromoRedis {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
  zrem: (key: string, ...members: string[]) => Promise<unknown>
}

/** The subset of a Stripe promotion code the check reads. */
export interface PromoLike {
  id: string
  active?: boolean
  /** Unix seconds, or null. */
  expires_at: number | null
  max_redemptions: number | null
  times_redeemed: number
  metadata?: Record<string, string> | null
  /** The coupon behind the code (API 2026-02-25.clover); an object only when expanded. */
  promotion?: { coupon?: string | { id?: string, percent_off?: number | null, amount_off?: number | null, duration?: string | null, duration_in_months?: number | null } | null } | null
}

export interface PromoStripe {
  promotionCodes: {
    list: (params: { code: string, active: boolean, limit: number, expand?: string[] }) => Promise<{ data: PromoLike[] }>
  }
}

export interface CheckCodeDeps {
  stripe: PromoStripe
  redis: PromoRedis
  /** Milliseconds. Tests inject it. */
  now?: () => number
}

/** The invite fields the check reads. */
export interface PromoInvite {
  inviteId?: unknown
  promoCodeId?: unknown
}

/** fullDiscount: the code's coupon is 100% off (23-32's paid-sign-up gate lets it through). */
/** couponId: the code's coupon (an expanded one's id, or the id as given), frozen on the sign-up at checkout (23-43 Task 3, D3); empty when unknown. */
/** pilotMonths: a 100%-off code's free months (pilot-end.ts pilotMonthsOf); set only for a free pilot. */
export type CheckCodeResult = { ok: true, promoId: string, fullDiscount: boolean, couponId: string, pilotMonths?: number } | { ok: false }

/** The coupon id behind a promotion code, expanded or not; empty when there is none. */
export function couponIdOf(promo: PromoLike): string {
  const coupon = promo.promotion?.coupon
  if (typeof coupon === 'string') return coupon
  return typeof coupon === 'object' && coupon !== null && typeof coupon.id === 'string' ? coupon.id : ''
}

/** True only for an expanded coupon whose percent_off is exactly 100. An id, amount_off or nothing fails closed. */
export function isFullDiscount(promo: PromoLike): boolean {
  const coupon = promo.promotion?.coupon
  return typeof coupon === 'object' && coupon !== null && coupon.percent_off === 100
}

const holdsKey = (promoId: string) => `promo:holds:${promoId}`

/**
 * The hold, as one Redis script so counting and adding cannot interleave with
 * another checkout. ARGV: 1 now (s), 2 expiry score (s), 3 holder, 4 uses left
 * (-1 = no limit), 5 key lifetime (s). Steps: drop expired holds, see whether
 * this holder already holds (a refresh is never counted against itself), count
 * the others, refuse when they fill what is left, otherwise add or refresh.
 * The key's life only ever grows: a later holder must not cut short a hold that
 * was re-armed for the provisioning window (REARM_SCRIPT).
 * Returns 1 for held, 0 for refused.
 */
export const HOLD_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local mine = redis.call('ZSCORE', KEYS[1], ARGV[3])
local others = redis.call('ZCARD', KEYS[1])
if mine then others = others - 1 end
local left = tonumber(ARGV[4])
if left >= 0 and others >= left then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
local ttl = redis.call('TTL', KEYS[1])
if ttl < tonumber(ARGV[5]) then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
return 1
`

/**
 * The same steps in JavaScript, over one sorted set (member to score). FakeRedis
 * has no Lua engine, so the tests register this against HOLD_SCRIPT. Keep it
 * step for step with the script above. (It has no key life to model, so the TTL
 * step is not here; the Lua itself runs first in the 23-22 dry run.)
 */
export function holdScriptTwin(zset: Map<string, number>, args: unknown[]): 0 | 1 {
  const now = Number(args[0])
  const expiry = Number(args[1])
  const holder = String(args[2])
  const left = Number(args[3])
  // Array methods, not for-of: Nitro's prerender transform fails on a for-of in a server util (see 23-07).
  const lapsed = [...zset].filter(([, score]) => score <= now)
  lapsed.forEach(([member]) => zset.delete(member))
  const mine = zset.has(holder)
  let others = zset.size
  if (mine) others -= 1
  if (left >= 0 && others >= left) return 0
  zset.set(holder, expiry)
  return 1
}

/**
 * Hold a code for a holder. `left` is how many uses Stripe says remain (null:
 * no limit). Live holds by other holders count against it. True when held.
 */
export async function holdCode(redis: PromoRedis, promoId: string, holder: string, left: number | null, nowMs: number): Promise<boolean> {
  const nowS = Math.floor(nowMs / 1000)
  const result = await redis.eval(
    HOLD_SCRIPT,
    [holdsKey(promoId)],
    [nowS, nowS + HOLD_TTL_SECONDS, holder, left === null ? -1 : left, HOLD_TTL_SECONDS]
  )
  return Number(result) === 1
}

/**
 * Re-arm a hold for the provisioning window: ARGV 1 expiry score (s), 2 holder,
 * 3 key lifetime (s). ZADD sets the holder's score whether or not the hold was
 * still there, and the key's life is raised to at least the window, never cut.
 * It does not look at what is left: a completed session already owns its use.
 */
export const REARM_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
local ttl = redis.call('TTL', KEYS[1])
if ttl < tonumber(ARGV[3]) then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return 1
`

/** REARM_SCRIPT in JavaScript, for FakeRedis (see holdScriptTwin). */
export function rearmScriptTwin(zset: Map<string, number>, args: unknown[]): 1 {
  zset.set(String(args[1]), Number(args[0]))
  return 1
}

/**
 * A completed session owns its use through the build: hold it for
 * PROVISIONING_HOLD_SECONDS from now. A held 3DS payment (23-32) passes its own
 * seconds, so the hold lasts until the payment's deadline.
 */
export async function rearmHold(redis: PromoRedis, promoId: string, holder: string, nowMs: number, seconds: number = PROVISIONING_HOLD_SECONDS): Promise<void> {
  const nowS = Math.floor(nowMs / 1000)
  await redis.eval(REARM_SCRIPT, [holdsKey(promoId)], [nowS + seconds, holder, seconds])
}

/** Let go of a hold (the session expired, was refused, or its site failed for good). */
export async function releaseHold(redis: PromoRedis, promoId: string, holder: string): Promise<void> {
  await redis.zrem(holdsKey(promoId), holder)
}

/**
 * Look the code up, refuse it if it can't be used, and hold it for `holder`.
 * Lets a Stripe or Redis error through: the caller must not read an outage as
 * "this code is used" (and no checkout starts either way).
 */
export async function checkCode(
  input: { code: string, holder: string, invite: PromoInvite | null },
  deps: CheckCodeDeps
): Promise<CheckCodeResult> {
  const now = deps.now ?? Date.now
  const code = input.code.trim()
  if (!code) return { ok: false }
  // The coupon is expanded so the paid-sign-up gate can tell a 100%-off code (23-32).
  const { data } = await deps.stripe.promotionCodes.list({ code, active: true, limit: 1, expand: ['data.promotion.coupon'] })
  const promo = data[0]
  if (!promo || promo.active === false) return { ok: false }
  if (promo.expires_at != null && promo.expires_at * 1000 <= now()) return { ok: false }
  const left = promo.max_redemptions == null ? null : promo.max_redemptions - promo.times_redeemed
  if (left !== null && left <= 0) return { ok: false }
  // A pilot code belongs to one invite: the invite names it, and add-pilot
  // tags the code with the invite id on Stripe's side. Either mismatch refuses.
  const inviteId = input.invite?.inviteId == null ? undefined : String(input.invite.inviteId)
  const boundCodeId = input.invite?.promoCodeId == null || input.invite.promoCodeId === '' ? undefined : String(input.invite.promoCodeId)
  if (boundCodeId !== undefined && boundCodeId !== promo.id) return { ok: false }
  const taggedInvite = promo.metadata?.invite_id
  if (taggedInvite && taggedInvite !== inviteId) return { ok: false }
  // A free pilot must be able to end by itself (pilot-end.ts): a coupon that
  // can't be read, or a 100%-off one that is forever or has no month count,
  // is refused before anything is held.
  const kind = pilotMonthsOf(promo.promotion?.coupon)
  if ('refuse' in kind) return { ok: false }
  const held = await holdCode(deps.redis, promo.id, input.holder, left, now())
  if (!held) return { ok: false }
  return {
    ok: true,
    promoId: promo.id,
    fullDiscount: isFullDiscount(promo),
    couponId: couponIdOf(promo),
    ...(kind.pilot ? { pilotMonths: kind.months } : {})
  }
}

/** Release the hold a session took (it expired, or its site failed for good): promo_id and invite_id come from its metadata. Nothing to release without both. */
export async function releaseSessionHold(redis: PromoRedis, session: Stripe.Checkout.Session): Promise<void> {
  const promoId = session.metadata?.promo_id
  const holder = session.metadata?.invite_id
  if (!promoId || !holder) return
  await releaseHold(redis, promoId, holder)
}

/** Re-arm the hold a completed session took: promo_id and invite_id come from its metadata. Nothing to re-arm without both. */
export async function rearmSessionHold(redis: PromoRedis, session: Stripe.Checkout.Session, now: () => number = Date.now): Promise<void> {
  const promoId = session.metadata?.promo_id
  const holder = session.metadata?.invite_id
  if (!promoId || !holder) return
  await rearmHold(redis, promoId, holder, now())
}
