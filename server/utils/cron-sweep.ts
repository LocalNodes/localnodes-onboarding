// The QStash-signed sweep (Phase 23, plan 23-38; ONB-02, D-15, D-16 as
// superseded by T-3, D-17, D-18). Plain module, no Nitro globals: the clients
// come from a factory the route passes in, so tests import it directly.
//
// Upstash QStash posts to /api/cron/sweep every 5 minutes (the schedule is a
// one-time runbook step, 23-21, never created from code). The call runs only on
// a valid Upstash-Signature: @upstash/qstash's own Receiver, built with
// devMode false and the two configured signing keys, checks it against the raw
// body and the configured URL. Three package behaviours (2.12.1) decide the
// details:
//   - with devMode unset, QSTASH_DEV=true in the environment switches it to the
//     SDK's public dev keys, so devMode is always false here;
//   - with an empty key it falls back to the process environment, including
//     per-region keys picked by a request header, so empty keys are refused
//     before the Receiver is built;
//   - with no url it skips the URL check, so an empty URL is refused and the URL
//     is always passed.
// The package's h3 and nuxt helper entries are not used: in 2.12.1 they pass no
// url and hash JSON.stringify of the body.
//
// The sweep settles every sign-up whose site-failure window has passed (the
// same settleProvisional the status read runs) and finishes a stop that no one
// else will finish. Work is found through one sorted set, sweep:stops, read
// with one bounded ZRANGE BYSCORE LIMIT 0 50 per run, oldest first; a member
// leaves only when it owes nothing. A run cut short is safe: every per-record
// action is exclusive or idempotent (per-attempt SET NX, the stop lock, the
// done flags, Resend's Idempotency-Key), and the next tick finishes the rest.
//
// Privacy rule: log lines and the reply hold counts and fixed words only, never
// an address, a session id, a provision id or a signature error message (it
// echoes the token's subject and body hash). The stop's own D-18 line naming
// the Coolify app for Tom is the one line that carries an id.
//
// The steps, in order, all on this one signed route (one auth path, one
// schedule, one place to monitor; decided in 23-38, ruled for the 3DS sweep on
// 2026-11-08 afternoon):
//   1. stops (23-38): site failures past their window, and stops cut short;
//   2. held (23-37, server/utils/teardown.ts sweepHeld): the 3DS holds over
//      sweep:held (scored by heldUntil): a missing "Confirm your payment" mail
//      is sent, and past heldUntil the invoice decides: paid hands the site
//      over, unpaid tears it down (teardownReason held_expired);
//   3. billing (23-32, server/utils/billing.ts sweepBilling): the first
//      payment and the activation still owed, over sweep:billing; a paid site
//      never activated 24 hours after paidAt starts the automatic full refund
//      (23-43 Task 6, refund.ts refundAndTearDown);
//   4. refunds (23-43 Task 6, refund.ts sweepRefunds): every refund in flight
//      over sweep:refund, resumed from its done flags (a pending refund polled,
//      a refunded sign-up handed to the teardown runner);
//   5. teardowns (23-37, sweepTeardowns): any teardown cut short, over
//      sweep:teardown (an unpaid first payment, a build that failed twice, a
//      refund case).
// No Vercel cron and no second schedule.
import { Receiver } from '@upstash/qstash'
import { sweepBilling, type BillingDeps } from './billing'
import { sweepHeld, sweepTeardowns } from './teardown'
import { refundDepsOf, sweepRefunds } from './refund'
import { clearIndex } from './lifecycle'
import { sweepPilotNotices, type PilotNoticeDeps } from './pilot-end'
import {
  MAX_FAILURES,
  STOPS_INDEX,
  settleProvisional,
  stopProvision,
  type RetryStopDeps,
  type RetryStopRedis
} from './retry-stop'

/** Due members read per run. */
export const SWEEP_LIMIT = 50

/** The Redis calls the sweep makes: the stop's, plus a bounded read by score. */
export interface SweepRedis extends RetryStopRedis {
  zrange: (
    key: string,
    min: number | '-inf' | '+inf',
    max: number | '-inf' | '+inf',
    opts: { byScore: true, offset: number, count: number }
  ) => Promise<unknown[]>
  /** R3-2: how many members are due, for the refunds step's waiting count. */
  zcount: (key: string, min: number | '-inf' | '+inf', max: number | '-inf' | '+inf') => Promise<number>
}

