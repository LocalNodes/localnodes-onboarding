// The first payment (Phase 23, plan 23-32; Tom's billing rule B-1, ONB-01,
// ONB-02, ONB-04; 23-RULINGS-1108.md "Billing rules" and the afternoon
// answers). Plain module, no Nitro globals: Redis, Stripe, fetch, the price,
// the callback secret, the clock and sleep are injected, as in retry-stop.ts,
// so tests import it directly and server/utils/billing-wiring.ts wires it up.
//
// Checkout saved a card and charged nothing (T-3, 23-31). When the new site
// reports ready (23-35), this module:
//   1. starts the subscription with that card and the price frozen at checkout
//      (payment_behavior default_incomplete, idempotency key
//      subscribe:{provisionId}:{subscribeAttempt}) and keeps its id as
//      pendingSubscriptionId, never as subscriptionId;
//   2. pays the first invoice off-session (pay:{provisionId}:{payAttempt}); a
//      first invoice already paid at creation (a 100%-off pilot) is not paid
//      again;
//   3. once paid, writes subscriptionId (so stopProvision's "never stop a
//      paying customer" guard keeps its meaning), releases the code hold and
//      calls the site's POST /localnodes/activate with the per-provision
//      bearer. Only a 200 {"activated": true} makes the status complete.
//
// One runner at a time per sign-up (23-43): every path (the callback, a status
// read, the QStash sweep, the webhook) runs under the sign-up's one lifecycle
// lock (lifecycle.ts withLifecycleLock), the same lock the teardown takes, and
// writes only through named transitions (lifecycle.ts TRANSITIONS), each one
// Lua step that checks the status it expects. Before each create, pay and
// activation POST an intent is written; the result is applied only under the
// same lease token, and a stale one is dropped and reconciled by the next
// holder. Every Stripe call carries timeout 15 s and no SDK retries and is
// raced against the same deadline; the activation POST has one total deadline
// over the connect and the body. A sign-up waiting for billing work sits in
// the sorted set sweep:billing (score = when it is due), so a function cut
// short is resumed. The onDeclined and onHeld hooks run after the lease is
// released (they take the same lock).
//
// Stripe duplicate protection (23-43 Task 3, review round 1 D3). The price and
// coupon are frozen on signup:{provisionId} at checkout; the create reads only
// the frozen priceId (none: rejected, no_price). Each Stripe attempt has one
// idempotency key per sign-up and attempt, never derived from billingTries and
// never advanced automatically (only a person does, 23-21 runbook). Before any
// retried create the run adopts: first the subscription the 30-day marker
// dedupe:{provisionId} names (retrieve), then every page of the customer's
// subscriptions with metadata.provision_id equal to this one. One match is
// adopted; several stop billing (billing review, multiple_subscriptions) and
// create nothing. Stripe saves a key's first answer, 500s included, so a
// replayed stored error (the idempotent-replayed header) with nothing to adopt
// is never read as "no effect": it is unclear, counted in unclearTries, and the
// third stops billing for a person (stripe_unclear). A connection error, a 5xx,
// a rate limit or a 409 / idempotency_key_in_use (the first request may still
// run) is transient: pending with the same key. A StripeIdempotencyError with
// 400 (other parameters under the key) is invalid and flagged
// (idempotency_mismatch). billingTries counts every pending and unclear
// outcome; the tenth rejects (billingError tries, flagged).
//
// It never voids, cancels, detaches, deletes or mails anything: undoing a
// failed first payment is 23-37's (the onDeclined and onHeld hooks, the
// sweep:teardown and sweep:held indexes).
//
// Privacy rule: log lines hold fixed words, a Stripe error type and code, and
// an HTTP status only. Never an email, a customer, invoice or subscription id,
// the activation token or the hosted invoice URL.
import { callbackToken } from './provision-handlers'
import { refundAndTearDown, refundOwed, type RefundDeps } from './refund'
import { rearmHold, releaseHold } from './promo'
import { pilotEndOf } from './pilot-end'
import { PROVISION_ID_PATTERN, SITE_BASE_DOMAIN, SUBDOMAIN_PATTERN } from '../../shared/provisioning'
import {
  ACTIVATION_WINDOW_MS,
  BILLING_INDEX,
  BILLING_MAX_TRIES,
  PROBE_TIMEOUT_MS,
  PROBE_WINDOW_MS,
  UNCLEAR_MAX_TRIES,
  billingStopped,
  billingWaits,
  dedupeKey,
  LeaseLostError,
  applyResult,
  isApplied,
  keepIfLateZero,
  lateKeepable,
  clearIndex,
  foreignIntent,
  transition,
  withDeadline,
  withLifecycleLock,
  writeIntent,
  type IntentOp,
  type Lease,
  type LockDeps,
  type StripeCallOptions,
  type TransitionName,
  type TransitionParams
} from './lifecycle'

/**
 * The index names live in lifecycle.ts (one definition): sweep:billing (the
 * first payment or activation still owed, score = when due), sweep:held (3DS
 * holds, scored by heldUntil) and sweep:teardown (declined first payments
 * waiting for 23-37's teardown). KEEP_SECONDS (72 h) too.
 */
export { BILLING_INDEX, HELD_INDEX, TEARDOWN_INDEX, KEEP_SECONDS, BILLING_MAX_TRIES, UNCLEAR_MAX_TRIES, ACTIVATION_WINDOW_MS, PROBE_WINDOW_MS, PROBE_TIMEOUT_MS } from './lifecycle'
/** One page of the customer's subscriptions in the adopt step (Stripe's maximum). */
export const ADOPT_PAGE_SIZE = 100
/** Stripe voids an unpaid first invoice 23 hours after the subscription is created (incomplete_expired). */
export const HOLD_WINDOW_SECONDS = 82800
/** The waits before each activation try right after payment: about a minute in all. */
export const ACTIVATE_DELAYS_MS = [0, 5000, 10000, 20000, 30000] as const
export const ACTIVATE_TIMEOUT_MS = 15000
/** Cloudflare refuses some non-browser clients by User-Agent; this one names us. */
export const ACTIVATE_USER_AGENT = 'LocalNodes-Onboarding/1 (activate)'
/** A sign-up waiting for a retry is due again a minute later. */
export const RETRY_DELAY_MS = 60000

const stateKey = (sid: string) => `provision:${sid}`
const signupKey = (provisionId: string) => `signup:${provisionId}`

/** The Upstash calls this file makes (a subset of retry-stop.ts RetryStopRedis, typed the same way). */
export interface BillingRedis {
  get: (key: string) => Promise<unknown>
  /** NX with ex (the nudge) or px (the lifecycle lock). */
  set: (key: string, value: string, opts: { nx: true, ex: number } | { nx: true, px: number }) => Promise<unknown>
  del: (...keys: string[]) => Promise<unknown>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  hincrby: (key: string, field: string, increment: number) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
  zadd: (key: string, scoreMember: { score: number, member: string }) => Promise<unknown>
  zrem: (key: string, ...members: string[]) => Promise<unknown>
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

type MaybeExpanded<T> = string | T | null | undefined

export interface InvoiceLike {
  id?: string
  status?: string | null
  hosted_invoice_url?: string | null
  amount_paid?: number | null
  currency?: string | null
}

export interface SubscriptionLike {
  id: string
  created: number
  status?: string
  metadata?: Record<string, string> | null
  latest_invoice?: MaybeExpanded<InvoiceLike>
  /** Unix seconds when Stripe ends it by itself; a pilot's frozen end (pilot-end.ts). */
  cancel_at?: number | null
}

/** The subscription waits for its first invoice to be paid (B-1). */
type IncompleteBehavior = 'default_incomplete'

export interface SubscriptionParams {
  customer: string
  items: Array<{ price: string }>
  default_payment_method: string
  discounts?: Array<{ promotion_code: string }>
  payment_behavior: IncompleteBehavior
  payment_settings: { save_default_payment_method: 'on_subscription' }
  metadata: Record<string, string>
  expand: string[]
  /** A free pilot only (pilot-end.ts): Stripe ends the subscription here unless the organizer says yes. */
  cancel_at?: number
  proration_behavior?: 'none'
}

/** A refund as refund.ts reads it (Stripe.Refund: status, amount, currency, payment_intent). */
export interface RefundObject {
  id: string
  status?: string | null
  amount?: number | null
  currency?: string | null
  payment_intent?: MaybeExpanded<{ id: string }>
}

/** An invoice payment as refund.ts reads it (Stripe.InvoicePayment). */
export interface InvoicePaymentLike {
  status?: string | null
  payment?: { type?: string, payment_intent?: MaybeExpanded<{ id: string }> } | null
}

/**
 * The Stripe calls the first payment makes, and (23-43 Task 6) the refund's:
 * invoices.retrieve (amount_paid, currency), invoicePayments.list,
 * refunds.list, refunds.create, refunds.retrieve and subscriptions.cancel.
 * The refund's are optional so a charge-only double needs none; refund.ts
 * fails closed without them. Each carries the request options of lifecycle.ts
 * stripeOptions (23-43, D1 and H1).
 */
export interface BillingStripe {
  setupIntents: { retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<{ status?: string, payment_method?: MaybeExpanded<{ id: string }> }> }
  subscriptions: {
    create: (params: SubscriptionParams, opts: StripeCallOptions & { idempotencyKey: string }) => Promise<SubscriptionLike>
    list: (params: { customer: string, status: 'all', limit: number, expand?: string[], starting_after?: string }, opts: StripeCallOptions) => Promise<{ data: SubscriptionLike[], has_more?: boolean }>
    /** The subscription the dedupe marker names (D3). */
    retrieve: (id: string, params: { expand: string[] }, opts: StripeCallOptions) => Promise<SubscriptionLike>
    /** The refund's step 4: cancel now, no new invoice, no proration. */
    cancel?: (id: string, params: { invoice_now: false, prorate: false }, opts: StripeCallOptions) => Promise<{ id?: string, status?: string }>
  }
  invoices: {
    pay: (id: string, params: { off_session: true, payment_method: string }, opts: StripeCallOptions & { idempotencyKey: string }) => Promise<InvoiceLike>
    retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<InvoiceLike>
  }
  invoicePayments?: {
    list: (params: { invoice: string, status: 'paid' }, opts: StripeCallOptions) => Promise<{ data: InvoicePaymentLike[] }>
  }
  refunds?: {
    list: (params: { payment_intent: string }, opts: StripeCallOptions) => Promise<{ data: RefundObject[] }>
    create: (params: { payment_intent: string, amount: number, metadata: Record<string, string> }, opts: StripeCallOptions & { idempotencyKey: string }) => Promise<RefundObject>
    retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<RefundObject>
  }
}

export interface ActivateInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  redirect: 'manual'
  signal: AbortSignal
}

