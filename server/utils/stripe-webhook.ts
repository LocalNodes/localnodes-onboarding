// Stripe webhook logic (plain module, testable without Nitro). Pre-launch
// (orchestrator ruling, 2026-11-06, PR #9): while NUXT_LAUNCH_OPEN is closed
// the route stays reachable, so Stripe never sees failures and never disables
// the endpoint. The signature is still verified (invalid: 400); a valid event
// gets 200 and NO action, no provisioning and no Redis writes, and only its
// type is logged.
//
// Invited sign-ups (Phase 23, plan 23-07, D-03, D-04): while closed, one kind
// of event still provisions: checkout.session.completed whose metadata says
// invited AND whose server re-check passes (isInvitedCheckout). Everything else
// keeps the behaviour above.
//
// Setup-mode checkout (plan 23-31, T-3): a completed session saved a card and
// charged nothing. Before provisioning starts the webhook stores the customer and
// the saved card on the sign-up record (recordSetup), so the subscription can be
// started once the site is ready (23-32). Nothing here reads payment_status or the
// session's discounts: a setup session has none, and the promotion code is applied
// when the subscription starts.
//
// Promotion codes (plans 23-15 and 23-31, D-06): a completed session RE-ARMS the
// code's hold for the provisioning window (rearmHold) and does not release it;
// 23-32 releases it once the subscription exists, 23-14 on a final stop. A
// checkout.session.expired event releases the hold, open or closed, so holds
// never leak.
//
// Server room (23-17): an expired session also gives back its in-flight count
// (releaseCapacity), and a completed one re-arms it for the build
// (rearmCapacity), next to the code hold.
//
// Invoice events (23-32, B-1 step 8 and the B-2 Phase 23 part): invoice.paid,
// invoice.payment_failed and invoice.payment_action_required go to onInvoice
// before the closed gate, as the expired session does: a first payment held
// for 3DS can be confirmed while the launch is closed, and a renewal can fail
// then too. billing.ts routeInvoiceEvent decides what each one means. A throw
// answers 503 so Stripe retries; a billing lock held by another runner is
// raised as one (review fix, 2026-11-09).
//
// Infrastructure errors (23-31, ruling "Redis down at an invited, paid checkout"):
// when the invited re-check or recordSetup throws, the answer is 503 so Stripe
// retries on its own backoff; only a real refusal (not invited, invite used by
// another session, wrong invite) is a 200 with no action. The claim is
// re-entrant for the same session, so the retry can finish what the first try
// started; the provisioning lock (triggerProvisioning) keeps it to one run.
import type Stripe from 'stripe'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { SIGNUP_TTL_SECONDS } from './checkout'
import { emailKey, inviteKey } from './invites'
import { RECORD_SETUP_SCRIPT } from './lifecycle'

export interface WebhookDeps {
  open: boolean
  constructEvent: (body: string, signature: string) => Stripe.Event
  onCheckoutCompleted: (session: Stripe.Checkout.Session) => Promise<void>
  /**
   * Server re-check for an invited checkout while closed. 'claimed' only when the
   * invite is real, matches the paying email and is claimed by this session
   * (this call, or an earlier delivery of the same session). Never trusts the
   * metadata alone. A throw is an infrastructure error (answered 503).
   */
  isInvitedCheckout?: (session: Stripe.Checkout.Session) => Promise<ClaimResult>
  /**
   * Keeps what a completed setup session says (the customer and the saved card)
   * on the sign-up record, before provisioning starts (T-3). False when there is
   * no sign-up record to put it on. A throw is an infrastructure error.
   */
  recordSetup?: (session: Stripe.Checkout.Session) => Promise<boolean>
  /** Re-arms the promotion-code hold a completed session took for the provisioning window (promo.ts rearmSessionHold). A failure is logged, never raised. */
  rearmHold?: (session: Stripe.Checkout.Session) => Promise<void>
  /** Lets go of the promotion-code hold an expired session took (promo.ts releaseSessionHold). A failure is logged, never raised. */
  releaseHold?: (session: Stripe.Checkout.Session) => Promise<void>
  /** Lets go of the server room an expired session held (capacity.ts releaseSessionCapacity, 23-17). A failure is logged, never raised. */
  releaseCapacity?: (session: Stripe.Checkout.Session) => Promise<void>
  /** Forgets the organizer's own AI key an expired session carried (byo-key.ts releaseSessionKey, 23-18). A failure is logged, never raised. */
  releaseAiKey?: (session: Stripe.Checkout.Session) => Promise<void>
  /** Deletes the checkout marker of an expired session, so /success shows it as not found (checkout-marker.ts forgetCheckout, 23-20 follow-up). A failure is logged, never raised. */
  releaseCheckoutMarker?: (session: Stripe.Checkout.Session) => Promise<void>
  /** Counts a completed session's build in flight for 45 minutes from now (capacity.ts rearmSessionCapacity). A failure is logged, never raised. */
  rearmCapacity?: (session: Stripe.Checkout.Session) => Promise<void>
  /**
   * invoice.paid, invoice.payment_failed and invoice.payment_action_required,
   * open or closed (23-32, billing.ts routeInvoiceEvent). A throw answers 503.
   */
  onInvoice?: (event: Stripe.Event) => Promise<void>
  log: (msg: string) => void
}