export type SweepDeps = Omit<RetryStopDeps, 'redis' | 'keepAlive'> & {
  redis: SweepRedis
  /** The first-payment wiring (makeBillingDeps(config).deps, no keepAlive: the sweep awaits). 23-32. */
  billing?: BillingDeps
  /** The free pilot's end notice (makePilotNoticeDeps(config)). Absent: the step reports skipped. */
  pilot?: PilotNoticeDeps
}

export interface StopsCounts {
  due: number
  settled: number
  stopped: number
  cleared: number
  busy: number
  errors: number
}

export type StepResult = Record<string, unknown> | { error: true }

export interface CronStep {
  name: string
  run: (deps: SweepDeps) => Promise<Record<string, unknown>>
}

const isTrue = (value: unknown) => String(value) === 'true'
const num = (value: unknown, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const isEmpty = (state: Record<string, unknown> | null): state is null =>
  !state || Object.keys(state).length === 0

/**
 * Settle and stop every due member of sweep:stops, at most SWEEP_LIMIT per run.
 * Each record is handled on its own: a throw counts in errors and leaves the
 * member for the next run.
 */
export async function sweepStops(deps: SweepDeps): Promise<StopsCounts> {
  const { redis } = deps
  const now = (deps.now ?? Date.now)()
  // The stop is awaited here (no keepAlive): the sweep is the background.
  const stopDeps: RetryStopDeps = { ...deps, keepAlive: undefined }
  const counts: StopsCounts = { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 }

  const members = (await redis.zrange(STOPS_INDEX, '-inf', now, { byScore: true, offset: 0, count: SWEEP_LIMIT })).map(String)
  counts.due = members.length

  for (const sid of members) {
    try {
      const key = `provision:${sid}`
      // Compare-and-remove (Codex 6, 23-43): the member leaves only while its
      // record owes the stops step nothing (lifecycle.ts INDEX_RULES.stops).
      const clear = async () => {
        if (await clearIndex(redis, sid, 'stops')) counts.cleared++
      }

      // 1. Owes nothing: gone, already stopped, a live customer, or no longer failed (23-43 Task 2:
      //    ready, held, declined, complete and the server-only states are never counted as a failure;
      //    a stop under way moved its sign-up to sweep:teardown).
      const state = await redis.hgetall(key)
      if (isEmpty(state) || isTrue(state.stopped) || state.subscriptionId || state.status !== 'failed') {
        await clear()
        continue
      }

      // 2. The window has passed: count the failure, as the status read does.
      //    At the second failure this runs the stop too.
      const settledNow = await settleProvisional(sid, state, stopDeps)
      if (settledNow) counts.settled++

      // 3. Two failures and not stopped, with no stop run just now: a stop
      //    that was cut short, or one that no other trigger will run.
      if (!settledNow) {
        const current = await redis.hgetall(key)
        if (!isEmpty(current) && num(current.failedAttempts) >= MAX_FAILURES && !isTrue(current.stopped)) {
          const outcome = await stopProvision(sid, stopDeps)
          if (!outcome.stopped) counts.busy++
        }
      }

      // 4. Leave the set only when nothing is owed.
      const after = await redis.hgetall(key)
      if (isEmpty(after)) {
        await clear()
      } else if (isTrue(after.stopped)) {
        counts.stopped++
        await clear()
      } else if (num(after.failedAttempts) < MAX_FAILURES && num(after.provisionalUntil) <= 0) {
        // Settled to the free retry, or a complete cleared the window.
        await clear()
      }
    } catch {
      counts.errors++
    }
  }
  return counts
}

/**
 * The sweep's steps, in order: stops, held (23-37), billing (23-32), refunds
 * (23-43 Task 6), teardowns (23-37), pilotNotice (the free pilot's end mail,
 * pilot-end.ts; it runs at most once per 6 hours behind its own Redis gate).
 */
export const CRON_STEPS: CronStep[] = [
  { name: 'stops', run: deps => sweepStops(deps) as unknown as Promise<Record<string, unknown>> },
  { name: 'held', run: deps => sweepHeld(deps) as unknown as Promise<Record<string, unknown>> },
  { name: 'billing', run: deps => sweepBilling({ ...deps, refund: refundDepsOf(deps) }) as unknown as Promise<Record<string, unknown>> },
  { name: 'refunds', run: deps => sweepRefunds(deps) as unknown as Promise<Record<string, unknown>> },
  { name: 'teardowns', run: deps => sweepTeardowns(deps) as unknown as Promise<Record<string, unknown>> },
  { name: 'pilotNotice', run: async deps => deps.pilot ? sweepPilotNotices(deps.pilot) as unknown as Promise<Record<string, unknown>> : { skipped: true } }
]

/** Run each step in turn. A step that throws as a whole reports { error: true }, and the next still runs. */
export async function runCronSteps(deps: SweepDeps, steps: CronStep[] = CRON_STEPS): Promise<Record<string, StepResult>> {
  const results: Record<string, StepResult> = {}
  for (const step of steps) {
    try {
      results[step.name] = await step.run(deps)
    } catch {
      results[step.name] = { error: true }
    }
  }
  return results
}

export interface CronSweepRequest {
  /** The Upstash-Signature header. */
  signature?: string
  /** The raw body, byte for byte as received. */
  body?: string
  /** runtimeConfig cronSweepUrl: the schedule's destination, byte for byte. Never derived from the request. */
  url: string
  currentSigningKey: string
  nextSigningKey: string
}

export type CronSweepOutcome =
  | { status: 401, body: { message: 'Unauthorized' } }
  | { status: 200 | 503, body: { ok: boolean, steps: Record<string, StepResult> } }

const UNAUTHORIZED = { status: 401 as const, body: { message: 'Unauthorized' as const } }

/** Counts only, for example "cron-sweep: stops due=3 settled=1 stopped=1 cleared=2 busy=0 errors=0". */
function countLine(name: string, result: StepResult): string {
  const parts = Object.entries(result)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? String(v) : v}`)
  return `cron-sweep: ${name} ${parts.join(' ')}`.trimEnd()
}

/**
 * POST /api/cron/sweep. The signature is checked before any client is built:
 * makeDeps (Redis, Stripe, the mailer) runs only after verify passes.
 */
export async function handleCronSweep(
  req: CronSweepRequest,
  makeDeps: () => SweepDeps,
  opts: { log?: (msg: string) => void, steps?: CronStep[] } = {}
): Promise<CronSweepOutcome> {
  const log = opts.log ?? ((msg: string) => console.warn(msg))

  // Fail closed, with no network and no Receiver: an empty key would make the
  // package fall back to the environment, and an empty URL skips its URL check.
  if (!req.url || !req.currentSigningKey || !req.nextSigningKey) {
    log('cron-sweep: not configured')
    return UNAUTHORIZED
  }
  if (!req.signature) {
    log('cron-sweep: signature rejected')
    return UNAUTHORIZED
  }

  let verified = false
  try {
    const receiver = new Receiver({
      currentSigningKey: req.currentSigningKey,
      nextSigningKey: req.nextSigningKey,
      devMode: false
    })
    verified = (await receiver.verify({ signature: req.signature, body: req.body ?? '', url: req.url })) === true
  } catch {
    // The message echoes the token's subject and body hash: never logged or returned.
    verified = false
  }
  if (!verified) {
    log('cron-sweep: signature rejected')
    return UNAUTHORIZED
  }

  let deps: SweepDeps
  try {
    deps = makeDeps()
  } catch {
    log('cron-sweep: setup failed')
    return { status: 503, body: { ok: false, steps: {} } }
  }

  const steps = await runCronSteps(deps, opts.steps ?? CRON_STEPS)
  for (const [name, result] of Object.entries(steps)) log(countLine(name, result))
  const failed = Object.values(steps).some(r => (r as { error?: unknown }).error === true)
  return { status: failed ? 503 : 200, body: { ok: !failed, steps } }
}