export type ActivateFetch = (url: string, init: ActivateInit) => Promise<{ status: number, json: () => Promise<unknown> }>

export interface BillingDeps extends Pick<LockDeps, 'tick' | 'timers'> {
  redis: BillingRedis
  /** Stripe, built only when a charge runs. */
  stripe: () => BillingStripe
  /** For the site's /localnodes/activate. */
  fetch: ActivateFetch
  /** NUXT_PROVISION_CALLBACK_SECRET: the activation bearer is HMAC(secret, provisionId). */
  callbackSecret: string
  /** Milliseconds. Tests inject it. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
  /** 23-37: called once when a first payment is declined, after the lease is released. A throw is logged, never undoes the state. */
  onDeclined?: (sid: string) => Promise<void> | void
  /** 23-37: called once when a first payment is held for 3DS, after the lease is released. A throw is logged, never undoes the state. */
  onHeld?: (sid: string) => Promise<void> | void
}

export type BillingOutcome =
  | 'busy'
  | 'skipped'
  | 'activated'
  | 'paid'
  | 'held'
  | 'declined'
  | 'pending'
  | 'rejected'
  | 'lost'
  /** Billing stopped for a person (D3): several subscriptions, or a Stripe outcome unclear three times. */
  | 'review'
  /** 23-43 Task 6: the site has not answered the probe yet; nothing charged, due again a minute later. */
  | 'waiting'

type State = Record<string, unknown>

const nowOf = (deps: BillingDeps) => (deps.now ?? Date.now)()
const num = (value: unknown, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const str = (value: unknown) => (value === null || value === undefined ? '' : String(value))
const idOf = (value: MaybeExpanded<{ id?: string }>) => (typeof value === 'string' ? value : value?.id ?? '')
const isEmpty = (s: State | null): s is null => !s || Object.keys(s).length === 0
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The create params of B-1 step 2, exactly (exported for 23-22's dry run). */
export function subscriptionParams(input: {
  customer: string
  paymentMethod: string
  price: string
  promoId?: string
  metadata: Record<string, string>
  /** A free pilot's frozen end (pilot-end.ts). Without it the params are exactly the paid path's. */
  cancelAt?: number
}): SubscriptionParams {
  const pilot = input.cancelAt !== undefined
  return {
    customer: input.customer,
    items: [{ price: input.price }],
    default_payment_method: input.paymentMethod,
    ...(input.promoId ? { discounts: [{ promotion_code: input.promoId }] } : {}),
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    metadata: pilot ? { ...input.metadata, pilot: 'ends', pilot_ends_at: String(input.cancelAt) } : input.metadata,
    expand: ['latest_invoice'],
    ...(pilot ? { cancel_at: input.cancelAt, proration_behavior: 'none' as const } : {})
  }
}

/**
 * Raised by routeInvoiceEvent when the billing lock is held by another runner
 * (review fix, 2026-11-09). The webhook answers 503 so Stripe redelivers: a
 * 200 would end the deliveries and leave a paid organizer held until the 23 h
 * deadline. The message carries no id.
 */
export class BillingBusyError extends Error {
  constructor() {
    super('billing: the sign-up is busy, the event must be redelivered')
    this.name = 'BillingBusyError'
  }
}

/**
 * POST https://{subdomain}.localnodes.xyz/localnodes/activate (23-35).
 * 'activated' only on 200 with {"activated": true}; 'busy' on 409
 * {"error":"busy"} (23-43 Task 5: another activate call holds the site's
 * lock; the next run decides); anything else 'retry'.
 */
export async function activateSite(state: { subdomain?: unknown, provisionId?: unknown }, deps: Pick<BillingDeps, 'fetch' | 'callbackSecret' | 'log'>): Promise<'activated' | 'retry' | 'busy'> {
  const subdomain = str(state.subdomain)
  const provisionId = str(state.provisionId)
  if (!SUBDOMAIN_PATTERN.test(subdomain) || subdomain.length < 3 || subdomain.length > 63 || !provisionId || !deps.callbackSecret) {
    deps.log?.('billing: activation not attempted, the record is incomplete')
    return 'retry'
  }
  let status: number
  let body: unknown = null
  try {
    // One total deadline over the connect and the body read (23-43, H1).
    ;({ status, body } = await withDeadline(ACTIVATE_TIMEOUT_MS, async (signal) => {
      const res = await deps.fetch(`https://${subdomain}.${SITE_BASE_DOMAIN}/localnodes/activate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${callbackToken(deps.callbackSecret, provisionId)}`,
          'Content-Type': 'application/json',
          'User-Agent': ACTIVATE_USER_AGENT
        },
        body: JSON.stringify({ provision_id: provisionId }),
        // A redirect can't carry the bearer to another host.
        redirect: 'manual',
        signal
      })
      if (res.status !== 200 && res.status !== 409) return { status: res.status, body: null }
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch (err) {
        if (signal.aborted) throw err
        parsed = null
      }
      return { status: res.status, body: parsed }
    }))
  } catch {
    deps.log?.('billing: activation not reached')
    return 'retry'
  }
  deps.log?.(`billing: activation answered ${status}`)
  const activated = status === 200 && typeof body === 'object' && body !== null && (body as { activated?: unknown }).activated === true
  if (activated) return 'activated'
  const busy = status === 409 && typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'busy'
  return busy ? 'busy' : 'retry'
}

/**
 * The probe (23-43 Task 6, escalation point 5): is the site itself answering
 * over HTTPS? POST https://{subdomain}.localnodes.xyz/localnodes/activate with
 * no Authorization header and an empty body, the activation User-Agent,
 * redirect manual, one total deadline of PROBE_TIMEOUT_MS. Only the site's own
 * refusal of a request with no bearer counts: status 401 with the JSON body
 * {"error":"unauthorized"} (23-35). A 404 {"error":"not_found"} (no token on
 * the site yet), a 200, a redirect, a 5xx, a 401 that is not that JSON and a
 * network error are all 'not_yet'. The log names the HTTP status only.
 */
