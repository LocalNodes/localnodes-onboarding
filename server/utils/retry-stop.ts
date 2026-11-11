// Failure, free retry and stop (Phase 23, plan 23-14; ONB-02, D-15, D-16 as
// superseded by T-3, D-17). Plain module, no Nitro globals: Redis, Stripe, the
// dispatch, the mailer and the clock are injected, so tests import it directly
// and the routes only wire it up.
//
// The card is charged only once the site is live (T-3, 23-32). So a build that
// fails has charged nothing, and stopping a sign-up never refunds or cancels:
//   1. A failed build (the workflow's "failed" for the current attempt) counts
//      one failure, frees the provisioning lock and, below two failures, offers
//      one free retry (canRetry).
//   2. POST /api/retry-provisioning runs the build again for the same Stripe
//      session: attempt 2, the same provision id, no new checkout.
//   3. A second failure stops the sign-up (stopProvision): the code hold and the
//      lock are released, the saved card is detached, the record is marked
//      stopped and one "you weren't charged" mail goes out.
//
// A "failed" from the site itself (source "site", the entrypoint) is
// provisional for 10 minutes: a "complete" for the same attempt in that window
// wins. The workflow's "failed" is final (research Q5). A provisional failure
// becomes final when the window has passed and the next callback or status
// read sees it (settleProvisional).
//
// Counting is keyed by attempt: provision:{sid}:failed:{attempt} is taken with
// SET NX before the count goes up, so a replayed or concurrent "failed" for the
// same attempt counts once.
//
// Every stop step runs at most once per provision id: a done flag per step on
// the state hash (stopInvoice, stopHold, stopLock, stopCard, stopInvite,
// stopMail, stopCapacity, stopAiKey, stopApp), an already-detached card counts
// as done, and each mail carries a Resend Idempotency-Key per provision id. A
// provision that has a subscriptionId, or whose status is complete, is never
// stopped.
//
// The one teardown runner (23-37). stopProvision serves these reasons, read
// from teardownReason:
//   - build_failed: a build that failed twice. The six steps above, the
//     stopped mail, stopped true;
//   - declined: the first payment was declined (23-32, B-1 step 4);
//   - held_expired: the bank's confirmation never came within the 3DS hold
//     (B-1 step 5, teardown.ts sweepHeld and expireHold below); its "We've
//     removed your site" goes out only after the workflow confirms the delete
//     (teardown.ts, P4);
//   - activation_failed: Tom's refund case (23-43 Task 6, 2026-11-09): a paid
//     site that could not be handed over in 24 hours, refunded in full first
//     (refund.ts). The runner moves it from refunded to tearing_down, reopens
//     the invite, sends the one refund mail (P1, its lateActivation body, or
//     the Stopped mail for a zero invoice, P5; refund-mail-{provisionId}) and
//     asks for the delete. No void: the invoice is paid and refunded.
// For the two unpaid reasons the unpaid invoice is voided and the unfinished
// subscription cancelled first (stopInvoice): an invoice found paid then stops
// the teardown before anything is undone and hands the sign-up back to
// billing in one handBack step. They also reopen the invite (stopInvite).
//
// Terminal states (23-43 Task 2, escalation point 3). A stop's first write is
// the move to tearing_down (a guarded step: a build that failed twice with no
// money moved, or a declined payment right after its void); nothing leaves
// tearing_down but torn_down, and no charge path touches either. The flag
// tornDown means every runner step ran (stopped too for a build failure); the
// status torn_down means the workflow confirmed the app is gone. Every done
// flag, the final write and its 72 h lifetime are transitions; no step lowers
// a lifetime or removes a sweep member with a bare ZREM.
// Every reason ends with stopApp: a dispatch of 23-36's teardown-instance.yml,
// which deletes only the app tagged ln-provision:{provision_id}, and only after
// GET /api/teardown-check says yes (D-18 note: automated deletion is allowed
// for exactly an unpaid first payment and a twice-failed build). The stop logs
// the Coolify app uuid it asked to delete.
//
// A stop runs at most once at a time per sign-up, and never beside billing
// (23-43): stopProvision takes the sign-up's one lifecycle lock
// (lifecycle.ts withLifecycleLock, provision:{sid}:lifecycle), the same lock
// every billing path takes, renewed while held and released by
// compare-and-delete. So the status read, the callback, the retry route, the
// webhook and the QStash sweep can meet without a second detach or mail, and a
// stop never runs while a charge does. Every Stripe call, the mail and the app
// delete check the lease's margin first and run under one total deadline. A
// paid invoice found by the void step hands the sign-up back; 23-32's paid path
// (onPaid) then runs after the lease is released.
//
// Counting a failure is one Lua step (lifecycle.ts COUNT_FAILURE_SCRIPT): it
// checks the sign-up is still in its build and no money has moved before it
// counts (HIGH 6), and a second failure joins sweep:stops in the same step. A
// site's provisional failure, the retry and its dispatch are transitions too.
//
// The sweep finds a failure through sweep:stops (score = when it is due):
// written where a site's failure window is set (score provisionalUntil) and
// where a stop is scheduled (score now). A stop under way leaves it for
// sweep:teardown in its tearing_down step, so the teardowns step finishes a
// stop cut short, whatever its reason.
//
// Privacy rule: logs carry type names, codes and ids only, never the email.
import * as v from 'valibot'
import type { DispatchFn } from './provisioning'
import { REPLY_TO, STOPPED_MAIL, STOPPED_SENTENCE, buildDeclinedMail, buildRefundMail, type BuiltMail } from './mail-copy'
import { reopenInvite } from './invites'
import { releaseHold } from './promo'
import { addInflight, removeInflight } from './capacity'
import { deleteProvisionKey } from './byo-key'
import {
  DISPATCH_TIMEOUT_MS,
  LeaseLostError,
  MAIL_TIMEOUT_MS,
  STOPS_INDEX,
  applyResult,
  clearIndex,
  countFailureAtomic,
  foreignIntent,
  isApplied,
  keepIfLateZero,
  transition,
  withLifecycleLock,
  writeIntent,
  type IntentOp,
  type Lease,
  type LockDeps,
  type StripeCallOptions,
  type TransitionName,
  type TransitionParams,
  type TransitionResult
} from './lifecycle'

