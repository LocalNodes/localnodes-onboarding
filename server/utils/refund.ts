// The automatic full refund (Phase 23, plan 23-43 Task 6). Plain module,
// everything injected, as billing.ts and retry-stop.ts: tests import it
// directly and the QStash route wires it through cron-sweep.ts.
//
// Tom's ruling (2026-11-09, ONB-02): a paid site that still can't be handed
// over after 24 hours is refunded in full automatically, its subscription
// cancelled, the site torn down, one email sent, and the case flagged so Tom
// sees every one.
//
// Review round 1 D2, the completion predicate, enforced here in code: a refund
// counts only when its status is succeeded, its amount equals the invoice's
// amount_paid, its currency equals the invoice's and its payment_intent is the
// one that paid the invoice. Only then are refundSucceededAt and refundId
// written (refundId also on dedupe:{provisionId}). A pending or
// requires_action refund keeps the sign-up refunding and the refunds step
// polls it (refunds.retrieve); every poll raises the record's keys to 72 h
// again, and one still pending 7 days after the refund started is flagged for
// a person (refund_problem:{sid}:pending) and still polled (code review fix
// round 1, C1). A failed or canceled refund, a succeeded one
// for less than amount_paid, another currency or payment, or two refunds for
// the payment: refundProblem, a reconcile:flags entry; no refunded state, no
// mail, no teardown, and never a second automatic refund. It leaves
// sweep:refund only once the cancel is done (R3-1, the rule: a sign-up never
// leaves every sweep while its Stripe subscription can still renew): until
// then each pass raises the record and retries the cancel, and nothing else.
// A first invoice of 0 (a 100%-off pilot) has nothing to refund: refundZero,
// no payment or refund call, and the approved Stopped mail (P5).
//
// The state table (Codex 3), each state with one sweep index kept by its
// transitions (lifecycle.ts):
//   ready, billing paid, past paidAt + 24 h   sweep:billing
//   refunding (any sub-step)                  sweep:refund
//   refunding, pending past 7 days            sweep:refund, and reconcile:flags
//   refunding with refundProblem              reconcile:flags (a person), and
//                                             sweep:refund until the cancel is
//                                             done, then none (R3-1)
//   refunded                                  sweep:refund, until the runner's
//                                             tearingDownActivationFailed step
//                                             moves it to sweep:teardown
//   tearing_down, activation_failed           sweep:teardown
//
// The steps, under the sign-up's one lifecycle lock (withLifecycleLock), each
// guarded by its done flag, with an intent record before each remote mutation:
//   1. one last activation try: 200 {activated: true} writes complete and
//      nothing is refunded; 409 {"error":"busy"} answers busy and the next run
//      decides; anything else goes on;
//   2. refunding (from ready; billing paid, never activated, the window
//      passed; fenced): teardownReason activation_failed, a refund_started
//      flag, into sweep:refund, out of sweep:billing;
//   3. the cancel, first (code review fix round 1, C1: when the refund
//      starts, not after it succeeds, so a slow refund cannot let the
//      subscription renew): subscriptions.cancel(subscriptionId, invoice_now
//      false, prorate false), with its intent; an already-canceled
//      subscription counts as done (refundCancelled). A cancel that fails
//      never blocks the refund (code review round 2, R2-1): the refund goes
//      on, the cancel is retried on every later pass, and one still not done
//      7 days after the refund started is flagged refund_problem:{sid}:cancel,
//      once. Every pass first raises the record's keys to 72 h (refundTick);
//   4. the refund (stopRefund): invoices.retrieve first; amount_paid 0 is
//      refundZero; else the paid invoice payment's payment_intent
//      (invoicePayments.list), refunds.list for it, and refunds.create with the
//      amount paid, metadata provision_id and the idempotency key
//      refund:{provisionId} only when no refund exists for it; the D2
//      predicate on whatever is found or made (refundDone);
//   5. refunded (both refundDone and refundCancelled);
//   6. the shared teardown runner (retry-stop.ts runStop) with reason
//      activation_failed in the same lease: tearing_down from refunded, then
//      the hold, lock, card, invite reopen, the one mail, capacity, AI key and
//      the app delete, which teardown-check's activation_failed row approves.
// An intent another lease left is reconciled by the step it names: a refund
// intent by listing first (the D2 predicate on what is there, a create with
// the same key only when nothing is), a cancel by reading the subscription
// after an error, an activate intent is cleared: no activation request is ever
// sent after the refunding step.
//
// Why only the QStash steps start or resume a refund: a status read runs in
// the organizer's browser session and may run often and in parallel; money
// leaving must come from one scheduled, signed place whose runs are counted
// and logged (the billing step starts it, the refunds step resumes it), never
// as a side effect of someone looking at a page.
//
// Privacy rule: log lines hold fixed words only; never a session, provision,
// refund, payment intent, subscription or invoice id, or an email.
import { activateSite, activationWindowPassed, noteLateActivation, type BillingDeps, type BillingStripe, type InvoiceLike } from './billing'
import { runStop, type RetryStopDeps } from './retry-stop'
import {
  LeaseLostError,
  REFUND_INDEX,
  applyResult,
  clearIndex,
  foreignIntent,
  isApplied,
  keepIfLateZero,
  transition,
  withLifecycleLock,
  writeIntent,
  type IntentOp,
  type Lease,
  type TransitionName,
  type TransitionParams,
  type TransitionResult
} from './lifecycle'
import type { SweepDeps } from './cron-sweep'