export async function probeSite(state: { subdomain?: unknown }, deps: Pick<BillingDeps, 'fetch' | 'log'>): Promise<'answering' | 'not_yet'> {
  const subdomain = str(state.subdomain)
  if (!SUBDOMAIN_PATTERN.test(subdomain) || subdomain.length < 3 || subdomain.length > 63) {
    deps.log?.('billing: probe not attempted, the record is incomplete')
    return 'not_yet'
  }
  let status: number
  let body: unknown = null
  try {
    ;({ status, body } = await withDeadline(PROBE_TIMEOUT_MS, async (signal) => {
      const res = await deps.fetch(`https://${subdomain}.${SITE_BASE_DOMAIN}/localnodes/activate`, {
        method: 'POST',
        headers: { 'User-Agent': ACTIVATE_USER_AGENT },
        body: '',
        redirect: 'manual',
        signal
      })
      if (res.status !== 401) return { status: res.status, body: null }
      let parsed: unknown = null
      try {
        parsed = await res.json()
      } catch (err) {
        if (signal.aborted) throw err
        parsed = null
      }
      return { status: res.status, body: parsed }
    }))
  } catch {
    deps.log?.('billing: probe not reached')
    return 'not_yet'
  }
  deps.log?.(`billing: probe answered ${status}`)
  const answering = status === 401 && typeof body === 'object' && body !== null && !Array.isArray(body)
    && Object.keys(body).length === 1 && (body as { error?: unknown }).error === 'unauthorized'
  return answering ? 'answering' : 'not_yet'
}

/** One billing run under the lease: who, with what, and for which provision. */
interface Run {
  sid: string
  deps: BillingDeps
  lease: Lease
  provisionId: string
  /** This run listed the customer's subscriptions and found none with this provision id (D3's unclear rule). */
  listedEmpty?: boolean
  /** This run's activation answered 200 after its lease was lost, and the late activation was recorded (ruling (a)). */
  lateNoted?: boolean
}

/** A write through a named transition, fenced by the lease. Lost: the run stops. Invalid: raised. */
async function step(run: Run, name: TransitionName, params: TransitionParams = {}) {
  const out = await transition(run.deps.redis, run.sid, name, { provisionId: run.provisionId, now: nowOf(run.deps), ...params }, run.lease)
  if (out.result === 'lost') throw new LeaseLostError(name)
  if (out.result === 'invalid') {
    // Fixed words and the reason only (type, number, counter, score, …): a wrong-type sweep key stops every step.
    run.deps.log?.(`lifecycle: ${name} could not apply (${out.why})`)
    throw new Error(`billing: ${name} could not apply (invalid)`)
  }
  return out
}

/** A remote call's result: applied only while the intent is this lease's; a stale one ends the run as lost. */
async function result(run: Run, op: IntentOp, name: TransitionName, params: TransitionParams = {}): Promise<void> {
  const out = await applyResult(run.deps.redis, run.sid, run.lease, op, name, { provisionId: run.provisionId, now: nowOf(run.deps), ...params }, run.deps.log)
  if (out === 'dropped') throw new LeaseLostError(op)
}

/** The intent before a remote mutation (D1). */
async function intent(run: Run, op: IntentOp, key: string): Promise<void> {
  await writeIntent(run.deps.redis, run.sid, run.lease, op, key, { provisionId: run.provisionId, now: nowOf(run.deps) })
}

/** A LeaseLostError from beforeRemote passes every catch. */
function passLease(err: unknown): void {
  if (err instanceof LeaseLostError) throw err
}

const readState = async (run: Run) => (await run.deps.redis.hgetall(stateKey(run.sid))) ?? {}
const readSignup = async (run: Run) => (run.provisionId ? await run.deps.redis.hgetall(signupKey(run.provisionId)) : null) ?? {}

/**
 * Run billing work under the lifecycle lock, then the hook the outcome owes
 * (declined: onDeclined, held: onHeld), after the lease is released: with one
 * lock the hooks would otherwise meet it and get 'busy'. A crash in between
 * still leaves the sign-up in sweep:teardown or sweep:held.
 */
async function runLocked(sid: string, deps: BillingDeps, work: (run: Run) => Promise<BillingOutcome>): Promise<BillingOutcome> {
  const lockDeps: LockDeps = { redis: deps.redis, tick: deps.tick, timers: deps.timers, log: deps.log }
  let current: Run | undefined
  const out = await withLifecycleLock(sid, lockDeps, lease => work(current = { sid, deps, lease, provisionId: '' }))
  if (current?.lateNoted) await keepLateAfterLoss(sid, deps, lockDeps)
  if (out === 'declined') await callHook(deps.onDeclined, sid, 'billing: the declined hook failed; 23-37 finds it in sweep:teardown', deps)
  if (out === 'held') await callHook(deps.onHeld, sid, 'billing: the held hook failed; 23-37 finds it in sweep:held', deps)
  return out
}

/** Past paidAt + ACTIVATION_WINDOW_MS (activationDeadline, written by the paid step): no more activation tries from billing (23-43 Task 6). */
export function activationWindowPassed(state: State, now: number): boolean {
  const deadline = num(state.activationDeadline) || (Date.parse(str(state.paidAt)) + ACTIVATION_WINDOW_MS)
  return Number.isFinite(deadline) && deadline > 0 && now >= deadline
}

/**
 * A 200 {activated: true} whose complete step was refused or dropped: if the
 * sign-up is being refunded by now (refunding, refunded, or its teardown),
 * the late activation is recorded (Q-straggler): lateActivation true and a
 * reconcile:flags entry, written without a fence by the runner that saw it,
 * and nothing else. The row's own from-set and guard decide; any other status
 * is refused and nothing is written.
 */
export async function noteLateActivation(redis: BillingRedis, sid: string, provisionId: string, now: number, log?: (msg: string) => void): Promise<boolean> {
  try {
    const out = await transition(redis, sid, 'lateActivation', { provisionId: provisionId || undefined, now, opId: '' })
    if (isApplied(out)) log?.('billing: the site activated after the refund began; flagged for a person')
    return isApplied(out)
  } catch {
    log?.('billing: a late activation could not be recorded')
    return false
  }
}

/**
 * Orchestrator ruling (a) (23-43 Task 7), the late runner's side: after its
 * lease is gone, it takes the lifecycle lock afresh and keeps a zero invoice's
 * site when the delete was not asked for yet (keepIfLateZero, fenced). Busy:
 * the runner holding the lock sees lateActivation at its next check (before
 * the cancel, the card, the invite, the mail and the delete) and keeps it
 * there. Errors are logged and left to that runner and the sweeps.
 */
async function keepLateAfterLoss(sid: string, deps: BillingDeps, lockDeps: LockDeps): Promise<void> {
  try {
    const state = (await deps.redis.hgetall(stateKey(sid))) ?? {}
    if (!lateKeepable(state as State)) return
    await withLifecycleLock(sid, lockDeps, lease => keepIfLateZero(deps.redis as never, sid, lease, { now: nowOf(deps), log: deps.log }))
  } catch {
    deps.log?.('billing: a late activation could not keep its free site; the next runner checks again')
  }
}

/**
 * One activation try under the lease, while the 24 hour window is open
 * (23-43 Task 6: the 30-try cap is gone). Activated: the complete transition
 * (activatedAt, out of sweep:billing). Not: the try is counted and the member
 * is due again a minute later. Past the window: no try and no write ('window');
 * the sign-up stays in sweep:billing, where only the QStash billing step
 * starts the refund. The intent is written first, then the margin is checked,
 * then the POST (its own total deadline).
 */
async function activateOnce(run: Run, state: State): Promise<'activated' | 'retry' | 'window'> {
  if (activationWindowPassed(state, nowOf(run.deps))) return 'window'
  await intent(run, 'activate', `activate:${run.provisionId}`)
  run.lease.beforeRemote('activate')
  const out = await activateSite(state, run.deps)
  if (out === 'activated') {
    const applied = await applyResult(run.deps.redis, run.sid, run.lease, 'activate', 'complete', { provisionId: run.provisionId, now: nowOf(run.deps) }, run.deps.log)
    if (applied === 'dropped') {
      if (await noteLateActivation(run.deps.redis, run.sid, run.provisionId, nowOf(run.deps), run.deps.log)) run.lateNoted = true
      throw new LeaseLostError('activate')
    }
    return 'activated'
  }
  await result(run, 'activate', 'activationTry', { due: nowOf(run.deps) + RETRY_DELAY_MS })
  return 'retry'
}

/** Up to five tries right after payment, at 0, 5, 10, 20 and 30 s, under the same (renewed) lease; the rest come from status reads and the sweep. */
async function activateWithBackoff(run: Run): Promise<BillingOutcome> {
  const sleep = run.deps.sleep ?? defaultSleep
  for (const delay of ACTIVATE_DELAYS_MS) {
    if (delay > 0) await sleep(delay)
    const state = await readState(run)
    if (isEmpty(state)) return 'skipped'
    if (state.status === 'complete') return 'activated'
    const out = await activateOnce(run, state)
    if (out === 'activated') return 'activated'
    if (out === 'window') return 'paid'
  }
  return 'paid'
}

