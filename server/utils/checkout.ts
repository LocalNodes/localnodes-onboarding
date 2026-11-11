// Create-checkout logic (Phase 23, plans 23-07 and 23-31; D-02, D-03, D-20, T-3). Plain module,
// no Nitro globals: Stripe, Redis and the invited session are injected, so the
// tests import it directly and server/api/create-checkout.post.ts only wires it up.
//
// While NUXT_LAUNCH_OPEN is closed, only an invited person gets a checkout, and
// the email Stripe sees is the one on their invited session (the server's
// record), never anything the browser sends (T-23-22). The session carries
// "invited", the invite id and a provision id in its metadata; the webhook
// re-checks all of it before it provisions anything (stripe-webhook.ts).
//
// Checkout runs in setup mode (T-3): it saves and verifies the organizer's card
// and charges nothing. The subscription, and the first charge, come later, when
// the build reports ready (23-32). No session sends line items, subscription
// data, discounts or a card-collection setting.
//
// Server room (23-17, D-08): after the invite checks and before any code hold,
// record or Stripe call, the checkout asks whether the server has room. When it
// is full, or its room is unknown, the answer is 409 with the full reply and the
// address goes on the waiting list (waiting_for_room "true"); nothing is charged
// and nothing is built.
//
// The AI choice (23-18, D-21): default, or the organizer's own Gemini or
// OpenRouter key. An own key must have been checked for this invited session
// (POST /api/ai-key keeps it sealed at byok:pending:{sha256(sid)}); checkout
// moves it to byok:{provisionId} and records aiProvider and aiKeySource on the
// sign-up. The Stripe session params are the same whatever the choice: the key
// never goes near Stripe.
//
// The paid-sign-up gate (23-32; B-2's Phase 23 part, orchestrator answer 1,
// 2026-11-08 afternoon): until pausing and removal exist for failed renewals,
// a sign-up that is not 100% off is refused here, before any hold, record,
// waiting-list write or Stripe session, unless paidSignupsEnabled
// (NUXT_PAID_SIGNUPS_ENABLED) is true. 100% off is read from the promotion
// code's expanded coupon; anything else (no code, another discount, an
// unexpanded coupon) counts as paid, failing closed.
//
// The browser's time zone (orchestrator, 2026-11-08) is kept on the sign-up
// record when it is a real IANA zone name; anything else is dropped, never
// refused. 23-37's mails format their times with it, falling back to UTC.
//
// Privacy rule, same as invites.ts: the email is never logged and never put in
// a Redis key or in Stripe metadata (Stripe has it as customer_email).
import * as v from 'valibot'
import { randomBytes } from 'node:crypto'
import type Stripe from 'stripe'
import { cleanTopicTypes, signupBodySchema } from '../../shared/signup'
import { inviteKey, type InviteRecord } from './invites'
import { cleanDescription, MAX_DESCRIPTION, MIN_DESCRIPTION } from './topic-types'
import { checkCode, PROMO_REFUSED_MESSAGE, releaseHold, type PromoRedis, type PromoStripe } from './promo'
import { pilotEndsAt } from './pilot-end'
import { errorStatus, FULL_MESSAGE } from './capacity'
import { AI_CHOICES, KEY_NOT_CHECKED_MESSAGE } from '../../shared/ai-choice'
import { attachKeyToProvision, pendingKeyKind, pendingKeyName, returnKeyToSession, type ByoKeyRedis } from './byo-key'
import { markCheckout } from './checkout-marker'

/** A sign-up record outlives its checkout by a day: 2 days. */
export const SIGNUP_TTL_SECONDS = 172800

export const INVITE_USED_MESSAGE = 'This invite has already been used to set up a site.'

/** 23-UI-SPEC section 3, row "Paid sign-ups not open yet" (Q-B2, answered 2026-11-08). */
export const PAID_SIGNUPS_CLOSED_MESSAGE = 'We\'re not taking paid sign-ups yet. If you have a code, enter it above.'

/**
 * runtimeConfig paidSignupsEnabled: open only for true or 'true'. Nitro's env
 * parser turns TRUE and True into true as well; 1, yes and on stay closed.
 */