/** What a refund needs: the billing wiring (Stripe with its refund calls, the site's fetch) and the stop wiring (the runner's mailer and delete). One Redis. */
export interface RefundDeps {
  billing: BillingDeps
  stop: RetryStopDeps
}

export type RefundOutcome =
  /** The last activation try activated the site: complete, nothing refunded. Also a zero invoice kept live by a late activation (ruling (a)). */
  | 'activated'
  /** Another runner holds the lease, or the site answered 409 busy: the next run decides. */
  | 'busy'
  | 'lost'
  | 'skipped'
  /** A refund still pending at Stripe: the refunds step polls it. */
  | 'refunding'
  /** A refund problem: waits for a person. */
  | 'problem'
  /** Every runner step ran (the delete is asked for). */
  | 'torn_down'
  /** The runner has steps left: the teardowns step finishes them. */
  | 'tearing_down'

/** The one Stripe idempotency key of a sign-up's refund: never a try number (a retried create answers the same refund). */
export const refundKey = (provisionId: string) => `refund:${provisionId}`

/** Due members of sweep:refund read per QStash run. */
export const REFUND_SWEEP_LIMIT = 50
/** A pending refund is polled again a minute later. */
export const REFUND_POLL_MS = 60000

type State = Record<string, unknown>
type MaybeExpanded = string | { id?: string } | null | undefined

interface RefundLike {
  id?: string
  status?: string | null
  amount?: number | null
  currency?: string | null
  payment_intent?: MaybeExpanded
}

interface Run {
  sid: string
  deps: RefundDeps
  lease: Lease
  provisionId: string
}

const str = (value: unknown) => (value === null || value === undefined ? '' : String(value))
const num = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}
const isTrue = (value: unknown) => String(value) === 'true'
const idOf = (value: MaybeExpanded) => (typeof value === 'string' ? value : value?.id ?? '')
const isEmpty = (s: State | null): s is null => !s || Object.keys(s).length === 0
const nowOf = (run: Run) => (run.deps.billing.now ?? Date.now)()
const log = (run: Run, line: string) => run.deps.billing.log?.(line)
const readState = async (run: Run): Promise<State> => (await run.deps.billing.redis.hgetall(`provision:${run.sid}`)) ?? {}