// Held and declined sign-ups keep their three keys 72 hours: the KEEP_SECONDS floor of their transitions.

/** A status read resumes billing at most once per this many seconds. */
export const NUDGE_SECONDS = 10
/** Due members of sweep:billing read per QStash run. */
export const BILLING_SWEEP_LIMIT = 50
export const nudgeKey = (provisionId: string) => `billing:nudge:${provisionId}`

/** Call a 23-37 hook once; a throw is logged as a fixed line and never undoes the state. */
async function callHook(hook: ((sid: string) => Promise<void> | void) | undefined, sid: string, line: string, deps: BillingDeps): Promise<void> {
  if (!hook) return
  try {
    await hook(sid)
  } catch {
    deps.log?.(line)
  }
}

/**
 * Where a failed pay call leaves the sign-up, from the error's class, code,
 * decline_code and statusCode, in that order: the bank asking for
 * authentication (held), then a card error (declined), then Stripe's own
 * trouble (pending), then an invalid request (invalid). Anything else is
 * pending: an unknown error must never tear a site down. A 409 or
 * idempotency_key_in_use is pending; another StripeIdempotencyError is
 * invalid (23-43 Task 3). A call that hit its
 * deadline (lifecycle.ts DeadlineError) is pending too: its outcome is
 * unknown, and the intent left behind sends the next run to read Stripe first.
 */
export function classifyPayError(err: unknown): 'held' | 'declined' | 'pending' | 'invalid' {
  const e = (err ?? {}) as { type?: unknown, code?: unknown, decline_code?: unknown, statusCode?: unknown, raw?: { code?: unknown, decline_code?: unknown } }
  const code = e.code ?? e.raw?.code
  const decline = e.decline_code ?? e.raw?.decline_code
  // 23-43 Task 3 (Argon MEDIUM): a 409 or idempotency_key_in_use means the first request under
  // this key may still be running at Stripe; its outcome is not known yet, so it is transient.
  if (num(e.statusCode) === 409 || code === 'idempotency_key_in_use') return 'pending'
  // Any other idempotency error (400: other parameters under the key) is invalid.
  if (e.type === 'StripeIdempotencyError') return 'invalid'
  if (code === 'invoice_payment_intent_requires_action' || code === 'authentication_required' || decline === 'authentication_required') return 'held'
  if (e.type === 'StripeCardError') return 'declined'
  const status = num(e.statusCode)
  if (e.type === 'StripeConnectionError' || e.type === 'StripeAPIError' || e.type === 'StripeRateLimitError' || status >= 500) return 'pending'
  if (e.type === 'StripeInvalidRequestError') return 'invalid'
  return 'pending'
}

/**
 * The paid path: the paid transition (subscriptionId only now, billing paid,
 * paidAt, the invoice id, amount and currency; a held sign-up back to ready,
 * out of sweep:held, into sweep:billing until activated, the three keys kept
 * 72 h). With `op` it is the result of that remote call (intent-guarded);
 * without, a plain fenced step that also clears any intent left behind. Then
 * the code hold is released (a failed release is logged, not raised: the hold
 * runs out on its own). The caller then activates.
 */
async function markPaid(run: Run, signup: State, subscriptionId: string, paid: { op?: IntentOp, invoice?: InvoiceLike | null, invoiceId?: string }): Promise<boolean> {
  const params: TransitionParams = {
    subscriptionId,
    invoiceId: paid.invoice?.id || paid.invoiceId || undefined,
    amountPaid: typeof paid.invoice?.amount_paid === 'number' ? paid.invoice.amount_paid : undefined,
    currency: paid.invoice?.currency || undefined
  }
  if (paid.op) {
    await result(run, paid.op, 'paid', params)
  } else {
    const out = await step(run, 'paid', { ...params, clearIntent: true })
    if (out.result === 'refused') return false
  }
  await releaseCodeHold(run, signup)
  return true
}

/** The code hold, released once paid (a failed release is logged, not raised: the hold runs out on its own). */
async function releaseCodeHold(run: Run, signup: State): Promise<void> {
  if (!signup.promoId || !signup.inviteId) return
  try {
    await releaseHold(run.deps.redis, str(signup.promoId), str(signup.inviteId))
  } catch {
    run.deps.log?.('billing: code hold not released, it runs out on its own')
  }
}

/** The webhook event an invoice.paid came in (its id and created, unix seconds), for the record a skipped payment leaves. */
export interface PaidEvent {
  id?: string
  created?: number
}

/**
 * An invoice.paid on a sign-up whose billing waits for a person (review or
 * rejected) is skipped, and recorded (the orchestrator's addition to 23-43
 * Task 6): one reconcile:flags entry naming the event id, the invoice id and
 * the amount, scored by the event's time, so the person reconciling sees the
 * payment arrived. The same event redelivered writes the same entry. Nothing
 * on the record changes.
 */
async function recordPaidInReview(run: Run, invoice: InvoiceLike | undefined, event: PaidEvent | undefined): Promise<void> {
  run.deps.log?.('billing: a payment on a sign-up waiting for a person; recorded for the reconciliation')
  const created = num(event?.created)
  await step(run, 'paymentRecorded', {
    opId: '',
    eventId: event?.id,
    invoiceId: invoice?.id,
    amount: typeof invoice?.amount_paid === 'number' ? invoice.amount_paid : undefined,
    eventAt: created > 0 ? created * 1000 : nowOf(run.deps)
  })
}

/** A payment on a sign-up whose invoice was voided needs a person (23-43): one reconcile:flags entry, nothing written on the record. */
async function flagPaidAfterVoid(run: Run): Promise<void> {
  run.deps.log?.('billing: a payment on a voided sign-up; flagged for a person')
  await step(run, 'flag', { kind: 'paid_after_void', opId: '' })
}

/** Stripe's saved answer to an earlier request under the same idempotency key (the SDK keeps Node's lowercase header names). */
export function isReplayed(err: unknown): boolean {
  const headers = (err as { headers?: Record<string, unknown> } | null | undefined)?.headers
  return !!headers && String(headers['idempotent-replayed'] ?? '').toLowerCase() === 'true'
}

/** A StripeIdempotencyError that is not the transient 409: other parameters were sent under the key. */
const idempotencyMismatch = (err: unknown) => (err as { type?: unknown } | null)?.type === 'StripeIdempotencyError' && classifyPayError(err) === 'invalid'

/**
 * After a Stripe error with an unknown outcome (or a call past its deadline):
 * the key stays, the attempt never advances, and the intent, if any, stays for
 * the next run to reconcile. No teardown, no hook. By this table (D3, the
 * billingTries cap):
 *   - unclear (a replayed stored error and an adopt list or invoice read that
 *     found nothing, in this run), the third time: billing review,
 *     stripe_unclear, no further Stripe call;
 *   - the tenth pending or unclear outcome: billing rejected, tries;
 *   - unclear: unclearTries and billingTries plus one, due again a minute later;
 *   - otherwise pending: billingTries plus one, due again a minute later.
 */
async function markPending(run: Run, err?: unknown, unclear = false): Promise<{ outcome: BillingOutcome, paid: false }> {
  const state = await readState(run)
  const unclearTries = num(state.unclearTries)
  if (unclear && unclearTries + 1 >= UNCLEAR_MAX_TRIES) {
    run.deps.log?.('billing: Stripe outcome unclear, flagged for a person')
    await step(run, 'review', { kind: 'stripe_unclear', unclearTries })
    return { outcome: 'review', paid: false }
  }
  if (num(state.billingTries) + 1 >= BILLING_MAX_TRIES) {
    run.deps.log?.('billing: rejected (tries)')
    await step(run, 'triesExhausted')
    return { outcome: 'rejected', paid: false }
  }
  const e = err as { type?: unknown, code?: unknown, name?: unknown } | undefined
  run.deps.log?.(`billing: Stripe error ${str(e?.type) || str(e?.name) || 'unknown'} ${str(e?.code) || '-'}, will retry`)
  const due = nowOf(run.deps) + RETRY_DELAY_MS
  if (unclear) {
    run.deps.log?.('billing: Stripe outcome unclear, the same key is tried again')
    await step(run, 'unclear', { due, unclearTries })
  } else {
    await step(run, 'pending', { due })
  }
  return { outcome: 'pending', paid: false }
}