export function isPaidSignupsEnabled(value: unknown): boolean {
  return value === true || value === 'true'
}

/** An IANA zone name the runtime knows (America/Denver, UTC, Etc/GMT+7), or undefined. Offsets and anything else are dropped. */
export function keptTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 64) return undefined
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(raw)) return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw })
  } catch {
    return undefined
  }
  return raw
}

/**
 * How long Stripe keeps a coded checkout open: a little over Stripe's 30-minute
 * minimum, and under the code's hold (HOLD_TTL_SECONDS), so the hold outlives
 * the session it backs. Without it Stripe's default is 24 hours.
 */
export const COUPON_SESSION_SECONDS = 1830

/** The subset of the Upstash client checkout uses. */
export interface CheckoutRedis extends Partial<PromoRedis> {
  get: <T = unknown>(key: string) => Promise<T | null>
  // Not generic, so the Upstash client (whose hgetall is constrained) fits it.
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  expire: (key: string, seconds: number) => Promise<unknown>
  /** The own-key move (byo-key.ts); only an own-key checkout uses these. */
  del?: (...keys: string[]) => Promise<unknown>
  rename?: (from: string, to: string) => Promise<unknown>
}

export interface StripeCheckoutLike extends Partial<PromoStripe> {
  // Stripe always returns the session id; checkout marks it (checkout-marker.ts, 23-20 follow-up).
  checkout: { sessions: { create: (params: Stripe.Checkout.SessionCreateParams) => Promise<{ id?: string, url: string | null }> } }
}

export interface CheckoutDeps {
  /** NUXT_LAUNCH_OPEN. */
  open: boolean
  /** The invited session behind the cookie (getInvitedSession), or null. */
  session: InviteRecord | null
  /** sha256 of the session cookie value: where POST /api/ai-key kept a checked key (23-18). */
  sessionHash?: string | null
  stripe: StripeCheckoutLike
  /** Needed for an invited checkout; an uninvited checkout while open never touches Redis. */
  redis?: CheckoutRedis
  /**
   * The Stripe price in force at checkout. Frozen on signup:{provisionId} as
   * priceId (23-43 Task 3, D3): 23-32 starts the subscription with the frozen
   * value, never with the runtime price of that later moment.
   */
  priceId: string
  /** Lowercase three-letter currency of the Stripe price (NUXT_STRIPE_CURRENCY). Setup mode needs it; empty refuses the checkout. */
  currency: string
  origin: string
  /** Milliseconds. Tests inject it. */
  now?: () => number
  /** 16 random bytes, base64url: 22 characters. */
  newProvisionId?: () => string
  /** Logs without the email address. */
  log?: (msg: string) => void
  /**
   * The paid-sign-up gate (23-32): false refuses any sign-up that is not 100%
   * off. Required, so no caller forgets it; the route reads
   * NUXT_PAID_SIGNUPS_ENABLED through isPaidSignupsEnabled.
   */
  paidSignupsEnabled: boolean
  /**
   * The OpenRouter choice (23-18 follow-up): false refuses aiChoice openrouter
   * with the bad-request reply, before any read, hold, record or Stripe call.
   * Required, so no caller forgets it; the route reads
   * NUXT_OPENROUTER_CHOICE_ENABLED through isOpenRouterChoiceEnabled.
   */
  openRouterChoiceEnabled: boolean
  /**
   * Server room (23-17, D-08). Required: a checkout never goes ahead without
   * asking. hasRoom is false (or throws) when the server is full or its room is
   * unknown; waitlist keeps the address with waiting_for_room "true".
   */
  capacity: CheckoutCapacity
}

export interface CheckoutCapacity {
  hasRoom: () => Promise<boolean>
  waitlist: (email: string) => Promise<void>
  /** Counts the sign-up in flight (capacity:inflight) once its Stripe session exists. */
  addInflight: (provisionId: string) => Promise<void>
}

export type CheckoutOutcome =
  | { status: 200, body: { url: string } }
  | { status: number, body: { message: string } }