/** A fenced write through a named transition. Lost: the run stops. Invalid: logged and raised. */
async function step(run: Run, name: TransitionName, params: TransitionParams = {}): Promise<TransitionResult> {
  const out = await transition(run.deps.billing.redis, run.sid, name, { provisionId: run.provisionId || undefined, now: nowOf(run), ...params }, run.lease)
  if (out.result === 'lost') throw new LeaseLostError(name)
  if (out.result === 'invalid') {
    log(run, `lifecycle: ${name} could not apply (${out.why})`)
    throw new Error(`refund: ${name} could not apply (invalid)`)
  }
  return out
}

async function intent(run: Run, op: IntentOp, key: string): Promise<void> {
  await writeIntent(run.deps.billing.redis, run.sid, run.lease, op, key, { provisionId: run.provisionId || undefined, now: nowOf(run) })
}

/** A remote call's result, applied only while the intent is this lease's; a stale one ends the run as lost. */
async function result(run: Run, op: IntentOp, name: TransitionName, params: TransitionParams = {}): Promise<void> {
  const out = await applyResult(run.deps.billing.redis, run.sid, run.lease, op, name, { provisionId: run.provisionId || undefined, now: nowOf(run), ...params }, run.deps.billing.log)
  if (out === 'dropped') throw new LeaseLostError(op)
}

/** After a remote call made under an intent, its result; after one made without (a read), a plain step that clears any intent. */
async function finish(run: Run, op: IntentOp | null, name: TransitionName, params: TransitionParams = {}): Promise<boolean> {
  if (op) {
    await result(run, op, name, params)
    return true
  }
  return isApplied(await step(run, name, { ...params, clearIntent: true }))
}

/** The Stripe calls a refund makes, all present (the real SDK has them; a double that lacks one fails closed). */
function refundStripe(run: Run): Required<Pick<BillingStripe, 'invoicePayments' | 'refunds'>> & BillingStripe & { subscriptions: Required<BillingStripe['subscriptions']> } {
  const stripe = run.deps.billing.stripe()
  if (!stripe.invoicePayments || !stripe.refunds || !stripe.subscriptions.cancel) throw new Error('refund: stripe not wired')
  return stripe as ReturnType<typeof refundStripe>
}

/** Past the window, paid, never activated, and not waiting for a person: a refund case (the billing step's test). */
export function refundOwed(state: State, now: number): boolean {
  return state.status === 'ready' && state.billing === 'paid' && !str(state.activatedAt) && activationWindowPassed(state, now)
}

/** Clear an intent another lease left (D1). Its op's own step reconciles below (the list before a create, the read after a cancel error). */
async function clearForeign(run: Run, state: State): Promise<void> {
  const found = foreignIntent(state, run.lease)
  if (!found) return
  log(run, `refund: reconciling an unfinished ${['activate', 'refund', 'cancel', 'mail', 'dispatch', 'detach'].includes(found.op) ? found.op : 'step'}`)
  await step(run, 'clearIntent', { token: found.token })
}

type Refunded = 'done' | 'refunding' | 'problem'

/**
 * A refund problem (D2): flagged for a person; no refund call, mail or teardown happens automatically
 * after it. It leaves sweep:refund at once when the cancel is already done (refundProblemSettled,
 * refused otherwise); if not, continueRefund's cancel-only passes keep it there (R3-1).
 */
async function problem(run: Run, op: IntentOp | null, kind: string, refundId?: string): Promise<Refunded> {
  log(run, `refund: not finished in full (${kind}); flagged for a person`)
  await finish(run, op, 'refundProblem', { kind, refundId: refundId || undefined })
  await step(run, 'refundProblemSettled')
  return 'problem'
}

/**
 * The D2 predicate on one refund: succeeded, for exactly the amount paid, in
 * the invoice's currency, on this payment. Pending or requires_action (with
 * the right amount, currency and payment) is polled; anything else is a
 * problem.
 */