/** Billing rejected: no automatic retry; the reconciliation lists it. An idempotency mismatch is flagged in the same step. */
async function markRejected(run: Run, billingError: 'invalid' | 'no_card' | 'no_price' | 'no_pilot_end' | 'pilot_not_free', op?: IntentOp, flag?: 'idempotency_mismatch'): Promise<{ outcome: BillingOutcome, paid: false }> {
  if (flag) run.deps.log?.('billing: the idempotency key was used with other parameters, flagged for a person')
  run.deps.log?.(`billing: rejected (${billingError})`)
  const params = flag ? { billingError, flag } : { billingError }
  if (op) await result(run, op, 'rejected', params)
  else await step(run, 'rejected', params)
  return { outcome: 'rejected', paid: false }
}

/** Several subscriptions carry this provision id: billing review for a person, nothing created or paid (D3). */
async function markMultiple(run: Run): Promise<{ outcome: BillingOutcome, paid: false }> {
  run.deps.log?.('billing: several subscriptions carry this provision id, flagged for a person')
  await step(run, 'review', { kind: 'multiple_subscriptions', clearIntent: true })
  return { outcome: 'review', paid: false }
}

/**
 * A Stripe error before or around a create or pay, by kind: transient
 * (pending, or unclear when `unclear` holds and the error is a replayed stored
 * one), an idempotency mismatch (rejected, flagged), anything else invalid.
 */
async function afterStripeError(run: Run, err: unknown, opts: { unclear?: boolean, op?: IntentOp } = {}): Promise<{ outcome: BillingOutcome, paid: false }> {
  const kind = classifyPayError(err)
  if (kind === 'pending' || kind === 'held' || kind === 'declined') {
    const replayedUnclear = Boolean(opts.unclear) && isReplayed(err) && num((err as { statusCode?: unknown }).statusCode) !== 409
    return markPending(run, err, replayedUnclear)
  }
  if (idempotencyMismatch(err)) return markRejected(run, 'invalid', opts.op, 'idempotency_mismatch')
  return markRejected(run, 'invalid', opts.op)
}

type Adopted = { kind: 'none' } | { kind: 'one', sub: SubscriptionLike } | { kind: 'many' }

/**
 * Adopt before any retried create (D3). First the subscription the dedupe
 * marker names (subscriptions.retrieve), then, when `list` is set, every page
 * of the customer's subscriptions (status all, latest_invoice expanded,
 * starting_after the last id until has_more is false), keeping those whose
 * metadata.provision_id is this one. None sets run.listedEmpty. Stripe errors
 * are raised to the caller.
 */
async function adopt(run: Run, customer: string, list: boolean): Promise<Adopted> {
  const stripe = run.deps.stripe()
  const marker = run.provisionId ? await run.deps.redis.hgetall(dedupeKey(run.provisionId)) : null
  const marked = str(marker?.subscriptionId)
  if (marked) {
    const sub = await run.lease.stripe('retrieve', o => stripe.subscriptions.retrieve(marked, { expand: ['latest_invoice'] }, o))
    return { kind: 'one', sub }
  }
  if (!list || run.listedEmpty) return { kind: 'none' }
  const ours: SubscriptionLike[] = []
  let after: string | undefined
  for (;;) {
    const page = await run.lease.stripe('list', o => stripe.subscriptions.list({
      customer,
      status: 'all',
      limit: ADOPT_PAGE_SIZE,
      expand: ['data.latest_invoice'],
      ...(after ? { starting_after: after } : {})
    }, o))
    for (const sub of page.data) if (sub.metadata?.provision_id === run.provisionId) ours.push(sub)
    const last = page.data[page.data.length - 1]
    if (page.has_more !== true || !last) break
    after = last.id
  }
  if (ours.length === 0) {
    run.listedEmpty = true
    return { kind: 'none' }
  }
  return ours.length === 1 ? { kind: 'one', sub: ours[0]! } : { kind: 'many' }
}

/** A pilot sign-up's end frozen at checkout, or null when it has none. */
function frozenPilotEnd(signup: Record<string, unknown>): number | null {
  const n = Number(signup.pilotEndsAt)
  return signup.pilotEndsAt !== undefined && signup.pilotEndsAt !== '' && Number.isInteger(n) ? n : null
}

/** True when the subscription ends by itself at exactly `end`. */
function endsAt(sub: SubscriptionLike, end: number | null): boolean {
  return end !== null && sub.cancel_at === end
}

/** Adopt one subscription found by adopt(): the pendingSubscription step (the marker gets its id in the same step). */
async function adoptOne(run: Run, sub: SubscriptionLike): Promise<void> {
  await step(run, 'pendingSubscription', { subscriptionId: sub.id, invoiceId: idOf(sub.latest_invoice), subscriptionCreatedAt: sub.created })
}

/**
 * Declined (B-1 step 4): the declined transition (status and billing
 * declined, teardownReason declined, into sweep:teardown, out of sweep:billing
 * and sweep:held, 72 h). Nothing is activated and there is no free retry.
 * Nothing is voided, cancelled, detached or mailed here; onDeclined runs after
 * the lease is released.
 */
async function markDeclined(run: Run, op?: IntentOp): Promise<{ outcome: BillingOutcome, paid: false }> {
  run.deps.log?.('billing: first payment declined')
  if (op) await result(run, op, 'declined')
  else await step(run, 'declined')
  return { outcome: 'declined', paid: false }
}

/**
 * 3DS (B-1 step 5): held until Stripe's own deadline, the subscription's
 * creation plus 23 hours. The invoice is read first (for its hosted page);
 * then one held transition writes the status, the deadline, the hosted invoice
 * URL on signup:{provisionId} only (never provision:{sid}, the status reply or
 * a log), the sweep:held member at heldUntil and the removal from
 * sweep:billing, with the three keys at 72 h: all of it, or none of it (HIGH
 * 7). The code hold is re-armed until the deadline. The mail and the button
 * are 23-37's (onHeld, after the lease).
 */
async function markHeld(run: Run, invoiceId: string, signup: State): Promise<{ outcome: BillingOutcome, paid: false }> {
  let hosted = ''
  try {
    const invoice = await run.lease.stripe('invoice', o => run.deps.stripe().invoices.retrieve(invoiceId, {}, o))
    hosted = str(invoice.hosted_invoice_url)
  } catch (err) {
    passLease(err)
    // Without the link nobody can confirm: try again on the next trigger.
    return markPending(run, err)
  }
  const state = await readState(run)
  const now = nowOf(run.deps)
  const created = num(state.subscriptionCreatedAt) || Math.floor(now / 1000)
  const heldUntil = (created + HOLD_WINDOW_SECONDS) * 1000
  run.deps.log?.('billing: first payment held for the bank\'s confirmation')
  await result(run, 'pay', 'held', { heldUntil, hostedInvoiceUrl: hosted || undefined })
  if (signup.promoId && signup.inviteId) {
    const seconds = Math.max(0, Math.ceil((heldUntil - now) / 1000)) + 600
    try {
      await rearmHold(run.deps.redis, str(signup.promoId), str(signup.inviteId), now, seconds)
    } catch {
      run.deps.log?.('billing: code hold not re-armed')
    }
  }
  return { outcome: 'held', paid: false }
}

/** After a failed pay call: one state per error kind. An invalid request reads the invoice first: it may be paid already. */
async function afterPayError(run: Run, signup: State, invoiceId: string, subscriptionId: string, err: unknown, readOpen: boolean): Promise<{ outcome: BillingOutcome, paid: boolean }> {
  const kind = classifyPayError(err)
  if (kind === 'held') return markHeld(run, invoiceId, signup)
  if (kind === 'declined') return markDeclined(run, 'pay')
  // The invoice was read open in this run and the same key replays a stored error: unclear (D3).
  if (kind === 'pending') return afterStripeError(run, err, { unclear: readOpen })
  if (idempotencyMismatch(err)) return markRejected(run, 'invalid', 'pay', 'idempotency_mismatch')
  let invoice: InvoiceLike
  try {
    invoice = await run.lease.stripe('invoice', o => run.deps.stripe().invoices.retrieve(invoiceId, {}, o))
  } catch (retrieveErr) {
    passLease(retrieveErr)
    return afterStripeError(run, retrieveErr)
  }
  if (invoice.status === 'paid') {
    await markPaid(run, signup, subscriptionId, { op: 'pay', invoice })
    return { outcome: 'paid', paid: true }
  }
  return markRejected(run, 'invalid', 'pay')
}

/**
 * The probe gate before the first Stripe call (23-43 Task 6). Past readyAtMs
 * plus PROBE_WINDOW_MS with no answer: siteNeverAnswered (flagged for a
 * person, out of sweep:billing; nothing charged, nothing torn down). Else one
 * probe: answering writes siteAnsweredAt and the charge goes on (null); not
 * yet counts probeTries and is due again a minute later ('waiting').
 */