// The email field is only read once the public flow is open and there is no
// invited session. An invited checkout never looks at it.
const checkoutBodySchema = v.object({
  ...signupBodySchema.entries,
  email: v.optional(v.unknown()),
  // A promotion code, only used for an invited checkout; blank counts as none.
  code: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(64))),
  // The community description (23-33, T-2). Anything that is not usable text is
  // dropped in code, never refused: it only seeds the new site's first texts.
  description: v.optional(v.unknown()),
  // The AI choice (23-18); left out, it is the LocalNodes default.
  aiChoice: v.optional(v.picklist([...AI_CHOICES]), 'default'),
  // The browser's IANA time zone (23-32); anything unusable is dropped in code, never refused.
  timeZone: v.optional(v.unknown())
})
// The same body while the OpenRouter choice is hidden: openrouter is not a choice.
const checkoutBodyNoOpenRouterSchema = v.object({
  ...checkoutBodySchema.entries,
  aiChoice: v.optional(v.picklist(['default', 'gemini']), 'default')
})
const emailSchema = v.pipe(v.string(), v.trim(), v.email())

/** The description to keep: text, cleaned as the suggestion route cleans it, 10 to 400 characters; otherwise none. */
function keptDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4000) return undefined
  const cleaned = cleanDescription(raw).trim()
  return cleaned.length >= MIN_DESCRIPTION && cleaned.length <= MAX_DESCRIPTION ? cleaned : undefined
}

const refuse = (status: number, message: string): CheckoutOutcome => ({ status, body: { message } })
const notFound = () => refuse(404, 'Not Found')

/** The paid-sign-up gate's refusal (23-32): one fixed log line, the section 3 words. */
function refusePaid(deps: CheckoutDeps): CheckoutOutcome {
  deps.log?.('create-checkout: refused, paid sign-ups not open')
  return refuse(409, PAID_SIGNUPS_CLOSED_MESSAGE)
}

/**
 * The binding room check (D-08), before any hold, record or Stripe call. Null
 * when there is room. When full, the address goes on the waiting list (a failure
 * there is logged without the address) and the full reply is returned.
 */
async function refuseWhenFull(email: string, deps: CheckoutDeps): Promise<CheckoutOutcome | null> {
  let room = false
  try {
    room = (await deps.capacity.hasRoom()) === true
  } catch {
    room = false
  }
  if (room) return null
  deps.log?.('create-checkout: refused, no room on the server')
  try {
    await deps.capacity.waitlist(email)
  } catch (err) {
    deps.log?.(`create-checkout: waiting list not updated (status ${errorStatus(err)})`)
  }
  return refuse(409, FULL_MESSAGE)
}