async function judge(run: Run, op: IntentOp | null, refund: RefundLike, expected: { amount: number, currency: string, paymentIntent: string }): Promise<Refunded> {
  const id = str(refund.id)
  if (idOf(refund.payment_intent) !== expected.paymentIntent || str(refund.currency).toLowerCase() !== expected.currency.toLowerCase()) {
    return problem(run, op, 'mismatch', id)
  }
  if (refund.amount !== expected.amount) return problem(run, op, 'partial', id)
  if (refund.status === 'succeeded') {
    await finish(run, op, 'refundSucceeded', { refundId: id })
    log(run, 'refund: refunded in full')
    return 'done'
  }
  if (refund.status === 'pending' || refund.status === 'requires_action') {
    await finish(run, op, 'refundPending', { refundId: id, refundStatus: str(refund.status), due: nowOf(run) + REFUND_POLL_MS })
    log(run, 'refund: pending at Stripe, polled again')
    // C1: still pending REFUND_PENDING_LIMIT_MS (7 days) after the refund started: flagged for a
    // person, once. The row's guards are the only check (the time and the once); refused is the
    // usual answer. It stays refunding and is still polled.
    if ((await step(run, 'refundPendingStale')).result === 'applied') log(run, 'refund: still pending after 7 days; flagged for a person')
    return 'refunding'
  }
  return problem(run, op, str(refund.status) || 'unknown', id)
}

/**
 * Step 3 (stopRefund): the invoice first (Argon 3), then, for a non-zero
 * invoice, the paid payment's payment_intent, the refunds already made for it,
 * and one create only when there are none. A pending refund stored earlier is
 * polled with refunds.retrieve. A Stripe error is raised: the sign-up stays
 * refunding in sweep:refund and the next refunds step lists before it creates.
 */
async function stopRefund(run: Run, state: State): Promise<Refunded> {
  const stripe = refundStripe(run)
  const { lease } = run
  let invoiceId = str(state.invoiceId)
  if (!invoiceId) {
    // A record without the paid step's invoice data recovers it from the subscription (Codex 3).
    const subscriptionId = str(state.subscriptionId)
    if (!subscriptionId) return problem(run, null, 'no_invoice')
    const sub = await lease.stripe('subscription', o => stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] }, o))
    invoiceId = idOf(sub.latest_invoice as MaybeExpanded)
    if (!invoiceId) return problem(run, null, 'no_invoice')
  }
  const invoice: InvoiceLike = await lease.stripe('invoice', o => stripe.invoices.retrieve(invoiceId, {}, o))
  const amount = invoice.amount_paid
  const currency = str(invoice.currency)
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0 || !currency) return problem(run, null, 'no_amount')
  if (str(state.invoiceId) !== invoiceId || num(state.amountPaid) !== amount || str(state.currency) !== currency) {
    await step(run, 'refundInvoice', { invoiceId, amountPaid: amount, currency })
  }
  // A zero invoice: nothing was captured, so nothing is refunded and no payment or refund call is made.
  if (amount === 0) {
    await step(run, 'refundZero', { clearIntent: true })
    log(run, 'refund: nothing was charged, nothing to refund')
    return 'done'
  }
  const payments = await lease.stripe('payments', o => stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid' }, o))
  const intents = [...new Set(payments.data
    .filter(p => p.status === 'paid' && p.payment?.type === 'payment_intent')
    .map(p => idOf(p.payment?.payment_intent as MaybeExpanded))
    .filter(Boolean))]
  if (intents.length !== 1) return problem(run, null, 'payment')
  const expected = { amount, currency, paymentIntent: intents[0]! }

  // A refund pending earlier: poll it.
  const pendingId = str(state.refundId)
  if (pendingId) {
    const polled = await lease.stripe('refund', o => stripe.refunds.retrieve(pendingId, {}, o))
    return judge(run, null, polled, expected)
  }
  const listed = await lease.stripe('refunds', o => stripe.refunds.list({ payment_intent: expected.paymentIntent }, o))
  if (listed.data.length > 1) return problem(run, null, 'multiple')
  if (listed.data.length === 1) return judge(run, null, listed.data[0]!, expected)
  const key = refundKey(run.provisionId)
  await intent(run, 'refund', key)
  const made = await lease.stripe('refund', o => stripe.refunds.create({
    payment_intent: expected.paymentIntent,
    amount,
    metadata: { provision_id: run.provisionId }
  }, { idempotencyKey: key, ...o }))
  return judge(run, 'refund', made, expected)
}