async function probeGate(run: Run, state: State): Promise<BillingOutcome | null> {
  const now = nowOf(run.deps)
  const readyAt = num(state.readyAtMs)
  if (readyAt > 0 && now >= readyAt + PROBE_WINDOW_MS) {
    run.deps.log?.('billing: the site never answered the probe in 24 hours; flagged for a person')
    await step(run, 'siteNeverAnswered')
    return 'skipped'
  }
  run.lease.beforeRemote('probe')
  if ((await probeSite(state, run.deps)) === 'answering') {
    await step(run, 'siteAnswered')
    return null
  }
  await step(run, 'probeTry', { due: now + RETRY_DELAY_MS })
  return 'waiting'
}

/**
 * Create (or find) the subscription and pay its first invoice. Called under
 * the lease with a fresh read of the hash. Ends on the paid path, or in one of
 * pending, held, declined, rejected or review.
 *
 * Retries are made safe by state and by one key per attempt (D3): a retried
 * create first adopts (the marker's subscription, then every page of the
 * customer's subscriptions by metadata.provision_id), and a retried pay first
 * reads the invoice. The keys are subscribe:{provisionId}:{subscribeAttempt}
 * and pay:{provisionId}:{payAttempt}, both stored on the hash from 1 and never
 * advanced here.
 */
async function charge(run: Run, state: State): Promise<{ outcome: BillingOutcome, paid: boolean }> {
  const { deps } = run
  const provisionId = run.provisionId
  // A run that met an error, or was cut short, before this one.
  const retried = Boolean(state.billing)
  // 23-43 Task 6: no Stripe call before the site's own 401 to the probe. A retried pay never probes.
  if (!state.billing && !str(state.siteAnsweredAt)) {
    const gate = await probeGate(run, state)
    if (gate) return { outcome: gate, paid: false }
  }
  // The charging step's guards (siteAnsweredAt set, not siteNeverAnswered) are the authority: refused, nothing is called.
  if (!state.billing && (await step(run, 'charging')).result === 'refused') return { outcome: 'skipped', paid: false }
  const attempts = state.billing ? state : await readState(run)
  const subscribeKey = `subscribe:${provisionId}:${num(attempts.subscribeAttempt) || 1}`
  const payKey = `pay:${provisionId}:${num(attempts.payAttempt) || 1}`
  const signup = await readSignup(run)
  const customer = str(signup.stripeCustomerId)
  const setupIntentId = str(signup.setupIntentId)
  if (!customer || !setupIntentId) return markRejected(run, 'no_card')

  const stripe = deps.stripe()
  let paymentMethod: string
  try {
    const setup = await run.lease.stripe('setup', o => stripe.setupIntents.retrieve(setupIntentId, {}, o))
    paymentMethod = setup.status === 'succeeded' ? idOf(setup.payment_method) : ''
  } catch (err) {
    passLease(err)
    if (classifyPayError(err) === 'pending') return markPending(run, err)
    return markRejected(run, 'no_card')
  }
  if (!paymentMethod) return markRejected(run, 'no_card')
  // A free pilot (pilot-end.ts): its subscription must end by itself at the
  // end frozen at checkout, and billing never pays for it.
  const pilot = pilotEndOf(signup, Math.floor(nowOf(deps) / 1000))
  const frozenEnd = pilot.pilot ? frozenPilotEnd(signup) : null

  // 1. The subscription: the one already made, one Stripe made for us (the
  //    marker's, or one listed by metadata), or a new one under this attempt's key.
  let subscriptionId = str(state.pendingSubscriptionId)
  let invoiceId = str(state.invoiceId)
  let invoice: InvoiceLike | null = null
  if (!subscriptionId) {
    let found: Adopted
    try {
      found = await adopt(run, customer, retried)
    } catch (err) {
      passLease(err)
      return afterStripeError(run, err)
    }
    if (found.kind === 'many') return markMultiple(run)
    let subscription: SubscriptionLike
    if (found.kind === 'one') {
      subscription = found.sub
      if (pilot.pilot && !endsAt(subscription, frozenEnd)) return markRejected(run, 'no_pilot_end')
      await adoptOne(run, subscription)
    } else {
      // The price frozen at checkout, never a runtime price (D3); none fails closed.
      const price = str(signup.priceId)
      if (!price) return markRejected(run, 'no_price')
      // A pilot with no end more than a day ahead is never created.
      if (pilot.pilot && pilot.cancelAt === null) return markRejected(run, 'no_pilot_end')
      await intent(run, 'subscribe', subscribeKey)
      try {
        subscription = await run.lease.stripe('subscribe', o => stripe.subscriptions.create(
          subscriptionParams({
            customer,
            paymentMethod,
            price,
            promoId: signup.promoId ? str(signup.promoId) : undefined,
            ...(pilot.pilot && pilot.cancelAt !== null ? { cancelAt: pilot.cancelAt } : {}),
            metadata: {
              provision_id: provisionId,
              subdomain: str(state.subdomain),
              ...(signup.inviteId ? { invite_id: str(signup.inviteId) } : {})
            }
          }),
          { idempotencyKey: subscribeKey, ...o }
        ))
      } catch (err) {
        passLease(err)
        return afterStripeError(run, err, { unclear: Boolean(run.listedEmpty), op: 'subscribe' })
      }
      await result(run, 'subscribe', 'pendingSubscription', { subscriptionId: subscription.id, invoiceId: idOf(subscription.latest_invoice), subscriptionCreatedAt: subscription.created })
    }
    subscriptionId = subscription.id
    invoiceId = idOf(subscription.latest_invoice)
    invoice = typeof subscription.latest_invoice === 'object' && subscription.latest_invoice ? subscription.latest_invoice : null
  }

  // 2. Before a retried pay, the invoice's own status: never pay twice.
  let readOpen = false
  if (!invoice || retried) {
    try {
      invoice = await run.lease.stripe('invoice', o => stripe.invoices.retrieve(invoiceId, {}, o))
    } catch (err) {
      passLease(err)
      return afterStripeError(run, err)
    }
    readOpen = invoice.status !== 'paid'
  }
  if (invoice.status === 'void' || invoice.status === 'uncollectible') {
    // Stripe expired the unpaid first invoice (incomplete_expired, 23 hours).
    return markDeclined(run)
  }

  // 3. The first invoice. Already paid (a 100%-off pilot, or a payment whose
  //    reply was lost): no pay call.
  if (invoice.status !== 'paid') {
    // A pilot is free: a first invoice that is not already paid is never paid (Stripe expires it).
    if (pilot.pilot) return markRejected(run, 'pilot_not_free')
    await intent(run, 'pay', payKey)
    let paid: InvoiceLike
    try {
      paid = await run.lease.stripe('pay', o => stripe.invoices.pay(invoiceId, { off_session: true, payment_method: paymentMethod }, { idempotencyKey: payKey, ...o }))
    } catch (err) {
      passLease(err)
      return afterPayError(run, signup, invoiceId, subscriptionId, err, readOpen && retried)
    }
    if (paid.status !== 'paid') return markPending(run)
    await markPaid(run, signup, subscriptionId, { op: 'pay', invoice: { ...paid, id: paid.id || invoiceId } })
    return { outcome: 'paid', paid: true }
  }

  // 4. Paid already.
  await markPaid(run, signup, subscriptionId, { invoice: { ...invoice, id: invoice.id || invoiceId } })
  return { outcome: 'paid', paid: true }
}

/**
 * Before anything else, the holder reconciles an intent another lease left
 * (D1): subscribe adopts as a retried create does (D3: the marker's
 * subscription, then every page by metadata.provision_id; several stop billing
 * for a person); pay reads the invoice and takes the paid
 * path if it is paid; activate makes one activation try (the site's route is
 * idempotent). Then it clears the intent with its own fenced step. A Stripe
 * error leaves the intent and the sign-up pending. Answers the fresh state,
 * or an outcome that ends the run.
 */