/** The subset of the Upstash client this file uses, typed as Upstash types it. */
export interface RetryStopRedis {
  get: (key: string) => Promise<unknown>
  /** NX with ex (the build lock, the claim) or px (the lifecycle lock). */
  set: (key: string, value: string, opts: { nx: true, ex: number } | { nx: true, px: number } | { ex: number }) => Promise<unknown>
  del: (...keys: string[]) => Promise<unknown>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  hincrby: (key: string, field: string, increment: number) => Promise<number>
  expire: (key: string, seconds: number) => Promise<unknown>
  zrem: (key: string, ...members: string[]) => Promise<unknown>
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
  /** The in-flight count (capacity.ts addInflight), refreshed by a retry. */
  zadd: (key: string, scoreMember: { score: number, member: string }) => Promise<unknown>
  zremrangebyscore: (key: string, min: number | '-inf' | '+inf', max: number | '-inf' | '+inf') => Promise<unknown>
}

/**
 * The Stripe calls a stop makes. Nothing here takes money: a build failure
 * detaches the saved card; an unpaid first payment (23-37) also reads and
 * voids its invoice and cancels its unfinished subscription (stripe-node 20.4).
 */
export interface StopStripe {
  setupIntents: { retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<{ payment_method?: string | { id: string } | null }> }
  paymentMethods: { detach: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<unknown> }
  invoices?: {
    retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<StopInvoice>
    voidInvoice: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<unknown>
  }
  subscriptions?: {
    cancel: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<unknown>
    retrieve: (id: string, params: Record<string, never>, opts: StripeCallOptions) => Promise<{ status?: string | null }>
  }
}

/** The invoice fields the void step and the paid hand-back read (Stripe.Invoice, API 2026-02-25.clover). */
export interface StopInvoice {
  id?: string
  status?: string | null
  amount_paid?: number | null
  currency?: string | null
  parent?: { subscription_details?: { subscription?: unknown } | null } | null
}

export type MailFetcher = (url: string, opts: { method: 'POST', headers: Record<string, string>, body: Record<string, unknown>, signal?: AbortSignal }) => Promise<unknown>

export interface StopMailConfig {
  /** Resend API key (NUXT_RESEND_API_KEY). */
  apiKey: string
  /** Verified sender (NUXT_MAIL_FROM). */
  from: string
  fetch: MailFetcher
}

export interface RetryStopDeps extends Pick<LockDeps, 'tick' | 'timers'> {
  redis: RetryStopRedis
  /** Stripe, read only when a stop runs, so a callback never needs it otherwise. */
  stripe?: () => StopStripe
  mail?: StopMailConfig
  /** The workflow dispatch; the retry needs it. */
  dispatch?: DispatchFn
  /** Keeps a stop alive after the reply (event.waitUntil and Vercel's waitUntil). Without it the stop is awaited. */
  keepAlive?: (work: Promise<void>) => void
  /** Milliseconds. Tests inject it. */
  now?: () => number
  log?: (msg: string) => void
  /** NUXT_INVITE_HASH_SECRET: finds the invite to reopen after an unpaid first payment (23-37). */
  inviteHashSecret?: string
  /** The app delete: a dispatch of teardown-instance.yml (github.ts dispatchTeardown; 23-36, 23-37), aborted by the lease's signal at DISPATCH_TIMEOUT_MS. */
  teardown?: (p: { subdomain: string, provisionId: string }, signal?: AbortSignal) => Promise<void>
  /** 23-32's paid path (onFirstInvoicePaid), for an invoice found paid by the void step. Runs after the lease is released; its outcome is logged when not done. */
  onPaid?: (provisionId: string) => Promise<unknown>
}

/** What a failed callback says, after the callback schema. */
export interface FailedCallback {
  attempt: number
  reason?: string
  appUuid?: string
  source: 'workflow' | 'site'
}

export type RetryOutcome =
  | { status: 200, body: { ok: true } }
  | { status: number, body: { message: string } }

const PROVISION_TTL = 86400 // 24 hours
const LOCK_SECONDS = 3600
/** How long a site's own "failed" waits for a "complete" before it counts (research Q5). */
export const PROVISIONAL_MS = 10 * 60 * 1000
/** Two failed builds stop the sign-up (D-15). */
export const MAX_FAILURES = 2

export const ALREADY_RUNNING = 'Setup is already running.'
/** A retry whose dispatch failed but left a try (not reachable today: a retry is always the last try). */
export const RETRY_NOT_STARTED = 'We couldn\'t start the retry. Try again in a moment.'

const stateKey = (sid: string) => `provision:${sid}`
const lockKey = (sid: string) => `provision:${sid}:lock`
const countedKey = (sid: string, attempt: number) => `provision:${sid}:failed:${attempt}`
const stopKey = (sid: string) => `provision:${sid}:stop`

/** The sweep's work list (23-38): member = session id, score = when it is due (ms). Outside provision:*, so 23-21's walk over provision hashes never meets it. Defined in lifecycle.ts with the other indexes. */
export { STOPS_INDEX }

/** Why a sign-up is being torn down (teardownReason; lifecycle.ts TEARDOWN_REASONS). */
export type { TeardownReason } from './lifecycle'
const isUnpaid = (reason: string) => reason === 'declined' || reason === 'held_expired'
const str = (value: unknown) => (value === null || value === undefined ? '' : String(value))
/** The statuses a teardown runs in (23-43): entered only through a guarded tearingDown step. */
const isTeardownStatus = (status: unknown) => status === 'tearing_down' || status === 'torn_down'