/** Step 3 (C1: at the refund start): cancel the subscription now, with no new invoice and no proration; an already-canceled one is done. */
async function stopSubscription(run: Run, state: State): Promise<void> {
  const subscriptionId = str(state.subscriptionId)
  if (!subscriptionId) {
    await step(run, 'refundCancelled', { clearIntent: true })
    return
  }
  const stripe = refundStripe(run)
  await intent(run, 'cancel', `cancel:${subscriptionId}`)
  try {
    await run.lease.stripe('cancel', o => stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false }, o))
  } catch (err) {
    if (err instanceof LeaseLostError) throw err
    const fresh = await run.lease.stripe('subscription', o => stripe.subscriptions.retrieve(subscriptionId, { expand: [] }, o))
    if (fresh.status !== 'canceled' && fresh.status !== 'incomplete_expired') throw err
  }
  await result(run, 'cancel', 'refundCancelled')
}

/**
 * Orchestrator ruling (a): a zero invoice whose late activation landed before
 * the delete was asked for keeps its site (keepLateActivation, fenced, in this
 * lease). Checked before the cancel, before the refund and before the refunded
 * step; runStop
 * checks again before its card, invite, mail and delete steps.
 */
const keptLate = (run: Run) => keepIfLateZero(run.deps.billing.redis as never, run.sid, run.lease, { now: nowOf(run), log: run.deps.billing.log })

/**
 * The first write of every refund-runner pass, before any remote call (R2-1): the record's three
 * keys raised to 72 h. R3-2: the same write moves the sign-up to the back of sweep:refund (due
 * now), so the refunds step, which reads the oldest due members up to REFUND_SWEEP_LIMIT, reaches
 * every member in turn however many are stuck. A later step of the pass may set its own due time.
 * A settled refund problem has left the sweep and is only raised.
 */
async function tick(run: Run, state: State): Promise<void> {
  if (!str(state.refundSettledAt) && (await step(run, 'refundTick', { due: nowOf(run) })).result !== 'refused') return
  await step(run, 'refundTick')
}

/**
 * R3-1: one pass over a refund problem. The refund waits for a person, so this never calls the
 * refund again, never mails and never tears down. It only finishes the cancel: retried on every
 * pass (the pass's refundTick has already raised the record), and once it is recorded done the
 * sign-up leaves sweep:refund (refundProblemSettled). The rule: a sign-up never leaves every
 * sweep while its Stripe subscription can still renew.
 */
async function problemPass(run: Run, state: State): Promise<RefundOutcome> {
  if (str(state.refundSettledAt)) return 'problem'
  if (!isTrue(state.refundCancelled)) {
    try {
      await stopSubscription(run, state)
    } catch (err) {
      if (err instanceof LeaseLostError) throw err
      log(run, 'refund: the cancel did not go through; it is retried while the refund waits for a person')
      // Raised at once when the refund became a problem; this covers a record that missed that write.
      await step(run, 'refundCancelStale', { problem: true })
      return 'problem'
    }
  }
  if ((await step(run, 'refundProblemSettled')).result === 'applied') log(run, 'refund: the subscription is cancelled; the refund still waits for a person')
  return 'problem'
}

/**
 * Steps 3 to 6, from wherever the record is (each guarded by its done flag).
 * Code review fix round 1, C1: the cancel runs first, when the refund starts,
 * and the refund after it, so a refund that stays pending at Stripe for days
 * can never let the subscription renew.
 */
