// The one place the routes build the first-payment and the stop dependencies
// (Phase 23, plans 23-32 and 23-37). The provision callback, the status read,
// the retry route and the QStash sweep all call makeBillingDeps and
// makeStopDeps, so Stripe, Redis, fetch, the callback secret, the
// mailer, the teardown dispatch and the hooks are wired the same way
// everywhere. The webhook also takes onRenewalProblem: the renewal card mail
// (billing-mail.ts, B-2's Phase 23 part). The price is not wired here: the
// subscription is started with the price frozen on the sign-up at checkout
// (23-43 Task 3, D3).
//
// 23-43: billing and the stop share one lifecycle lock, so every hook here
// runs after the lease that triggered it is released.
//
// 23-37: onDeclined runs the teardown (retry-stop.ts stopProvision) and every
// stop, whatever its trigger, can ask teardown-instance.yml to delete the app
// (github.ts dispatchTeardown, with the lease's abort signal; 23-36, D-18
// note). An invoice the teardown finds paid is handed back in one step (23-43
// handBack); onFirstInvoicePaid then makes the activation try.
//
// 23-43 Task 6: the refund (refund.ts) needs no wiring of its own. The QStash
// route's sweep deps carry both makeBillingDeps(config).deps (the real Stripe
// SDK, which has invoicePayments, refunds and subscriptions.cancel; the
// BillingStripe subset names them) and makeStopDeps(config) (the mailer and
// the app delete); cron-sweep.ts builds the refund deps from them
// (refundDepsOf). No status read or callback route ever reaches a refund.
//
// keepAlive (event.waitUntil plus Vercel's waitUntil) keeps the charge or the
// teardown alive after the reply. Without it (the sweep) the work is awaited.
import { nudgeBilling, onFirstInvoicePaid, startBilling, type BillingDeps, type BillingStripe, type InvoiceRouteDeps } from './billing'
import { sendRenewalMail } from './billing-mail'
import { stopProvision, type RetryStopDeps, type StopStripe } from './retry-stop'
import { dispatchTeardown } from './github'
import { sendHeldMail } from './teardown'
import type { PilotNoticeDeps, PilotNoticeStripe } from './pilot-end'

export interface BillingConfig {
  stripePriceId?: string
  provisionCallbackSecret?: string
  resendApiKey?: string
  mailFrom?: string
  inviteHashSecret?: string
}

type KeepAlive = (work: Promise<void>) => void

/**
 * A hook that runs one teardown step (stopProvision, or the held mail) for a
 * session id: through keepAlive when given, awaited otherwise. A throw is
 * logged as a fixed line and never raised: the QStash sweep finishes it.
 */
export function teardownHook(
  run: (sid: string) => Promise<unknown>,
  keepAlive?: KeepAlive,
  log: (msg: string) => void = msg => console.warn(msg)
): (sid: string) => Promise<void> {
  return async (sid: string) => {
    const work = run(sid)
      .then(() => undefined)
      .catch(() => log('teardown: not finished, the sweep resumes it'))
    if (keepAlive) keepAlive(work)
    else await work
  }
}

/**
 * The stop and teardown deps (retry-stop.ts): Redis, Stripe, the mailer, the
 * invite secret, the app delete and the paid path. Used by every route that
 * can start a stop, so a build-failure stop from any trigger asks for the
 * delete too.
 */
export function makeStopDeps(config: BillingConfig, keepAlive?: KeepAlive): RetryStopDeps {
  return {
    redis: useRedis(),
    // The SDK's own types are wider than the subset retry-stop.ts reads.
    stripe: () => useStripe() as unknown as StopStripe,
    mail: {
      apiKey: String(config.resendApiKey ?? ''),
      from: String(config.mailFrom ?? ''),
      fetch: (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1])
    },
    inviteHashSecret: String(config.inviteHashSecret ?? ''),
    teardown: dispatchTeardown,
    // Runs after the stop's lease is released (23-43): the outcome goes back to
    // stopProvision, which logs busy, lost or skipped as a fixed id-free line;
    // the sign-up already waits in sweep:billing, so the billing step takes it over.
    onPaid: provisionId => onFirstInvoicePaid(provisionId, makeBillingDeps(config).deps),
    keepAlive,
    log: msg => console.warn(msg)
  }
}

export function makeBillingDeps(config: BillingConfig, keepAlive?: KeepAlive) {
  const log = (msg: string) => console.warn(msg)
  const deps: BillingDeps = {
    redis: useRedis(),
    // The SDK's own types are wider than the subset billing.ts reads.
    stripe: () => useStripe() as unknown as BillingStripe,
    fetch: (url, init) => globalThis.fetch(url, init),
    callbackSecret: String(config.provisionCallbackSecret ?? ''),
    now: Date.now,
    sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
    log,
    // One "Confirm your payment" mail when the bank asks for confirmation (23-37), in the background.
    onHeld: teardownHook(sid => sendHeldMail(sid, makeStopDeps(config)), keepAlive, log),
    // A declined first payment is torn down at once (23-37), in the background.
    onDeclined: teardownHook(sid => stopProvision(sid, makeStopDeps(config)), keepAlive, log)
  }
  const onRenewalProblem: NonNullable<InvoiceRouteDeps['onRenewalProblem']> = (invoice, kind, createdSec) => sendRenewalMail(invoice, kind, createdSec, {
    redis: deps.redis,
    fetch: (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]),
    apiKey: String(config.resendApiKey ?? ''),
    from: String(config.mailFrom ?? ''),
    log
  }).then(() => undefined)
  return {
    deps,
    onRenewalProblem,
    start: (sid: string) => startBilling(sid, deps, keepAlive),
    nudge: (sid: string, provisionId?: string) => nudgeBilling(sid, provisionId, deps, keepAlive)
  }
}

/**
 * The free pilot's end notice (pilot-end.ts sweepPilotNotices), for the QStash
 * sweep only: Redis for the 6-hour gate, Stripe to list and mark the pilot
 * subscriptions, the mailer, and the invite secret that seals the continue
 * link. A missing mail setting or secret makes the step report unconfigured.
 */
export function makePilotNoticeDeps(config: BillingConfig): PilotNoticeDeps {
  return {
    redis: useRedis(),
    // Built on first use, so a missing Stripe key fails this step only, never
    // the sweep's setup. The SDK's own types are wider than the subset pilot-end.ts reads.
    stripe: {
      subscriptions: {
        list: params => (useStripe() as unknown as PilotNoticeStripe).subscriptions.list(params),
        update: (id, params, opts) => (useStripe() as unknown as PilotNoticeStripe).subscriptions.update(id, params, opts)
      }
    },
    fetch: (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1]),
    apiKey: String(config.resendApiKey ?? ''),
    from: String(config.mailFrom ?? ''),
    secret: String(config.inviteHashSecret ?? ''),
    now: Date.now,
    log: msg => console.warn(msg)
  }
}