async function reconcile(run: Run, state: State): Promise<State | { outcome: BillingOutcome }> {
  const found = foreignIntent(state, run.lease)
  if (!found) return state
  run.deps.log?.(`billing: reconciling an unfinished ${found.op}`)
  const stripe = () => run.deps.stripe()
  try {
    if (found.op === 'subscribe' && !state.pendingSubscriptionId && state.billing !== 'paid') {
      // The same adopt step as a retried create (D3): the marker, then every page; several stop billing.
      const signup = await readSignup(run)
      const customer = str(signup.stripeCustomerId)
      if (customer) {
        const adopted = await adopt(run, customer, true)
        if (adopted.kind === 'many') return { outcome: (await markMultiple(run)).outcome }
        if (adopted.kind === 'one') {
          if (pilotEndOf(signup, 0).pilot && !endsAt(adopted.sub, frozenPilotEnd(signup))) return { outcome: (await markRejected(run, 'no_pilot_end')).outcome }
          await adoptOne(run, adopted.sub)
        }
      }
    } else if (found.op === 'pay' && state.invoiceId && state.billing !== 'paid') {
      const invoice = await run.lease.stripe('invoice', o => stripe().invoices.retrieve(str(state.invoiceId), {}, o))
      if (invoice.status === 'paid' && state.pendingSubscriptionId) {
        await markPaid(run, await readSignup(run), str(state.pendingSubscriptionId), { invoice: { ...invoice, id: invoice.id || str(state.invoiceId) } })
      }
    } else if (found.op === 'activate' && state.billing === 'paid' && !state.activatedAt) {
      // One try; its own intent replaces the foreign one and its result clears it.
      await activateOnce(run, state)
    }
  } catch (err) {
    passLease(err)
    return { outcome: (await afterStripeError(run, err)).outcome }
  }
  await step(run, 'clearIntent', { token: found.token })
  return readState(run)
}

const ended = (r: State | { outcome: BillingOutcome }): r is { outcome: BillingOutcome } => typeof (r as { outcome?: unknown }).outcome === 'string' && Object.keys(r).length === 1

/**
 * B-1 at ready: under the lease, for a sign-up in ready whose billing is unset
 * or charging (a run cut short), charge and, once paid, activate with up to
 * five tries. A foreign intent is reconciled first; a sign-up it leaves paid
 * goes straight to the activation.
 */
export async function chargeAtReady(sid: string, deps: BillingDeps): Promise<BillingOutcome> {
  return runLocked(sid, deps, async (run) => {
    let state = await readState(run)
    if (isEmpty(state) || state.status !== 'ready') return 'skipped'
    // A site that never answered the probe waits for a person (23-43 Task 6).
    if (billingWaits(state)) return 'skipped'
    // Only an unset or charging (cut short) billing is charged here; the rest is resumeBilling's.
    if (state.billing && state.billing !== 'charging') return 'skipped'
    run.provisionId = str(state.provisionId)
    const rec = await reconcile(run, state)
    if (ended(rec)) return rec.outcome
    state = rec
    if (state.status === 'complete') return 'activated'
    if (state.status !== 'ready') return 'skipped'
    // A foreign pay intent reconciled to paid: the activation is what is left.
    if (state.billing === 'paid') return activateWithBackoff(run)
    if (state.billing && state.billing !== 'charging') return 'skipped'
    const { outcome, paid } = await charge(run, state)
    if (!paid) return outcome
    return activateWithBackoff(run)
  })
}

/**
 * The retry path (a status read, the QStash billing step, a repeated ready):
 * under the lease, finish whatever the first payment still owes, by this table:
 *   - complete: leaves sweep:billing (compare-and-remove);
 *   - not ready (held, declined, failed, gone): nothing;
 *   - billing paid, not activated: one activation try, no Stripe call;
 *   - billing unset, charging or pending: charge (adopt or create, read the
 *     invoice before any retried pay), then one activation try;
 *   - billing rejected or review: nothing (no automatic retry, no Stripe call,
 *     not even the reconcile step).
 * A foreign intent is reconciled first.
 */
export async function resumeBilling(sid: string, deps: BillingDeps): Promise<BillingOutcome> {
  return runLocked(sid, deps, async (run) => {
    let state = await readState(run)
    if (isEmpty(state)) return 'skipped'
    run.provisionId = str(state.provisionId)
    if (state.status === 'complete') {
      await clearIndex(deps.redis, sid, 'billing')
      return 'activated'
    }
    if (state.status !== 'ready') return 'skipped'
    // Rejected or review (D3), or a site that never answered the probe (23-43 Task 6), waits for a
    // person: not even the reconcile step calls Stripe.
    if (billingWaits(state)) return 'skipped'
    const rec = await reconcile(run, state)
    if (ended(rec)) return rec.outcome
    state = rec
    if (state.status === 'complete') {
      await clearIndex(deps.redis, sid, 'billing')
      return 'activated'
    }
    if (state.status !== 'ready') return 'skipped'
    if (state.billing === 'paid') {
      if (state.activatedAt) return 'activated'
      // Past the 24 h window only the QStash billing step acts (sweepBilling starts the refund).
      const out = await activateOnce(run, state)
      return out === 'activated' ? 'activated' : out === 'window' ? 'skipped' : 'paid'
    }
    if (!state.billing || state.billing === 'charging' || state.billing === 'pending') {
      const { outcome, paid } = await charge(run, state)
      if (!paid) return outcome
      const out = await activateOnce(run, await readState(run))
      return out === 'activated' ? 'activated' : 'paid'
    }
    return 'skipped'
  })
}

/**
 * invoice.paid for this app's first invoice (B-1 step 8), under the lease:
 *   - ready and owed (pending, charging): the paid step, storing the invoice
 *     id, the amount paid and the currency;
 *   - held or declined, before anything is undone (stopInvoice not set): the
 *     handBack step (HIGH 8, review round 1 Argon 1), the code hold released;
 *     a declined or held sign-up whose void is done is flagged instead;
 *   - tearing_down or torn_down: a paid_after_void entry in reconcile:flags
 *     (a payment on a voided sign-up needs a person) and nothing else written;
 *   - ready and already paid but not activated (the teardown's hand-back, or
 *     a redelivery): no Stripe call.
 * Then one activation try (the rest come from status reads and the sweep).
 * A sign-up complete, refunding, refunded, rejected, in billing review or gone changes nothing.
 * `subscriptionId` is the invoice's own, used when the hash never got one.
 */
export async function onFirstInvoicePaid(provisionId: string, deps: BillingDeps, subscriptionId?: string, invoice?: InvoiceLike, event?: PaidEvent): Promise<BillingOutcome> {
  const sid = await deps.redis.get(`provision:by-id:${provisionId}`)
  if (typeof sid !== 'string' || !sid) return 'skipped'
  return runLocked(sid, deps, async (run) => {
    const state = await readState(run)
    if (isEmpty(state) || str(state.provisionId) !== provisionId) return 'skipped'
    run.provisionId = provisionId
    const status = str(state.status)
    if (status === 'tearing_down' || status === 'torn_down') {
      // A refund case (23-43 Task 6): its invoice was paid, then refunded; a redelivery is not a payment on a voided sign-up.
      if (str(state.teardownReason) === 'activation_failed') return 'skipped'
      await flagPaidAfterVoid(run)
      return 'skipped'
    }
    // Paid already (the teardown's hand-back, or a redelivery) and not yet activated: one activation try.
    if (status === 'ready' && state.billing === 'paid') {
      if (state.activatedAt) return 'skipped'
      const out = await activateOnce(run, state)
      return out === 'activated' ? 'activated' : 'paid'
    }
    const subscription = str(state.pendingSubscriptionId) || str(subscriptionId)
    if (status === 'held' || status === 'declined') {
      if (!subscription) return 'skipped'
      // The void is done: nothing may hand it back now; a person reconciles the payment.
      if (state.stopInvoice === true || str(state.stopInvoice) === 'true') {
        await flagPaidAfterVoid(run)
        return 'skipped'
      }
      const handed = await step(run, 'handBack', {
        subscriptionId: subscription,
        invoiceId: invoice?.id || str(state.invoiceId) || undefined,
        amountPaid: typeof invoice?.amount_paid === 'number' ? invoice.amount_paid : undefined,
        currency: invoice?.currency || undefined,
        clearIntent: true
      })
      if (handed.result === 'refused') return 'skipped'
      await releaseCodeHold(run, await readSignup(run))
    } else {
      // Rejected or review waits for a person (D3): with two subscriptions, a payment is exactly what a person resolves.
      // Skipped, but never dropped without a trace (the orchestrator's addition): one reconcile:flags entry per event.
      if (billingStopped(state.billing)) {
        await recordPaidInReview(run, invoice, event)
        return 'skipped'
      }
      const owed = status === 'ready' && state.billing !== 'paid' && !billingStopped(state.billing)
      if (!owed || !subscription) return 'skipped'
      const signup = await readSignup(run)
      if (!(await markPaid(run, signup, subscription, { invoice: invoice ?? null, invoiceId: str(state.invoiceId) }))) return 'skipped'
    }
    const out = await activateOnce(run, await readState(run))
    return out === 'activated' ? 'activated' : 'paid'
  })
}