/** True when a setup-mode session names its customer and its saved card, both as string ids. */
export function hasSetupIds(session: Stripe.Checkout.Session): boolean {
  return typeof session.customer === 'string' && session.customer !== '' && typeof session.setup_intent === 'string' && session.setup_intent !== ''
}

/** The subset of the Upstash client recordSetupInRedis uses: one script. */
export interface SetupRedis {
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

/**
 * Stores stripeCustomerId and setupIntentId on signup:{provision_id} and
 * refreshes its life, raise-only (23-43 Task 2, review round 1 Codex MEDIUM
 * 7): a redelivered checkout never cuts a 72 h key back to 48 h. The write and
 * the raise are one step (RECORD_SETUP_SCRIPT, code review fix round 1, C6), so
 * a concurrent raise is never undone and a record that ran out is never made
 * again. False when the session has no usable ids or the sign-up record is gone
 * (a record made from the ids alone could not be provisioned). Invalid is raised.
 */
export async function recordSetupInRedis(redis: SetupRedis, session: Stripe.Checkout.Session): Promise<boolean> {
  const provisionId = session.metadata?.provision_id
  if (!provisionId || !PROVISION_ID_PATTERN.test(provisionId) || !hasSetupIds(session)) return false
  const out = String(await redis.eval(RECORD_SETUP_SCRIPT, [`signup:${provisionId}`], [session.customer as string, session.setup_intent as string, String(SIGNUP_TTL_SECONDS * 1000)]))
  if (out === 'recorded') return true
  if (out === 'none') return false
  throw new Error(`stripe-webhook: setup ids could not be recorded (invalid: ${out.startsWith('invalid:') ? out.slice('invalid:'.length) : 'unknown'})`)
}

/** The subset of the Upstash client the invite claim uses. */
export interface ClaimRedis {
  get: <T = unknown>(key: string) => Promise<T | null>
  hgetall: <T = Record<string, unknown>>(key: string) => Promise<T | null>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  set: (key: string, value: unknown, opts?: { nx?: boolean, ex?: number }) => Promise<unknown>
}

export type ClaimResult = 'claimed' | 'refused'

/**
 * The re-check behind isInvitedCheckout. Reads the invite by the HMAC of the
 * paying email (customer_details first, then customer_email), requires it to
 * carry the invite id named in the metadata, then claims it with
 * SET invite:u:{inviteId} {sessionId} NX (no expiry): one site per invite, and
 * of two sessions at once exactly one wins. Then the invite is marked used.
 *
 * Re-entrant: a claim already held by THIS session id counts as claimed (the
 * invite may read open or used), so a retried event can finish what an earlier
 * try, cut short by an outage, started. A claim held by another session, an
 * invite that is neither open nor used, a wrong invite id or a missing email is
 * 'refused'. Any Redis error, and a missing hash secret, is THROWN: the caller
 * must not read an outage as "not invited" (Stripe retries on a 503).
 * The payment status is never consulted (Pitfall 9).
 */
export async function claimInvitedCheckout(redis: ClaimRedis, secret: string, session: Stripe.Checkout.Session): Promise<ClaimResult> {
  const inviteId = session.metadata?.invite_id
  const email = session.customer_details?.email || session.customer_email
  if (!inviteId || !email) return 'refused'
  const key = inviteKey(emailKey(secret, email))
  const invite = await redis.hgetall<Record<string, unknown>>(key)
  if (!invite || String(invite.inviteId) !== inviteId) return 'refused'
  if (invite.status !== 'open' && invite.status !== 'used') return 'refused'
  const claimKey = `invite:u:${inviteId}`
  if (invite.status === 'open') {
    const claimed = await redis.set(claimKey, session.id, { nx: true })
    if (claimed) {
      // The claim above is what stops a second site. If marking the invite used
      // fails, the paid sign-up still goes ahead.
      try {
        await redis.hset(key, { status: 'used', usedAt: new Date().toISOString() })
      } catch {
        // nothing to do: invite:u:{inviteId} already blocks reuse
      }
      return 'claimed'
    }
  }
  const holder = await redis.get(claimKey)
  return holder !== null && String(holder) === session.id ? 'claimed' : 'refused'
}

export type WebhookOutcome =
  | { status: 200, body: { received: true } }
  | { status: 400, body: { error: string } }
  | { status: 503, body: { error: string } }

const OK: WebhookOutcome = { status: 200, body: { received: true } }
const BUSY: WebhookOutcome = { status: 503, body: { error: 'Temporarily unavailable' } }
const NO_SETUP = 'stripe-webhook: setup session without a customer or saved card, nothing provisioned'
const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required'])

export async function handleStripeWebhook(rawBody: string | undefined, signature: string | undefined, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (!signature) return { status: 400, body: { error: 'Missing Stripe signature' } }
  if (!rawBody) return { status: 400, body: { error: 'Missing request body' } }

  let stripeEvent: Stripe.Event
  try {
    stripeEvent = deps.constructEvent(rawBody, signature)
  } catch {
    deps.log('stripe-webhook: signature verification failed')
    return { status: 400, body: { error: 'Invalid webhook signature' } }
  }

  // A hold that cannot be changed ends by itself; the event is still answered.
  const release = async (session: Stripe.Checkout.Session) => {
    if (deps.releaseHold) {
      try {
        await deps.releaseHold(session)
      } catch {
        deps.log('stripe-webhook: could not release a code hold')
      }
    }
    if (deps.releaseCapacity) {
      try {
        await deps.releaseCapacity(session)
      } catch {
        deps.log('stripe-webhook: could not release the server room')
      }
    }
    if (deps.releaseAiKey) {
      try {
        await deps.releaseAiKey(session)
      } catch {
        deps.log('stripe-webhook: could not forget an AI key')
      }
    }
    if (deps.releaseCheckoutMarker) {
      try {
        await deps.releaseCheckoutMarker(session)
      } catch {
        deps.log('stripe-webhook: could not forget a checkout marker')
      }
    }
  }
  const rearm = async (session: Stripe.Checkout.Session) => {
    if (deps.rearmHold) {
      try {
        await deps.rearmHold(session)
      } catch {
        deps.log('stripe-webhook: could not re-arm a code hold')
      }
    }
    if (deps.rearmCapacity) {
      try {
        await deps.rearmCapacity(session)
      } catch {
        deps.log('stripe-webhook: could not re-arm the server room')
      }
    }
  }

  // An expired session never completes, so its code goes back. Before the
  // closed gate below: a hold taken while open must be released while closed too.
  if (stripeEvent.type === 'checkout.session.expired') {
    await release(stripeEvent.data.object as Stripe.Checkout.Session)
    return OK
  }

  // The first payment and renewals (23-32): open or closed.
  if (deps.onInvoice && INVOICE_EVENTS.has(stripeEvent.type)) {
    try {
      await deps.onInvoice(stripeEvent)
    } catch (err) {
      // A held billing lock (billing.ts BillingBusyError) is not an outage, but it is
      // answered the same way: 503, so the event is redelivered and never lost.
      deps.log(err instanceof Error && err.name === 'BillingBusyError'
        ? 'stripe-webhook: a sign-up was busy with an invoice event, Stripe will retry'
        : 'stripe-webhook: infrastructure error handling an invoice event, Stripe will retry')
      return BUSY
    }
    return OK
  }

  if (!deps.open) {
    if (stripeEvent.type === 'checkout.session.completed' && deps.isInvitedCheckout) {
      const session = stripeEvent.data.object as Stripe.Checkout.Session
      if (session.metadata?.invited === 'true') {
        // Read before the claim: a session with no card to keep must not use the invite up.
        if (deps.recordSetup && !hasSetupIds(session)) {
          deps.log(NO_SETUP)
          return OK
        }
        let claim: ClaimResult
        let recorded = true
        try {
          claim = await deps.isInvitedCheckout(session)
          if (claim === 'claimed' && deps.recordSetup) recorded = await deps.recordSetup(session)
        } catch {
          // Redis (or another service) is down: not a refusal. Stripe tries again.
          deps.log('stripe-webhook: infrastructure error during the invited re-check, Stripe will retry')
          return BUSY
        }
        if (claim === 'claimed') {
          if (!recorded) {
            deps.log('stripe-webhook: no sign-up record for the setup session, nothing provisioned')
            return OK
          }
          await rearm(session)
          await deps.onCheckoutCompleted(session)
          return OK
        }
      }
    }
    deps.log(`stripe-webhook: launch closed, ignored ${stripeEvent.type}`)
    return OK
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object as Stripe.Checkout.Session
    if (deps.recordSetup && session.metadata?.provision_id) {
      if (!hasSetupIds(session)) {
        deps.log(NO_SETUP)
        return OK
      }
      let recorded: boolean
      try {
        recorded = await deps.recordSetup(session)
      } catch {
        deps.log('stripe-webhook: infrastructure error recording the setup session, Stripe will retry')
        return BUSY
      }
      if (!recorded) {
        deps.log('stripe-webhook: no sign-up record for the setup session, nothing provisioned')
        return OK
      }
    }
    await rearm(session)
    await deps.onCheckoutCompleted(session)
  } else {
    deps.log(`stripe-webhook: unhandled event type ${stripeEvent.type}`)
  }
  return OK
}