async function continueRefund(run: Run): Promise<RefundOutcome> {
  // R2-1: the pass's first write raises the record's three keys to 72 h, before any remote call.
  let state = await readState(run)
  await tick(run, state)
  if (state.status === 'refunding') {
    if (str(state.refundProblem)) return problemPass(run, state)
    if (await keptLate(run)) return 'activated'
    let cancelPending = false
    if (!isTrue(state.refundCancelled)) {
      // R2-1: a cancel that fails never blocks the refund. It is retried on every later pass, and
      // one still not done 7 days after the refund started is flagged for a person, once.
      try {
        await stopSubscription(run, state)
      } catch (err) {
        if (err instanceof LeaseLostError) throw err
        cancelPending = true
        log(run, 'refund: the cancel did not go through; the refund goes on and the cancel is retried')
        if ((await step(run, 'refundCancelStale')).result === 'applied') log(run, 'refund: the cancel is still not done after 7 days; flagged for a person')
      }
      state = await readState(run)
    }
    if (await keptLate(run)) return 'activated'
    if (!isTrue(state.refundDone)) {
      const refunded = await stopRefund(run, state)
      if (refunded === 'problem' && !isTrue((await readState(run)).refundCancelled)) {
        // The refund needs a person and the cancel is not done: say so on the same entry list.
        await step(run, 'refundCancelStale', { problem: true })
      }
      if (refunded !== 'done') return refunded
      state = await readState(run)
    }
    // Refunded only once both are done (the refunded row's guards say the same).
    if (cancelPending || !isTrue(state.refundCancelled)) return 'refunding'
    if (await keptLate(run)) return 'activated'
    if ((await step(run, 'refunded')).result === 'refused') return 'skipped'
    log(run, 'refund: refunded; the teardown follows')
    state = await readState(run)
  }
  if (state.status === 'refunded') {
    // Step 6: the shared runner, in this same lease (its first write moves refunded to tearing_down).
    const out = await runStop(run.sid, run.deps.stop, run.lease)
    if ('kept' in out && out.kept) return 'activated'
    if ('handedBack' in out) return 'skipped'
    return out.stopped ? 'torn_down' : 'tearing_down'
  }
  return 'skipped'
}

const lockDeps = (deps: RefundDeps) => ({ redis: deps.billing.redis, tick: deps.billing.tick, timers: deps.billing.timers, log: deps.billing.log })

/**
 * The QStash billing step's start of a refund (sweepBilling), under the
 * lifecycle lock: one last activation try, then the refunding step, then
 * steps 3 to 6. Only for a sign-up still ready, paid, never activated and past
 * its 24 hour window; anything else is skipped with nothing written.
 */
export async function refundAndTearDown(sid: string, deps: RefundDeps): Promise<RefundOutcome> {
  const out = await withLifecycleLock(sid, lockDeps(deps), async (lease) => {
    const run: Run = { sid, deps, lease, provisionId: '' }
    const state = await readState(run)
    if (isEmpty(state)) return 'skipped' as const
    run.provisionId = str(state.provisionId)
    if (state.status === 'refunding' || state.status === 'refunded') {
      await clearForeign(run, state)
      return continueRefund(run)
    }
    if (!refundOwed(state, nowOf(run))) return 'skipped' as const
    await clearForeign(run, state)

    // 1. One last activation try.
    await intent(run, 'activate', `activate:${run.provisionId}`)
    run.lease.beforeRemote('activate')
    const tried = await activateSite(state, run.deps.billing)
    if (tried === 'activated') {
      // Code review fix round 1, C4: a 200 whose fenced complete is dropped (the lease was lost and
      // another runner may have started the refund) is still recorded, as billing.ts records its own:
      // lateActivation and the late_activation flag, so a free site can still be kept (ruling (a))
      // and a paid one gets the refunded-only wording. Then the run ends as lost.
      const applied = await applyResult(run.deps.billing.redis, run.sid, run.lease, 'activate', 'complete', { provisionId: run.provisionId || undefined, now: nowOf(run) }, run.deps.billing.log)
      if (applied === 'dropped') {
        await noteLateActivation(run.deps.billing.redis, run.sid, run.provisionId, nowOf(run), run.deps.billing.log)
        throw new LeaseLostError('activate')
      }
      log(run, 'refund: the site activated on the last try; nothing refunded')
      return 'activated' as const
    }
    if (tried === 'busy') {
      // Another activate call is running on the site: the next run decides.
      await result(run, 'activate', 'clearIntent', { token: run.lease.token })
      return 'busy' as const
    }

    // 2. refunding (fenced; the row's guards are the authority on the window and the payment).
    await result(run, 'activate', 'refunding')
    log(run, 'refund: a paid site was not handed over in 24 hours; refund started and flagged for a person')
    return continueRefund(run)
  })
  return out
}