export async function handleCreateCheckout(raw: unknown, deps: CheckoutDeps): Promise<CheckoutOutcome> {
  const session = deps.session && deps.session.email && deps.session.emailHmac && deps.session.inviteId ? deps.session : null
  if (!deps.open && !session) {
    deps.log?.('create-checkout: refused, no invited session')
    return notFound()
  }
  const parsed = v.safeParse(deps.openRouterChoiceEnabled === true ? checkoutBodySchema : checkoutBodyNoOpenRouterSchema, raw)
  if (!parsed.success) return refuse(400, 'Please check the sign-up details and try again.')
  const input = parsed.output
  // The public flow has no code: with the gate closed it is refused first
  // thing, before the currency check, the room check or any Stripe call.
  if (!session && !deps.paidSignupsEnabled) return refusePaid(deps)
  const successUrl = `${deps.origin}/success?session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${deps.origin}/cancel`
  // Setup mode cannot start without the price's currency. Checked before any
  // read, hold, write or Stripe call, so a missing setting leaves nothing behind.
  const currency = deps.currency.trim().toLowerCase()
  if (!currency) {
    deps.log?.('create-checkout: refused, no currency configured')
    return refuse(500, 'Failed to create checkout session')
  }

  if (session) {
    const redis = deps.redis
    if (!redis) throw new Error('create-checkout: redis not provided for an invited checkout')
    // The invite must still exist, belong to this session, and be unused.
    const invite = await redis.hgetall(inviteKey(session.emailHmac))
    if (!invite || String(invite.inviteId) !== session.inviteId) {
      deps.log?.('create-checkout: refused, invite not found')
      return notFound()
    }
    const claimed = await redis.get(`invite:u:${session.inviteId}`)
    if (invite.status !== 'open' || claimed) {
      deps.log?.('create-checkout: refused, invite already used')
      return refuse(409, INVITE_USED_MESSAGE)
    }
    // No code and the gate closed: a paid sign-up, refused before the room
    // check, so nothing is held, written or waitlisted (23-32).
    if (!deps.paidSignupsEnabled && !input.code) return refusePaid(deps)
    // No room, or room unknown: no hold, no record, no Stripe session (D-08).
    const full = await refuseWhenFull(session.email, deps)
    if (full) return full
    // An own key must be checked, for this session and this kind, before any
    // hold, record or Stripe call: a refusal here leaves nothing behind.
    const ownKey = input.aiChoice !== 'default'
    if (ownKey) {
      const kind = deps.sessionHash ? await pendingKeyKind(redis, deps.sessionHash) : null
      if (kind !== input.aiChoice || !redis.rename || !redis.del) {
        deps.log?.('create-checkout: refused, no checked key for the AI choice')
        return refuse(400, KEY_NOT_CHECKED_MESSAGE)
      }
    }
    // A code is checked again here, and held for this invite, before anything
    // is written or Stripe is called: a used or held code never reaches either.
    let promoId: string | undefined
    let couponId: string | undefined
    let pilotMonths: number | undefined
    if (input.code) {
      if (!deps.stripe.promotionCodes || !redis.eval || !redis.zrem) throw new Error('create-checkout: promotion codes not wired')
      const checked = await checkCode(
        { code: input.code, holder: session.inviteId, invite },
        { stripe: deps.stripe as PromoStripe, redis: redis as PromoRedis, now: deps.now }
      )
      if (!checked.ok) {
        deps.log?.('create-checkout: refused, code not usable')
        return refuse(409, PROMO_REFUSED_MESSAGE)
      }
      // A code that is not 100% off is still a paid sign-up: let the hold go first.
      if (!deps.paidSignupsEnabled && !checked.fullDiscount) {
        await releaseHold(redis as PromoRedis, checked.promoId, session.inviteId).catch(() => {})
        return refusePaid(deps)
      }
      promoId = checked.promoId
      couponId = checked.couponId || undefined
      pilotMonths = checked.pilotMonths
    }
    const provisionId = (deps.newProvisionId ?? (() => randomBytes(16).toString('base64url')))()
    const topicTypes = cleanTopicTypes(input.topicTypes)
    // Seeds the new site's first texts (T-2). Never logged, never sent to Stripe.
    const description = keptDescription(input.description)
    const timeZone = keptTimeZone(input.timeZone)
    // Written before Stripe is called, so the record is there when the webhook
    // fires. provision:by-id is 23-11's.
    const key = `signup:${provisionId}`
    await redis.hset(key, {
      subdomain: input.subdomain,
      communityName: input.communityName,
      email: session.email,
      inviteId: session.inviteId,
      topicTypes,
      aiProvider: ownKey ? input.aiChoice : 'gemini',
      aiKeySource: ownKey ? 'organizer' : 'platform',
      ...(promoId ? { promoId } : {}),
      // Frozen for the subscription at ready (23-43 Task 3, D3): billing never reads the runtime price.
      ...(deps.priceId ? { priceId: deps.priceId } : {}),
      ...(couponId ? { couponId } : {}),
      // A free pilot's months and end, frozen here (pilot-end.ts): billing sets cancel_at from them.
      ...(pilotMonths ? { pilotMonths, pilotEndsAt: pilotEndsAt(Math.floor((deps.now ?? Date.now)() / 1000), pilotMonths) } : {}),
      ...(description ? { description } : {}),
      ...(timeZone ? { timeZone } : {}),
      // The browser that made this sign-up (sha256 of its ln_invite cookie):
      // only it gets the "Confirm my payment" button on a 3DS hold (23-37).
      ...(deps.sessionHash ? { ownerSessionHash: deps.sessionHash } : {}),
      createdAt: new Date().toISOString()
    })
    await redis.expire(key, SIGNUP_TTL_SECONDS)
    const keyRedis = redis as CheckoutRedis & ByoKeyRedis
    if (ownKey) {
      // Moved before Stripe is called, so the slot is there when the workflow asks.
      await attachKeyToProvision(keyRedis, deps.sessionHash!, provisionId)
    } else if (deps.sessionHash && redis.del) {
      // The default stores no key: one checked earlier and not chosen is forgotten.
      await redis.del(pendingKeyName(deps.sessionHash))
    }
    // No session, so the key goes back to the organizer's session: a second try needs no new check.
    const giveKeyBack = async () => {
      if (ownKey) await returnKeyToSession(keyRedis, provisionId, deps.sessionHash!).catch(() => {})
    }
    const metadata: Record<string, string> = {
      invited: 'true',
      invite_id: session.inviteId,
      provision_id: provisionId,
      subdomain: input.subdomain,
      communityName: input.communityName
    }
    // setup_intent_data takes metadata only: a SetupIntent's usage already
    // defaults to off_session, and Checkout accepts no usage parameter (23-22
    // Task 1 reads it off the first test-mode SetupIntent).
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'setup',
      currency,
      customer_creation: 'always',
      customer_email: session.email,
      metadata,
      setup_intent_data: { metadata },
      success_url: successUrl,
      cancel_url: cancelUrl
    }
    if (promoId) {
      metadata.promo_id = promoId
      // The hold has to outlive the session; the webhook re-arms it on completion.
      params.expires_at = Math.floor((deps.now ?? Date.now)() / 1000) + COUPON_SESSION_SECONDS
    }
    let created: { id?: string, url: string | null }
    try {
      created = await deps.stripe.checkout.sessions.create(params)
    } catch (err) {
      // No session, so nothing will ever expire this hold: let it go now.
      if (promoId) await releaseHold(redis as PromoRedis, promoId, session.inviteId).catch(() => {})
      await giveKeyBack()
      throw err
    }
    if (!created.url) {
      if (promoId) await releaseHold(redis as PromoRedis, promoId, session.inviteId).catch(() => {})
      await giveKeyBack()
      return refuse(500, 'Failed to create checkout session')
    }
    // Mark the session, so /success can tell it, still waiting for its
    // webhook, from an id that is not ours (23-20 follow-up). A failure here
    // is logged and never blocks a checkout that already exists.
    if (typeof created.id === 'string' && created.id) {
      try {
        await markCheckout(redis, created.id, deps.now)
      } catch {
        deps.log?.('create-checkout: session not marked')
      }
    }
    // Room is held from here until the build completes, the sign-up is stopped
    // or the checkout expires (23-17). A failure here only means the sign-up is
    // not counted; it never blocks a checkout that already exists.
    try {
      await deps.capacity.addInflight(provisionId)
    } catch {
      deps.log?.('create-checkout: in-flight count not updated')
    }
    return { status: 200, body: { url: created.url } }
  }

  // Launch open, no invited session: the public flow, as it was before Phase 23.
  const email = v.safeParse(emailSchema, input.email)
  if (!email.success) return refuse(400, 'Please enter a valid email address.')
  const fullPublic = await refuseWhenFull(email.output, deps)
  if (fullPublic) return fullPublic
  const publicMetadata = { communityName: input.communityName, subdomain: input.subdomain, email: email.output }
  const created = await deps.stripe.checkout.sessions.create({
    mode: 'setup',
    currency,
    customer_creation: 'always',
    customer_email: email.output,
    metadata: publicMetadata,
    setup_intent_data: { metadata: publicMetadata },
    success_url: successUrl,
    cancel_url: cancelUrl
  })
  if (!created.url) return refuse(500, 'Failed to create checkout session')
  return { status: 200, body: { url: created.url } }
}