const isTrue = (value: unknown) => String(value) === 'true'
const num = (value: unknown, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Count the failure of one attempt, once, in one Lua step
 * (COUNT_FAILURE_SCRIPT, 23-43): only while the sign-up is still in its build
 * (or failed) and no money has moved, so a stale failure read before a payment
 * can never turn a paid, complete sign-up into failed (HIGH 6). Sets failed
 * with the reason, ends any provisional window, sets canRetry below two
 * failures, frees the provisioning lock and, at the second, joins sweep:stops.
 * Answers the new count; taken (this attempt was counted before) with the
 * stored count; or refused (the sign-up has moved on: nothing written).
 */
async function countFailure(
  sessionId: string,
  state: Record<string, unknown>,
  attempt: number,
  fields: { reason?: string, appUuid?: string },
  deps: RetryStopDeps
): Promise<{ counted: boolean, count: number, refused: boolean }> {
  const out = await countFailureAtomic(deps.redis, sessionId, {
    provisionId: state.provisionId ? String(state.provisionId) : undefined,
    attempt,
    reason: fields.reason,
    appUuid: fields.appUuid,
    now: (deps.now ?? Date.now)()
  })
  if (out.result === 'counted') return { counted: true, count: out.count, refused: false }
  if (out.result === 'taken') {
    const fresh = await deps.redis.hgetall(stateKey(sessionId))
    return { counted: false, count: num(fresh?.failedAttempts), refused: false }
  }
  if (out.result === 'invalid') deps.log?.('retry-stop: failure not counted, the record is malformed')
  return { counted: false, count: 0, refused: true }
}

/** Finish a build-failure stop cut short (a replayed failed callback on a sign-up already tearing_down, 23-43). */
export const resumeStop = (sessionId: string, deps: RetryStopDeps) => scheduleStop(sessionId, deps)

/** Start the stop in the background (keepAlive), or await it when there is none. Its errors are logged, never raised. */
async function scheduleStop(sessionId: string, deps: RetryStopDeps): Promise<void> {
  // Indexed first, so a stop cut short on any path is found and finished by the sweep (23-38).
  try {
    await deps.redis.zadd(STOPS_INDEX, { score: (deps.now ?? Date.now)(), member: sessionId })
  } catch {
    deps.log?.('retry-stop: stop not indexed')
  }
  const work = stopProvision(sessionId, deps)
    .then(() => undefined)
    .catch(() => deps.log?.('retry-stop: stop not finished, the next trigger resumes it'))
  if (deps.keepAlive) deps.keepAlive(work)
  else await work
}

/**
 * A site's own "failed" whose 10-minute window has passed becomes final here:
 * the failure is counted (once per attempt), the lock freed and, below two
 * failures, the retry offered. Called on a status read and before a callback
 * is applied. At the second failure it starts the stop when Stripe and the
 * mailer are wired (the status and callback routes wire them). A site can fail
 * after the workflow has already finished (organizer_failed,
 * platform_enable_failed), and then no other callback comes, so this read is
 * the only trigger. Without the wiring the stop waits for the next trigger.
 * True when it counted.
 */
export async function settleProvisional(sessionId: string, state: Record<string, unknown>, deps: RetryStopDeps): Promise<boolean> {
  const until = num(state.provisionalUntil)
  if (until <= 0 || (deps.now ?? Date.now)() < until) return false
  const attempt = num(state.attempt, 1)
  if (num(state.countedAttempt) >= attempt) return false
  const out = await countFailure(sessionId, state, attempt, { reason: state.reason ? String(state.reason) : 'unknown' }, deps)
  if (out.counted && out.count >= MAX_FAILURES) {
    if (deps.stripe && deps.mail) await scheduleStop(sessionId, deps)
    else deps.log?.('retry-stop: second failure counted; the stop waits for the next trigger')
  }
  return out.counted
}

/**
 * The dispatch itself threw (first run or retry; ruling "Dispatch fails after
 * the invite is claimed"): the same as a workflow "failed" for that attempt,
 * with reason unknown. The lock is freed and it counts, so a first-run dispatch
 * failure still leaves the one free retry, and a retry's is the second failure
 * and stops. Returns the failure count.
 */
export async function recordDispatchFailure(sessionId: string, attempt: number, deps: RetryStopDeps): Promise<number> {
  const { redis } = deps
  await redis.del(lockKey(sessionId))
  const state = (await redis.hgetall(stateKey(sessionId))) ?? {}
  const out = await countFailure(sessionId, state, attempt, { reason: 'unknown' }, deps)
  // Refused: the sign-up moved on (ready, paid, complete): nothing counted, nothing stopped (HIGH 6).
  if (!out.refused && out.count >= MAX_FAILURES) await scheduleStop(sessionId, deps)
  return out.count
}

/**
 * A "failed" callback for this provision. `state` is the provision hash as read
 * by the callback handler. A callback for an older attempt changes nothing.
 */
export async function recordFailure(
  sessionId: string,
  state: Record<string, unknown>,
  cb: FailedCallback,
  deps: RetryStopDeps
): Promise<{ updated: boolean }> {
  const now = (deps.now ?? Date.now)()
  if (cb.attempt < num(state.attempt, 1)) return { updated: false }
  if (isTrue(state.stopped)) return { updated: false }

  if (cb.source === 'site') {
    // Already final for this attempt, or already waiting on a window: the first
    // one stands. The provisional transition checks the same (and that the
    // sign-up is still in its build) in the step itself (HIGH 6).
    if (num(state.countedAttempt) >= cb.attempt || num(state.provisionalUntil) > 0) {
      return { updated: false }
    }
    // The sweep settles it when the window passes, even with no page open (23-38): sweep:stops in the same step.
    const out = await transition(deps.redis, sessionId, 'provisional', {
      provisionId: state.provisionId ? String(state.provisionId) : undefined,
      now,
      attempt: cb.attempt,
      reason: cb.reason ?? 'unknown',
      appUuid: cb.appUuid,
      provisionalUntil: now + PROVISIONAL_MS
    })
    return { updated: isApplied(out) }
  }

  const out = await countFailure(sessionId, state, cb.attempt, { reason: cb.reason, appUuid: cb.appUuid }, deps)
  // At two failures the sign-up stops. A replayed "failed" after an interrupted
  // stop starts it again; the done flags skip what already happened. A refused
  // count (the sign-up moved on) stops nothing.
  if (!out.refused && out.count >= MAX_FAILURES) await scheduleStop(sessionId, deps)
  return { updated: out.counted }
}

/**
 * Run the build again for the same Stripe session, with no new checkout. Only
 * when the status is failed with a retry offered, fewer than two failures are
 * counted and the sign-up wasn't stopped. SET NX on the lock keeps two retries
 * at once to one dispatch.
 */
export async function retryProvisioning(sessionId: string, deps: RetryStopDeps): Promise<RetryOutcome> {
  const { redis } = deps
  if (!deps.dispatch) throw new Error('retry-stop: dispatch not wired')
  const key = stateKey(sessionId)
  const state = await redis.hgetall(key)
  if (!state || Object.keys(state).length === 0) return { status: 404, body: { message: 'Not Found' } }

  if (isTrue(state.stopped) || num(state.failedAttempts) >= MAX_FAILURES) {
    // Two failures and not yet stopped: a stop was cut short, so finish it.
    if (!isTrue(state.stopped)) await scheduleStop(sessionId, deps)
    return { status: 409, body: { message: STOPPED_SENTENCE } }
  }
  if (state.status !== 'failed' || !isTrue(state.canRetry)) {
    return { status: 409, body: { message: ALREADY_RUNNING } }
  }
  // A build still holding the provisioning lock is running: refused before any write.
  if (await redis.get(lockKey(sessionId))) return { status: 409, body: { message: ALREADY_RUNNING } }
  // failed with canRetry becomes triggered with attempt plus one, in one step:
  // two retries at once give one dispatch (the second is refused).
  const before = num(state.attempt, 1)
  const retried = await transition(redis, sessionId, 'retry', {
    provisionId: state.provisionId ? String(state.provisionId) : undefined,
    now: (deps.now ?? Date.now)(),
    attempt: before
  })
  if (!isApplied(retried)) return { status: 409, body: { message: ALREADY_RUNNING } }
  const attempt = before + 1
  await redis.set(lockKey(sessionId), 'locked', { ex: LOCK_SECONDS })
  // The new build holds room for 45 minutes from now (23-17). Same member, so a
  // retry never counts twice. A failure here never stops the free retry.
  if (state.provisionId) {
    try {
      await addInflight(redis, String(state.provisionId), (deps.now ?? Date.now)())
    } catch {
      deps.log?.('retry-stop: in-flight count not refreshed')
    }
  }
  let run: { runId: number, runUrl: string }
  try {
    run = await deps.dispatch({
      subdomain: String(state.subdomain),
      provisionId: String(state.provisionId),
      attempt
    })
  } catch {
    // The session id only: github.ts already keeps GitHub's answer out of its message.
    console.error('dispatch failed', { sessionId })
    const total = await recordDispatchFailure(sessionId, attempt, deps)
    if (total >= MAX_FAILURES) return { status: 409, body: { message: STOPPED_SENTENCE } }
    return { status: 503, body: { message: RETRY_NOT_STARTED } }
  }
  const { runId, runUrl } = run
  await transition(redis, sessionId, 'dispatched', {
    provisionId: state.provisionId ? String(state.provisionId) : undefined,
    now: (deps.now ?? Date.now)(),
    attempt,
    githubRunId: runId,
    githubRunUrl: runUrl
  })
  return { status: 200, body: { ok: true } }
}

/** A Stripe Checkout session id, as the success page has it. */
const retryBodySchema = v.object({
  session_id: v.pipe(v.string(), v.regex(/^cs_[A-Za-z0-9_]{1,250}$/))
})

/**
 * POST /api/retry-provisioning. Gated like the other sign-up routes: while the
 * launch is closed only an invited session gets past the middleware, and this
 * checks it again (a 404, as the gate answers).
 */
export async function handleRetryRequest(
  raw: unknown,
  deps: RetryStopDeps & { open: boolean, invited: boolean }
): Promise<RetryOutcome> {
  if (!deps.open && !deps.invited) return { status: 404, body: { message: 'Not Found' } }
  const parsed = v.safeParse(retryBodySchema, raw)
  if (!parsed.success) return { status: 400, body: { message: 'session_id is required' } }
  return retryProvisioning(parsed.output.session_id, deps)
}

/** Is this Stripe error a card that is already gone or already detached? */
function alreadyDetached(err: unknown): boolean {
  const e = err as { code?: unknown, message?: unknown, raw?: { code?: unknown } } | null
  const code = e?.code ?? e?.raw?.code
  if (code === 'resource_missing' || code === 'payment_method_not_attached') return true
  const message = typeof e?.message === 'string' ? e.message : ''
  return /no such payment ?method|not attached/i.test(message)
}

/**
 * Send one customer mail through Resend (POST /emails), keyed so a retried
 * send goes out once: the stopped mail (stop-mail-{provisionId}), the
 * declined mail (declined-mail-), the removed mail (removed-mail-) and the 3DS
 * mail (held-mail-, teardown.ts). No unsubscribe link: these go to a customer.
 */
export async function sendCustomerMail(to: string, built: BuiltMail, idempotencyKey: string, mail: StopMailConfig, signal?: AbortSignal): Promise<void> {
  if (!mail.apiKey) throw new Error('mail not configured: no API key')
  if (!mail.from) throw new Error('mail not configured: no sender')
  await mail.fetch('https://api.resend.com/emails', {
    method: 'POST',
    // One total deadline (23-43, H1): the lease's abort signal, when the caller has one.
    signal,
    headers: {
      'Authorization': `Bearer ${mail.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: {
      from: mail.from,
      to: [to],
      reply_to: REPLY_TO,
      subject: built.subject,
      text: built.text,
      html: built.html
    }
  })
}

/**
 * The runner's one mail for a reason, and its Idempotency-Key prefix. None
 * for held_expired: its "We've removed your site" goes out only after the
 * workflow confirms the delete (teardown.ts sendRemovedMail, P4).
 * activation_failed (23-43 Task 6): the refund mail, reached only after D2's
 * refund (or a zero invoice): P1, P1's lateActivation body, or the Stopped
 * mail for a zero invoice (P5), all keyed refund-mail-{provisionId}.
 */
function stopMailFor(reason: string, state: Record<string, unknown>): { built: BuiltMail, prefix: string } | null {
  if (reason === 'declined') return { built: buildDeclinedMail(), prefix: 'declined-mail' }
  if (reason === 'build_failed') return { built: STOPPED_MAIL, prefix: 'stop-mail' }
  if (reason === 'activation_failed') {
    return { built: buildRefundMail({ lateActivation: isTrue(state.lateActivation), refundZero: isTrue(state.refundZero) }), prefix: 'refund-mail' }
  }
  return null
}

/** A Stripe error for an object that is already in the state we want: read again and compare. */
const doneInvoice = (status: unknown) => status === 'void'
const doneSubscription = (status: unknown) => status === 'canceled' || status === 'incomplete_expired'

/** One stop run under the lease: who, with what, for which provision. */
interface StopRun {
  sid: string
  deps: RetryStopDeps
  lease: Lease
  provisionId: string
}

const nowOf = (deps: RetryStopDeps) => (deps.now ?? Date.now)()

/** A fenced write through a named transition. Lost: the run stops (LeaseLostError). Invalid: logged and raised. */
async function step(run: StopRun, name: TransitionName, params: TransitionParams = {}): Promise<TransitionResult> {
  const out = await transition(run.deps.redis, run.sid, name, { provisionId: run.provisionId || undefined, now: nowOf(run.deps), ...params }, run.lease)
  if (out.result === 'lost') throw new LeaseLostError(name)
  if (out.result === 'invalid') {
    run.deps.log?.(`lifecycle: ${name} could not apply (${out.why})`)
    throw new Error(`retry-stop: ${name} could not apply (invalid)`)
  }
  return out
}

/** The intent before a remote mutation (D1). */
async function intent(run: StopRun, op: IntentOp, key: string): Promise<void> {
  await writeIntent(run.deps.redis, run.sid, run.lease, op, key, { provisionId: run.provisionId || undefined, now: nowOf(run.deps) })
}

/** A remote call's result, applied only while the intent is this lease's; a stale one ends the run as lost. */
async function result(run: StopRun, op: IntentOp, name: TransitionName, params: TransitionParams = {}): Promise<void> {
  const out = await applyResult(run.deps.redis, run.sid, run.lease, op, name, { provisionId: run.provisionId || undefined, now: nowOf(run.deps), ...params }, run.deps.log)
  if (out === 'dropped') throw new LeaseLostError(op)
}

/** A step after a remote call when one was made (its intent), a plain fenced step that clears any intent when none was. Answers whether it applied. */
async function finish(run: StopRun, op: IntentOp | null, name: TransitionName, params: TransitionParams = {}): Promise<boolean> {
  if (op) {
    await result(run, op, name, params)
    return true
  }
  return isApplied(await step(run, name, { ...params, clearIntent: true }))
}

/** A done flag for a local step (no remote call). */
const done = (run: StopRun, flag: string) => step(run, 'teardownStep', { flag })

const KNOWN_OPS = new Set<string>(['subscribe', 'pay', 'activate', 'void', 'cancel', 'detach', 'dispatch', 'mail', 'refund'])

/**
 * An intent another lease left (D1): the stop's steps reconcile by design.
 * void and cancel read Stripe first and continue from its state (the cancel
 * step reads the subscription before cancelling again); detach treats an
 * already-detached card as done; dispatch runs again (the workflow is
 * idempotent per provision); mail is sent again with the same Resend
 * Idempotency-Key. A billing op's intent is cleared: the void step reads the
 * invoice. The intent is cleared with the holder's own fenced step.
 */
async function reconcileStop(run: StopRun, state: Record<string, unknown>): Promise<{ readCancel: boolean }> {
  const found = foreignIntent(state, run.lease)
  if (!found) return { readCancel: false }
  run.deps.log?.(`retry-stop: reconciling an unfinished ${KNOWN_OPS.has(found.op) ? found.op : 'step'}`)
  await step(run, 'clearIntent', { token: found.token })
  return { readCancel: found.op === 'cancel' }
}

/** The subscription an invoice belongs to (API 2026-02-25.clover: parent.subscription_details.subscription). */
function invoiceSubscription(invoice: StopInvoice): string {
  const sub = invoice.parent?.subscription_details?.subscription
  if (typeof sub === 'string') return sub
  return typeof sub === 'object' && sub ? str((sub as { id?: unknown }).id) : ''
}

/**
 * The invoice was paid after all (the bank or the organizer confirmed it at
 * the last moment; HIGH 8, review round 1 Argon 1): one handBack step, under
 * the lease and only from held or declined before anything is undone,
 * makes the sign-up ready with billing paid, its subscription (the pending
 * one, else the invoice's own), the invoice, amount and currency, out of
 * sweep:teardown and sweep:held and into sweep:billing. The code hold is
 * then released as markPaid does. The activation runs after the lease
 * (stopProvision's onPaid); the sign-up waits in sweep:billing either way.
 */
async function handBackPaid(run: StopRun, state: Record<string, unknown>, invoice: StopInvoice, op: IntentOp | null): Promise<{ stopped: false, handedBack?: string }> {
  const subscriptionId = str(state.pendingSubscriptionId) || invoiceSubscription(invoice)
  if (!subscriptionId) throw new Error('retry-stop: a paid invoice with no subscription')
  run.deps.log?.('retry-stop: the invoice is paid; teardown stopped, handed to billing')
  const applied = await finish(run, op, 'handBack', {
    subscriptionId,
    invoiceId: invoice.id || str(state.invoiceId) || undefined,
    amountPaid: typeof invoice.amount_paid === 'number' ? invoice.amount_paid : undefined,
    currency: invoice.currency || undefined
  })
  if (!applied) return { stopped: false }
  const signup = (run.provisionId ? await run.deps.redis.hgetall(`signup:${run.provisionId}`) : null) ?? {}
  if (signup.promoId && signup.inviteId) {
    try {
      await releaseHold(run.deps.redis, str(signup.promoId), str(signup.inviteId))
    } catch {
      run.deps.log?.('retry-stop: code hold not released, it runs out on its own')
    }
  }
  return { stopped: false, handedBack: run.provisionId }
}

/**
 * Void the unpaid first invoice and cancel the unfinished subscription, with
 * an intent before each Stripe mutation. A Stripe error is read again: an
 * invoice already void, or a subscription already canceled or
 * incomplete_expired, is done. Answers the paid invoice when it turns out to
 * be paid (before or during the void), else done; `op` is the last intent
 * written (none when nothing had to change).
 */
async function voidAndCancel(run: StopRun, state: Record<string, unknown>, readCancel: boolean): Promise<{ paid?: StopInvoice, op: IntentOp | null }> {
  const { deps, lease } = run
  const invoiceId = str(state.invoiceId)
  const subscriptionId = str(state.pendingSubscriptionId)
  let op: IntentOp | null = null
  if (!invoiceId && !subscriptionId) return { op }
  if (!deps.stripe) throw new Error('retry-stop: stripe not wired')
  const stripe = deps.stripe()
  if (invoiceId) {
    if (!stripe.invoices) throw new Error('retry-stop: stripe invoices not wired')
    const invoices = stripe.invoices
    const invoice = await lease.stripe('invoice', o => invoices.retrieve(invoiceId, {}, o))
    if (invoice.status === 'paid') return { paid: invoice, op }
    if (!doneInvoice(invoice.status)) {
      await intent(run, 'void', `void:${invoiceId}`)
      op = 'void'
      try {
        await lease.stripe('void', o => invoices.voidInvoice(invoiceId, {}, o))
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        const fresh = await lease.stripe('invoice', o => invoices.retrieve(invoiceId, {}, o))
        if (fresh.status === 'paid') return { paid: fresh, op }
        if (!doneInvoice(fresh.status)) throw err
      }
    }
  }
  if (subscriptionId) {
    if (!stripe.subscriptions) throw new Error('retry-stop: stripe subscriptions not wired')
    const subscriptions = stripe.subscriptions
    // A cancel another lease began: read the subscription first and continue from its state.
    const already = readCancel && doneSubscription((await lease.stripe('subscription', o => subscriptions.retrieve(subscriptionId, {}, o))).status)
    if (!already) {
      await intent(run, 'cancel', `cancel:${subscriptionId}`)
      op = 'cancel'
      try {
        await lease.stripe('cancel', o => subscriptions.cancel(subscriptionId, {}, o))
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        const fresh = await lease.stripe('subscription', o => subscriptions.retrieve(subscriptionId, {}, o))
        if (!doneSubscription(fresh.status)) throw err
      }
    }
  }
  return { op }
}

/**
 * Stop or tear down a sign-up: after its second failed build (T-3 step 6), or
 * after an unpaid first payment (23-37: declined, or a 3DS hold that ran out).
 * Nothing is charged or refunded. The steps, in order, each with its own done
 * flag: stopInvoice (unpaid only: void the invoice, cancel the unfinished
 * subscription), the code hold, the lock, the saved card, stopInvite (unpaid
 * only: reopen the invite), one mail, the server room, the organizer's AI key
 * (23-18), and stopApp (the app delete, last). A stop cut short (a throw, or
 * the function being stopped) finishes on the next trigger without repeating
 * a step. A step's error is raised and the record is not marked done; a
 * failed mail is the exception (it never blocks the delete, see runStop).
 *
 * Under the sign-up's lifecycle lock (23-43), shared with billing: while
 * another runner holds it, this returns { stopped: false } at once and calls
 * nothing. A caller that needs the outcome reads `stopped` or `tornDown` from
 * the state afterwards. { stopped: false } also means the void step found the
 * invoice paid and handed the sign-up back to billing: 23-32's paid path
 * (onPaid) then runs after the lease is released, and an outcome other than
 * done is logged as a fixed line (the sign-up waits in sweep:billing, so the
 * billing step takes it over).
 */
export async function stopProvision(sessionId: string, deps: RetryStopDeps): Promise<{ stopped: boolean }> {
  const { redis } = deps
  const key = stateKey(sessionId)
  const state = await redis.hgetall(key)
  if (!state || Object.keys(state).length === 0) return { stopped: false }
  // A provision with a subscription, or a complete one, has a live site and a customer: never stopped,
  // unless a guarded step already moved it to tearing_down (Task 6's refund case carries a subscription).
  if (!isTeardownStatus(state.status) && (state.subscriptionId || state.status === 'complete')) return { stopped: false }
  if (isTrue(state.stopped) || isTrue(state.tornDown)) return { stopped: true }

  // One runner at a time, billing included (23-43). Another runner holds it: that one finishes.
  const out = await withLifecycleLock(sessionId, { redis, tick: deps.tick, timers: deps.timers, log: deps.log }, lease => runStop(sessionId, deps, lease))
  if (out === 'busy' || out === 'lost') return { stopped: false }
  if ('handedBack' in out) {
    await afterHandBack(out.handedBack, deps)
    return { stopped: false }
  }
  return out
}

/** After the lease: 23-32's paid path (onPaid) activates a handed-back sign-up; anything but done is logged as a fixed line. */
export async function afterHandBack(provisionId: string | undefined, deps: RetryStopDeps): Promise<void> {
  if (!deps.onPaid || !provisionId) return
  try {
    const paid = await deps.onPaid(provisionId)
    if (paid === 'busy' || paid === 'lost' || paid === 'skipped') {
      deps.log?.(`retry-stop: paid hand-back not finished (${paid}), the billing step takes it over`)
    }
  } catch {
    deps.log?.('retry-stop: paid path not finished, the billing sweep resumes it')
  }
}

export type StopRunOutcome = { stopped: boolean } | { stopped: false, handedBack?: string } | { stopped: false, kept: true }

/**
 * A 3DS hold past its deadline, in the held step's lease (23-43 Task 2, point
 * 6: the held step decides under one lease). The void first, with its
 * intents; a void that finds the invoice paid hands the sign-up back from
 * held (Argon 1); a done void sets stopInvoice, then tearingDownHeldExpired,
 * then the rest of the teardown in the same lease (runStop). Nothing says
 * held_expired before the void is done, so a payment confirmed at the last
 * second never shows as expired.
 */
export async function expireHold(sessionId: string, deps: RetryStopDeps, lease: Lease): Promise<StopRunOutcome> {
  const state = await deps.redis.hgetall(stateKey(sessionId))
  if (!state || state.status !== 'held') return { stopped: false }
  const run: StopRun = { sid: sessionId, deps, lease, provisionId: str(state.provisionId) }
  const { readCancel } = await reconcileStop(run, state)
  if (!isTrue(state.stopInvoice)) {
    const voided = await voidAndCancel(run, state, readCancel)
    if (voided.paid) return handBackPaid(run, state, voided.paid, voided.op)
    if (!(await finish(run, voided.op, 'teardownStep', { flag: 'stopInvoice' }))) return { stopped: false }
  }
  if ((await step(run, 'tearingDownHeldExpired')).result === 'refused') return { stopped: false }
  return runStop(sessionId, deps, lease)
}

/**
 * The stop steps, run under the lifecycle lease (23-43 Task 2). The hash is
 * read again here: an earlier runner may have finished steps since.
 *
 * The status is the authority. The first write of a stop is its move to
 * tearing_down: at the start for a build that failed twice (from failed only,
 * with two failures and no money moved; a ready, paid or complete sign-up is
 * refused with nothing written, HIGH 3); right after a done void for a
 * declined payment (a paid invoice hands back instead, HIGH 8); a 3DS hold
 * that ran out arrives tearing_down from the held step (expireHold). Nothing
 * leaves tearing_down but torn_down. Two names, two facts: the flag tornDown
 * means every runner step ran; the status torn_down means the workflow
 * confirmed the app is gone (teardown-result deleted or gone). A record with
 * no address to delete goes straight to torn_down.
 *
 * An intent is written before each Stripe mutation, the mail and the
 * dispatch, and each result is applied only under this lease's token (D1).
 * The mail never stops the steps after it: a failed send is logged as a fixed
 * line, its flag stays unset, the capacity, AI key and app delete steps still
 * run, and the run then raises so the teardowns step retries the mail (the
 * sign-up stays in sweep:teardown until every step ran).
 */
export async function runStop(sessionId: string, deps: RetryStopDeps, lease: Lease): Promise<StopRunOutcome> {
  const { redis } = deps
  const key = stateKey(sessionId)
  const state = await redis.hgetall(key)
  if (!state || Object.keys(state).length === 0) return { stopped: false }
  const status = str(state.status)
  // refunded (23-43 Task 6) carries the subscription it has just cancelled; its gate is below.
  if (!isTeardownStatus(status) && status !== 'refunded' && (state.subscriptionId || status === 'complete')) return { stopped: false }
  if (isTrue(state.stopped) || isTrue(state.tornDown)) return { stopped: true }

  const provisionId = str(state.provisionId)
  const run: StopRun = { sid: sessionId, deps, lease, provisionId }
  const { readCancel } = await reconcileStop(run, state)
  const reason = str(state.teardownReason) || 'build_failed'
  // Orchestrator ruling (a) (23-43 Task 7): a zero invoice whose late activation landed before
  // the delete was asked for keeps its site. Checked here and before the card, the invite, the
  // Stopped mail and the delete; keepLateActivation's guards decide (fenced, this lease).
  const keptLate = async () => reason === 'activation_failed' && keepIfLateZero(redis as never, sessionId, lease, { now: nowOf(deps), log: deps.log })
  const KEPT = { stopped: false, kept: true } as const
  if (await keptLate()) return KEPT

  // The gate: the move to tearing_down is the stop's first write.
  if (status === 'failed') {
    if (reason !== 'build_failed') return { stopped: false }
    if ((await step(run, 'tearingDownBuildFailed')).result === 'refused') return { stopped: false }
  } else if (status === 'declined') {
    if (reason !== 'declined') return { stopped: false }
    // 0. The unpaid invoice and subscription (23-37), first: a paid invoice stops everything here.
    if (!isTrue(state.stopInvoice)) {
      const voided = await voidAndCancel(run, state, readCancel)
      if (voided.paid) return handBackPaid(run, state, voided.paid, voided.op)
      if (!(await finish(run, voided.op, 'teardownStep', { flag: 'stopInvoice' }))) return { stopped: false }
    }
    if ((await step(run, 'tearingDownDeclined')).result === 'refused') return { stopped: false }
  } else if (status === 'refunded') {
    // 23-43 Task 6: only after D2's refund (or a zero invoice) and the cancel; the step's guards decide.
    if (reason !== 'activation_failed') return { stopped: false }
    if ((await step(run, 'tearingDownActivationFailed')).result === 'refused') return { stopped: false }
  } else if (!isTeardownStatus(status)) {
    // ready, held, building, refunding and the rest: nothing a stop may touch.
    return { stopped: false }
  }

  await redis.set(stopKey(sessionId), String(nowOf(deps)), { nx: true, ex: PROVISION_TTL })
  const unpaid = isUnpaid(reason)
  // The invite reopens for "Try again" after an unpaid first payment and after a refund (23-43 Task 6).
  const reopens = unpaid || reason === 'activation_failed'
  const signup = (provisionId ? await redis.hgetall(`signup:${provisionId}`) : null) ?? {}

  // 1. The code hold (23-31 re-armed it for the build, 23-32 for the 3DS hold).
  if (!isTrue(state.stopHold)) {
    if (signup.promoId && signup.inviteId) await releaseHold(redis, String(signup.promoId), String(signup.inviteId))
    await done(run, 'stopHold')
  }
  // 2. The provisioning lock.
  if (!isTrue(state.stopLock)) {
    await redis.del(lockKey(sessionId))
    await done(run, 'stopLock')
  }
  // 3. The saved card: the SetupIntent's payment method, detached from the customer.
  if (await keptLate()) return KEPT
  if (!isTrue(state.stopCard)) {
    let op: IntentOp | null = null
    if (signup.setupIntentId) {
      if (!deps.stripe) throw new Error('retry-stop: stripe not wired')
      const stripe = deps.stripe()
      const setup = await lease.stripe('setup', o => stripe.setupIntents.retrieve(String(signup.setupIntentId), {}, o))
      const pm = setup.payment_method
      const pmId = typeof pm === 'string' ? pm : pm?.id
      if (pmId) {
        await intent(run, 'detach', `detach:${provisionId}`)
        op = 'detach'
        try {
          await lease.stripe('detach', o => stripe.paymentMethods.detach(pmId, {}, o))
        } catch (err) {
          if (err instanceof LeaseLostError) throw err
          if (!alreadyDetached(err)) throw err
        }
      }
    }
    await finish(run, op, 'teardownStep', { flag: 'stopCard' })
  }
  // 3b. The invite, reopened before the mail so its "Try again" works (unpaid, 23-37; a refund, 23-43 Task 6).
  if (await keptLate()) return KEPT
  if (reopens && !isTrue(state.stopInvite)) {
    if (!deps.inviteHashSecret) throw new Error('retry-stop: invite secret not wired')
    await reopenInvite(redis, deps.inviteHashSecret, signup, sessionId, deps.log)
    await done(run, 'stopInvite')
  }
  // 4. One mail, chosen by the reason, in its own step: a failure never blocks the steps after it.
  let mailFailed = false
  if (await keptLate()) return KEPT
  const mail = stopMailFor(reason, (await redis.hgetall(key)) ?? state)
  if (mail && !isTrue(state.stopMail)) {
    if (signup.email) {
      const config = deps.mail
      if (!config) throw new Error('retry-stop: mail not wired')
      const idempotencyKey = `${mail.prefix}-${provisionId}`
      await intent(run, 'mail', idempotencyKey)
      try {
        await lease.remote('mail', MAIL_TIMEOUT_MS, signal => sendCustomerMail(String(signup.email), mail.built, idempotencyKey, config, signal))
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        mailFailed = true
        deps.log?.('retry-stop: mail not sent, the teardowns step retries it')
      }
      if (!mailFailed) await result(run, 'mail', 'teardownStep', { flag: 'stopMail' })
    } else {
      await done(run, 'stopMail')
    }
  }
  // 5. The room this sign-up held on the server (23-17): it will not be built.
  if (!isTrue(state.stopCapacity)) {
    if (provisionId) await removeInflight(redis, provisionId)
    await done(run, 'stopCapacity')
  }
  // 6. The organizer's own AI key (23-18, D-21): the site will not be built, so it is forgotten.
  if (!isTrue(state.stopAiKey)) {
    if (provisionId) await deleteProvisionKey(redis, provisionId)
    await done(run, 'stopAiKey')
  }
  // 7. The app delete, last: after every reversible step and after the void (D-18 note).
  let noApp = false
  if (await keptLate()) return KEPT
  if (!isTrue(state.stopApp)) {
    if (!deps.teardown) throw new Error('retry-stop: teardown not wired')
    const subdomain = str(state.subdomain)
    if (subdomain && provisionId) {
      const dispatch = deps.teardown
      // C2: the dispatch intent is guarded (lifecycle.ts intent row): refused while a zero-charge
      // sign-up's late activation is recorded, even one that landed after the check above. Then
      // the site is kept here, in this lease; the delete is never asked for.
      // R2-2: notboth decides the first dispatch only; a retry of a recorded one (dispatchAskedAt, written
      // only by this row under the lease, never cleared) goes through, and the row checks the mark itself.
      const retry = Boolean(str((await redis.hgetall(key))?.dispatchAskedAt))
      const asked = await transition(redis, sessionId, 'intent', { provisionId, now: nowOf(deps), op: 'dispatch', key: `teardown:${provisionId}`, token: lease.token, retry }, lease)
      if (asked.result === 'refused') {
        if (await keptLate()) return KEPT
        deps.log?.('retry-stop: delete held, a late activation was seen; a person decides')
        return { stopped: false }
      }
      if (!isApplied(asked)) throw new LeaseLostError('dispatch')
      await lease.remote('dispatch', DISPATCH_TIMEOUT_MS, signal => dispatch({ subdomain, provisionId }, signal))
      await result(run, 'dispatch', 'teardownStep', { flag: 'stopApp', dispatchedAt: nowOf(deps) })
    } else {
      deps.log?.('retry-stop: no address to tear down')
      noApp = true
      await done(run, 'stopApp')
    }
  }
  if (mailFailed) throw new Error('retry-stop: mail not sent')

  // Every step ran: tornDown (and stopped for a build failure), lifetimes raised to 72 h, never lowered.
  await step(run, 'stopFinished', { reason, noApp, removedMailDue: noApp && reason === 'held_expired' })
  // The sweep owes it nothing more, unless the removed mail is still owed (compare-and-remove).
  await clearIndex(redis, sessionId, 'teardown')
  // D-18 note: the one log line with an id names the Coolify app the workflow was asked to delete.
  const app = state.appUuid ? String(state.appUuid) : 'none'
  deps.log?.(reason === 'build_failed'
    ? `retry-stop: stopped (build_failed); teardown requested for Coolify app ${app}`
    : `retry-stop: torn down (${reason}); teardown requested for Coolify app ${app}`)
  return { stopped: true }
}