/** The refunds step's resume for one member of sweep:refund, under the lifecycle lock. Never starts a refund. */
export async function resumeRefund(sid: string, deps: RefundDeps): Promise<RefundOutcome> {
  return withLifecycleLock(sid, lockDeps(deps), async (lease) => {
    const run: Run = { sid, deps, lease, provisionId: '' }
    const state = await readState(run)
    if (isEmpty(state) || (state.status !== 'refunding' && state.status !== 'refunded')) return 'skipped' as const
    run.provisionId = str(state.provisionId)
    // R2-1: raised before anything else in the pass, the foreign intent's clean-up included.
    await tick(run, state)
    await clearForeign(run, state)
    return continueRefund(run)
  })
}

export interface RefundCounts {
  due: number
  refunded: number
  pending: number
  problems: number
  tornDown: number
  busy: number
  cleared: number
  errors: number
  /** R3-2: due members this run did not read (more than REFUND_SWEEP_LIMIT were due). 0 on a normal run; a person watches for it staying above 0. */
  waiting: number
}

/** The refund wiring from the sweep's deps: the billing deps and the stop deps (awaited, no keepAlive). None without billing. */
export function refundDepsOf(deps: SweepDeps): RefundDeps | undefined {
  if (!deps.billing) return undefined
  return { billing: deps.billing, stop: { ...deps, keepAlive: undefined } }
}

/**
 * The QStash refunds step (fourth in CRON_STEPS): one bounded read of the due
 * members of sweep:refund (at most 50, oldest first; a served member moves to
 * the back, R3-2), each resumed in its own try/catch. A
 * member whose record no longer needs the index leaves it through
 * CLEAR_INDEX_SCRIPT (compare-and-remove). Counts only in its log line.
 */
export async function sweepRefunds(deps: SweepDeps): Promise<RefundCounts> {
  const { redis } = deps
  const now = (deps.now ?? Date.now)()
  const counts: RefundCounts = { due: 0, refunded: 0, pending: 0, problems: 0, tornDown: 0, busy: 0, cleared: 0, errors: 0, waiting: 0 }
  const members = (await redis.zrange(REFUND_INDEX, '-inf', now, { byScore: true, offset: 0, count: REFUND_SWEEP_LIMIT })).map(String)
  counts.due = members.length
  // R3-2: a full read may have left due members behind; they come first on the next run (refundTick moves the served ones back).
  if (members.length >= REFUND_SWEEP_LIMIT) counts.waiting = Math.max(0, (await redis.zcount(REFUND_INDEX, '-inf', now)) - members.length)
  const refund = refundDepsOf(deps)
  for (const sid of members) {
    try {
      const state = await redis.hgetall(`provision:${sid}`)
      // R3-1: a refund problem stays a member until its cancel is done (refundSettledAt).
      if (isEmpty(state) || (state.status !== 'refunding' && state.status !== 'refunded') || str(state.refundSettledAt)) {
        if (await clearIndex(redis, sid, 'refund')) counts.cleared++
        continue
      }
      if (!refund) throw new Error('refund: not wired')
      const out = await resumeRefund(sid, refund)
      if (out === 'torn_down' || out === 'tearing_down') {
        counts.refunded++
        if (out === 'torn_down') counts.tornDown++
      } else if (out === 'refunding') counts.pending++
      else if (out === 'problem') counts.problems++
      else if (out === 'busy' || out === 'lost') counts.busy++
    } catch {
      counts.errors++
    }
  }
  return counts
}