/** Start the charge at ready: through keepAlive when given, awaited otherwise. A throw is logged, never raised. */
export async function startBilling(sid: string, deps: BillingDeps, keepAlive?: (work: Promise<void>) => void): Promise<void> {
  const work = chargeAtReady(sid, deps)
    .then(() => undefined)
    .catch(() => deps.log?.('billing: charge not finished, the next trigger resumes it'))
  if (keepAlive) keepAlive(work)
  else await work
}

/**
 * A status read or a repeated ready resumes billing, at most once per 10
 * seconds per sign-up (SET billing:nudge:{provisionId} NX EX 10), through
 * keepAlive when given. Billing rejected or in review is never nudged. A throw
 * is logged, never raised.
 */
export async function nudgeBilling(sid: string, provisionId: string | undefined, deps: BillingDeps, keepAlive?: (work: Promise<void>) => void): Promise<void> {
  try {
    const state = await deps.redis.hgetall(stateKey(sid))
    // Rejected or review (23-43 Task 3), or a site that never answered the probe (Task 6), waits for a person: no nudge, no run.
    if (billingWaits(state)) return
    const pid = provisionId || str(state?.provisionId)
    if (!pid) return
    const taken = await deps.redis.set(nudgeKey(pid), '1', { nx: true, ex: NUDGE_SECONDS })
    if (!taken) return
  } catch {
    deps.log?.('billing: nudge not taken')
    return
  }
  const work = resumeBilling(sid, deps)
    .then(() => undefined)
    .catch(() => deps.log?.('billing: resume not finished, the next trigger resumes it'))
  if (keepAlive) keepAlive(work)
  else await work
}

export interface BillingCounts {
  due: number
  charged: number
  held: number
  declined: number
  pending: number
  activated: number
  busy: number
  errors: number
  /** 23-43 Task 6: refunds this step started (refundAndTearDown past the 24 h window). */
  refundStarted: number
  /** 23-43 Task 6: refunds this step found busy (another runner, or the site's 409 busy). */
  refundBusy: number
}

/** What the QStash billing step needs: the sweep's Redis (with a bounded read by score) and the billing wiring. */
export interface BillingSweepInput {
  redis: BillingRedis & {
    zrange: (
      key: string,
      min: number | '-inf' | '+inf',
      max: number | '-inf' | '+inf',
      opts: { byScore: true, offset: number, count: number }
    ) => Promise<unknown[]>
  }
  /** Built by makeBillingDeps in the sweep route. A due member without it counts in errors: a missing wiring is never skipped silently. */
  billing?: BillingDeps
  /** 23-43 Task 6: the refund wiring (refund.ts refundDepsOf). A refund owed without it counts in errors. */
  refund?: RefundDeps
  now?: () => number
}

/**
 * The QStash billing step (23-38's route, third entry of CRON_STEPS): read at
 * most 50 due members of sweep:billing once, resume each in its own try/catch.
 * A member whose sign-up is gone or no longer ready leaves the set. A paid
 * sign-up never activated, past paidAt + 24 h, starts refundAndTearDown
 * (23-43 Task 6, Tom's ruling): only this step starts a refund, never a status
 * read. The step's log line (cron-sweep.ts) has counts only.
 */
export async function sweepBilling(input: BillingSweepInput): Promise<BillingCounts> {
  const { redis } = input
  const now = (input.now ?? input.billing?.now ?? Date.now)()
  const counts: BillingCounts = { due: 0, charged: 0, held: 0, declined: 0, pending: 0, activated: 0, busy: 0, errors: 0, refundStarted: 0, refundBusy: 0 }
  const members = (await redis.zrange(BILLING_INDEX, '-inf', now, { byScore: true, offset: 0, count: BILLING_SWEEP_LIMIT })).map(String)
  counts.due = members.length
  for (const sid of members) {
    try {
      const state = await redis.hgetall(stateKey(sid))
      if (isEmpty(state) || state.status !== 'ready') {
        // Compare-and-remove (Codex 6): a member the paid step has just put back stays.
        await clearIndex(redis, sid, 'billing')
        continue
      }
      if (!input.billing) throw new Error('billing: not wired')
      // Billing waiting for a person (review, rejected) is never refunded or torn down automatically.
      if (refundOwed(state, now) && !billingWaits(state)) {
        if (!input.refund) throw new Error('billing: refund not wired')
        const refunded = await refundAndTearDown(sid, input.refund)
        if (refunded === 'busy' || refunded === 'lost') counts.refundBusy++
        else if (refunded === 'activated') counts.activated++
        else if (refunded !== 'skipped') counts.refundStarted++
        continue
      }
      const outcome = await resumeBilling(sid, input.billing)
      if (outcome === 'paid') counts.charged++
      else if (outcome === 'activated') counts.activated++
      else if (outcome === 'held') counts.held++
      else if (outcome === 'declined') counts.declined++
      else if (outcome === 'pending') counts.pending++
      else if (outcome === 'busy' || outcome === 'lost') counts.busy++
    } catch {
      counts.errors++
    }
  }
  return counts
}

/** The invoice fields the webhook routing reads (Stripe.Invoice, API 2026-02-25.clover). */
export interface RoutedInvoice {
  id?: string
  amount_paid?: number | null
  currency?: string | null
  billing_reason?: string | null
  customer_email?: string | null
  hosted_invoice_url?: string | null
  parent?: { subscription_details?: { metadata?: Record<string, string> | null, subscription?: unknown } | null } | null
  subscription_details?: { metadata?: Record<string, string> | null } | null
}

export interface InvoiceRouteDeps extends BillingDeps {
  /** A renewal's failed or action-required payment (B-2, Phase 23 part): the card mail (billing-mail.ts). */
  onRenewalProblem?: (invoice: RoutedInvoice, kind: 'update' | 'confirm', createdSec: number) => Promise<void>
}

/** The provision id this app put on the subscription, read from the invoice. */
function invoiceProvisionId(invoice: RoutedInvoice): string {
  const id = invoice.parent?.subscription_details?.metadata?.provision_id ?? invoice.subscription_details?.metadata?.provision_id
  return typeof id === 'string' && PROVISION_ID_PATTERN.test(id) ? id : ''
}

/**
 * Decide what an invoice event means (called before the webhook's closed
 * gate). Only invoices whose subscription metadata names a provision id this
 * app made act:
 *   - invoice.paid, first invoice (billing_reason subscription_create):
 *     onFirstInvoicePaid;
 *   - invoice.payment_failed or invoice.payment_action_required, first
 *     invoice: nothing (the pay call's own result decides);
 *   - a renewal (any other billing_reason) that failed or needs action:
 *     onRenewalProblem; a renewal that was paid: nothing.
 * A throw goes back to the webhook, which answers 503 so Stripe retries. A
 * held billing lock is one: onFirstInvoicePaid's 'busy' raises
 * BillingBusyError, so it is never acknowledged and lost.
 */
export async function routeInvoiceEvent(event: { id?: string, type: string, created?: number, data: { object: unknown } }, deps: InvoiceRouteDeps): Promise<BillingOutcome | 'ignored' | 'mailed'> {
  const invoice = event.data.object as RoutedInvoice
  const provisionId = invoiceProvisionId(invoice)
  if (!provisionId) return 'ignored'
  const first = invoice.billing_reason === 'subscription_create'
  if (event.type === 'invoice.paid') {
    if (!first) return 'ignored'
    const sub = invoice.parent?.subscription_details?.subscription
    const subId = typeof sub === 'string' ? sub : typeof sub === 'object' && sub ? str((sub as { id?: unknown }).id) : ''
    const outcome = await onFirstInvoicePaid(provisionId, deps, subId || undefined, {
      id: invoice.id,
      amount_paid: invoice.amount_paid,
      currency: invoice.currency
    }, { id: event.id, created: event.created })
    // Busy, or a lease lost mid-step: never acknowledged, so Stripe redelivers (the paid step's guard makes a redelivery safe).
    if (outcome === 'busy' || outcome === 'lost') throw new BillingBusyError()
    return outcome
  }
  if (event.type !== 'invoice.payment_failed' && event.type !== 'invoice.payment_action_required') return 'ignored'
  if (first) {
    deps.log?.(`stripe-webhook: first invoice ${event.type}, the pay call decides`)
    return 'ignored'
  }
  if (!deps.onRenewalProblem) return 'ignored'
  await deps.onRenewalProblem(invoice, event.type === 'invoice.payment_failed' ? 'update' : 'confirm', num(event.created))
  return 'mailed'
}
