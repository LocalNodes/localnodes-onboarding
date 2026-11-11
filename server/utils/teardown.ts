// Undoing a first payment that did not happen (Phase 23, plan 23-37; Tom's
// billing rule B-1 steps 4, 5 and 7, his answers 2 and 3, and the D-18 note).
// Plain module, no Nitro globals: Redis, Stripe, the mailer and the clock are
// injected, as in retry-stop.ts, so tests import it directly and the routes
// only wire it up.
//
// The teardown itself is retry-stop.ts stopProvision, the one runner for a
// build that failed twice, a declined first payment and a 3DS hold that ran
// out. This file holds what sits around it:
//   - the two routes 23-36's teardown-instance.yml calls with the
//     per-provision bearer: GET /api/teardown-check (its only go-ahead: yes
//     only for status tearing_down plus its reason's conditions, 23-43) and
//     POST /api/teardown-result (deleted or gone makes it torn_down; refused
//     or failed is flagged for a person);
//   - reopenInvite (kept in invites.ts, re-exported here);
//   - the 3DS hold (B-1 step 5): sendHeldMail, the one "Confirm your payment"
//     mail (onHeld, retried by the held step before the deadline only);
//     sweepHeld, the QStash held step over sweep:held (scored by heldUntil):
//     past heldUntil, under the sign-up's one lifecycle lease, the invoice is
//     read: paid goes to the paid path, otherwise expireHold voids first, then
//     hands back or moves to tearing_down with held_expired and tears down;
//     sweepTeardowns, the teardowns step over sweep:teardown, finishing any
//     teardown cut short and sending the removed mail after a confirmed delete;
//   - handleConfirmPayment, POST /api/confirm-payment: the owner-only 303 to
//     the hosted invoice page (Tom's answer 3). The hosted URL is read from
//     signup:{provisionId} only here and in the mail, and is never put in a
//     reply body, a page or a log line (T-23-188).
//
// Privacy rule: log lines hold fixed words and the result word only, never an
// email, a session or provision id, or the hosted invoice URL.
import * as v from 'valibot'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { formatHeldUntil, mailTimeZone } from '../../shared/billing-time'
import { hasValidProvisionToken } from './provision-handlers'
import { sameSessionHash } from './invites'
import { buildHeldMail, buildRemovedMail } from './mail-copy'
import { expireHold, sendCustomerMail, stopProvision, type RetryStopDeps, type StopMailConfig } from './retry-stop'
import { HELD_INDEX, TEARDOWN_INDEX, onFirstInvoicePaid, type InvoiceLike } from './billing'
import { LeaseLostError, MAIL_TIMEOUT_MS, applyResult, clearIndex, isApplied, transition, withLifecycleLock, writeIntent } from './lifecycle'
import type { SweepDeps } from './cron-sweep'

export { reopenInvite } from './invites'

/** The Redis calls the two workflow routes make. */
export interface TeardownRouteRedis {
  get: (key: string) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  hset: (key: string, fields: Record<string, unknown>) => Promise<unknown>
  /** The result's transitions (lifecycle.ts TRANSITION_SCRIPT). */
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

export interface TeardownRouteDeps {
  redis: TeardownRouteRedis
  /** NUXT_PROVISION_CALLBACK_SECRET: the bearer is HMAC(secret, provision_id). */
  secret: string
  now?: () => number
  log?: (msg: string) => void
}

export type TeardownCheckOutcome =
  | { status: 401, body: { message: 'Unauthorized' } }
  | { status: 200 | 404 | 409, body: { teardown: boolean } }

const UNAUTHORIZED = { status: 401 as const, body: { message: 'Unauthorized' as const } }
const isTrue = (value: unknown) => String(value) === 'true'
const isEmpty = (s: Record<string, unknown> | null): s is null => !s || Object.keys(s).length === 0

/** The four words the workflow reports (23-36). */
export const TEARDOWN_RESULTS = ['deleted', 'gone', 'refused', 'failed'] as const

/** Two failed builds stop a sign-up (retry-stop.ts MAX_FAILURES). */
const MAX_FAILURES = 2
const blank = (value: unknown) => value === undefined || value === null || value === ''
const count = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * May the workflow delete this sign-up's app? (escalation point 3; HIGHs 3
 * and 8.) The status is read first: yes only for tearing_down, which no
 * charge path can reach or leave, plus the conditions of its reason:
 *   - build_failed: two failures, and no invoice, pending subscription or subscription;
 *   - declined or held_expired: the invoice already void (stopInvoice), no subscription;
 *   - activation_failed (Tom's 2026-11-09 refund case, Task 6): the refund
 *     recorded as D2 requires it (refundSucceededAt set, or refundZero true)
 *     and the site never activated.
 * Every other state, and every other combination, answers no (Argon's
 * fallthrough included: a declined sign-up whose void is not done is a no
 * whatever its failure count).
 */
function teardownApproved(state: Record<string, unknown>): boolean {
  if (state.status !== 'tearing_down') return false
  const reason = String(state.teardownReason ?? '')
  if (reason === 'build_failed') {
    return count(state.failedAttempts) >= MAX_FAILURES && blank(state.invoiceId) && blank(state.pendingSubscriptionId) && blank(state.subscriptionId)
  }
  if (reason === 'declined' || reason === 'held_expired') return isTrue(state.stopInvoice) && blank(state.subscriptionId)
  if (reason === 'activation_failed') {
    return (!blank(state.refundSucceededAt) || isTrue(state.refundZero)) && blank(state.refundProblem) && blank(state.activatedAt)
  }
  return false
}

/**
 * GET /api/teardown-check?provision_id. The bearer is checked before any Redis
 * read. The answer carries one boolean and nothing about the person.
 */
export async function handleTeardownCheck(authHeader: string | undefined, provisionId: unknown, deps: TeardownRouteDeps): Promise<TeardownCheckOutcome> {
  if (typeof provisionId !== 'string' || !PROVISION_ID_PATTERN.test(provisionId)) return UNAUTHORIZED
  if (!hasValidProvisionToken(authHeader, provisionId, deps.secret)) return UNAUTHORIZED
  const sid = await deps.redis.get(`provision:by-id:${provisionId}`)
  if (typeof sid !== 'string' || !sid) return { status: 404, body: { teardown: false } }
  const state = await deps.redis.hgetall(`provision:${sid}`)
  if (isEmpty(state) || String(state.provisionId) !== provisionId) return { status: 404, body: { teardown: false } }
  return teardownApproved(state)
    ? { status: 200, body: { teardown: true } }
    : { status: 409, body: { teardown: false } }
}

const resultSchema = v.object({
  provision_id: v.pipe(v.string(), v.regex(PROVISION_ID_PATTERN)),
  result: v.picklist([...TEARDOWN_RESULTS])
})

export type TeardownResultOutcome =
  | { status: 401, body: { message: 'Unauthorized' } }
  | { status: 400 | 404, body: { message: string } }
  | { status: 200, body: { ok: true } }

/**
 * POST /api/teardown-result {provision_id, result}. The bearer is checked for
 * the id in the body before any Redis read. On a sign-up being torn down
 * (23-43 Task 2): deleted or gone is the one step to torn_down (the word, its
 * time, and sweep:teardown, so the teardowns step sends what follows: the
 * removed mail a 3DS hold that ran out is owed); refused or failed keeps the
 * word and its time, the status stays tearing_down and reconcile:flags gets
 * an entry (a person decides, D-18). On any other sign-up only the word and
 * its time are kept.
 */
export async function handleTeardownResult(authHeader: string | undefined, body: unknown, deps: TeardownRouteDeps): Promise<TeardownResultOutcome> {
  const claimedId = (body as { provision_id?: unknown } | null)?.provision_id
  if (typeof claimedId !== 'string' || !PROVISION_ID_PATTERN.test(claimedId) || !hasValidProvisionToken(authHeader, claimedId, deps.secret)) {
    return UNAUTHORIZED
  }
  const parsed = v.safeParse(resultSchema, body)
  if (!parsed.success) return { status: 400, body: { message: 'Invalid result' } }
  const { provision_id: provisionId, result } = parsed.output
  const sid = await deps.redis.get(`provision:by-id:${provisionId}`)
  if (typeof sid !== 'string' || !sid) return { status: 404, body: { message: 'Unknown provision' } }
  const state = await deps.redis.hgetall(`provision:${sid}`)
  if (isEmpty(state)) return { status: 404, body: { message: 'Unknown provision' } }
  const params = { provisionId, result, now: (deps.now ?? Date.now)() }
  let applied = false
  if (state.status === 'tearing_down') {
    applied = result === 'deleted' || result === 'gone'
      ? isApplied(await transition(deps.redis, sid, 'tornDown', { ...params, removedMailDue: state.teardownReason === 'held_expired' && !isTrue(state.stopMail) }))
      : isApplied(await transition(deps.redis, sid, 'teardownProblem', params))
  }
  if (!applied) await transition(deps.redis, sid, 'teardownResult', params)
  deps.log?.(`teardown-result: ${result}`)
  return { status: 200, body: { ok: true } }
}

// --- the 3DS hold (B-1 step 5) ------------------------------------------------------

/** Members read per QStash run, oldest first (as 23-38's SWEEP_LIMIT). */
export const HELD_SWEEP_LIMIT = 50

export interface HeldMailDeps {
  redis: Pick<TeardownRouteRedis, 'hgetall' | 'hset'>
  mail?: StopMailConfig
  log?: (msg: string) => void
}

/**
 * The one "Confirm your payment" mail for a held sign-up: to signup.email,
 * with the button to the invoice's hosted page and the end of the hold in the
 * zone kept at checkout (UTC when there is none). heldMailSent is written only
 * after Resend took it; a failure is raised, and the held step sends it on its
 * next run. The Idempotency-Key held-mail-{provisionId} keeps a retried send
 * to one. 'skipped' when the sign-up is not held or the mail already went.
 */
export async function sendHeldMail(sid: string, deps: HeldMailDeps): Promise<'sent' | 'skipped'> {
  const state = await deps.redis.hgetall(`provision:${sid}`)
  if (isEmpty(state) || state.status !== 'held' || isTrue(state.heldMailSent)) return 'skipped'
  const provisionId = String(state.provisionId ?? '')
  const signup = (provisionId ? await deps.redis.hgetall(`signup:${provisionId}`) : null) ?? {}
  const link = typeof signup.hostedInvoiceUrl === 'string' ? signup.hostedInvoiceUrl : ''
  const email = typeof signup.email === 'string' ? signup.email : ''
  if (!link || !email) {
    deps.log?.('teardown: held mail not sent, no address or payment page')
    return 'skipped'
  }
  if (!deps.mail) throw new Error('teardown: mail not wired')
  const until = formatHeldUntil(Number(state.heldUntil), mailTimeZone(signup.timeZone))
  await sendCustomerMail(email, buildHeldMail({ until, link }), `held-mail-${provisionId}`, deps.mail)
  await deps.redis.hset(`provision:${sid}`, { heldMailSent: true })
  return 'sent'
}

export interface HeldCounts {
  due: number
  mailed: number
  confirmed: number
  expired: number
  busy: number
  errors: number
}

/** heldUntil as a deadline in ms, or null when it is missing, empty, zero or not a whole number (point 6). */
function heldDeadline(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw)) ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The QStash held step (second entry of CRON_STEPS). One bounded read of
 * sweep:held, oldest heldUntil first, at most 50 (pilot volume is far below
 * that). For each member, in its own try/catch (23-43 Task 2):
 *   - not held any more (paid, declined, gone): it leaves the set (compare-and-remove);
 *   - heldUntil missing, empty, zero or not a number: counted in errors, a
 *     fixed log line, heldUntilBad and a reconcile:flags entry; no mail and
 *     no expiry, and the member stays for a person;
 *   - before heldUntil: only the "Confirm your payment" mail if it has not
 *     gone yet, in its own try/catch (a failed onHeld send is retried here);
 *   - at or after heldUntil: no confirm mail at all. Under the sign-up's one
 *     lifecycle lease the invoice is read: paid takes the paid transition;
 *     otherwise expireHold voids and cancels first, then hands back (a payment
 *     found during the void) or moves to tearing_down with held_expired and
 *     runs the rest of the teardown in the same lease. The activation of a
 *     paid sign-up runs after the lease (onFirstInvoicePaid).
 * The step's log line (cron-sweep.ts) has counts only.
 */
export async function sweepHeld(deps: SweepDeps): Promise<HeldCounts> {
  const { redis } = deps
  const now = (deps.now ?? Date.now)()
  const counts: HeldCounts = { due: 0, mailed: 0, confirmed: 0, expired: 0, busy: 0, errors: 0 }
  const members = (await redis.zrange(HELD_INDEX, '-inf', '+inf', { byScore: true, offset: 0, count: HELD_SWEEP_LIMIT })).map(String)
  counts.due = members.length
  const stopDeps: RetryStopDeps = { ...deps, keepAlive: undefined }
  for (const sid of members) {
    try {
      const state = await redis.hgetall(`provision:${sid}`)
      if (isEmpty(state) || state.status !== 'held') {
        // Compare-and-remove (Codex 6): only while the record still owes this index nothing.
        await clearIndex(redis, sid, 'held')
        continue
      }
      const provisionId = String(state.provisionId ?? '')
      const until = heldDeadline(state.heldUntil)
      if (until === null) {
        counts.errors++
        deps.log?.('teardown: held sign-up has no valid deadline; flagged for a person')
        await transition(redis, sid, 'heldUntilBad', { provisionId: provisionId || undefined, now })
        continue
      }
      if (now < until) {
        if (!isTrue(state.heldMailSent)) {
          try {
            if (await sendHeldMail(sid, deps) === 'sent') counts.mailed++
          } catch {
            counts.errors++
            deps.log?.('teardown: held mail not sent, the next held step retries it')
          }
        }
        continue
      }

      const billing = deps.billing
      if (!billing) throw new Error('teardown: billing not wired')
      // Set inside the lease; acted on after it (asserted wide so the checks below type-check).
      let decision = 'none' as 'paid' | 'expired' | 'none'
      let paidInvoice: InvoiceLike | undefined
      const outcome = await withLifecycleLock(sid, { redis, tick: billing.tick, timers: billing.timers, log: billing.log }, async (lease) => {
        const fresh = await redis.hgetall(`provision:${sid}`)
        if (isEmpty(fresh) || fresh.status !== 'held') return 'skipped'
        const invoiceId = String(fresh.invoiceId ?? '')
        const invoice = invoiceId ? await lease.stripe('invoice', o => billing.stripe().invoices.retrieve(invoiceId, {}, o)) : null
        if (invoice?.status === 'paid') {
          decision = 'paid'
          paidInvoice = { ...invoice, id: invoice.id || invoiceId }
          return 'paid'
        }
        const out = await expireHold(sid, stopDeps, lease)
        if ('handedBack' in out && out.handedBack) decision = 'paid'
        else if (out.stopped) decision = 'expired'
        return 'done'
      })
      if (outcome === 'busy' || outcome === 'lost') {
        counts.busy++
        continue
      }
      if (decision === 'paid') {
        // After the lease: the paid path takes the same lock, applies the paid step if the
        // hold is still open (the invoice it read), and makes the activation try.
        await onFirstInvoicePaid(provisionId, billing, undefined, paidInvoice)
        counts.confirmed++
      } else if (decision === 'expired') {
        counts.expired++
      }
    } catch {
      counts.errors++
    }
  }
  return counts
}

export interface TeardownCounts {
  due: number
  tornDown: number
  /** Removed mails sent after a confirmed delete (P4). */
  mailed: number
  busy: number
  cleared: number
  errors: number
}

/** A teardown with runner steps left: declined and not yet tearing_down, or tearing_down / torn_down whose steps have not all run. */
const runnerOwed = (state: Record<string, unknown>) =>
  state.status === 'declined' || ((state.status === 'tearing_down' || state.status === 'torn_down') && !isTrue(state.tornDown))

/**
 * The approved "We've removed your site" mail for a 3DS hold that ran out,
 * sent only once the workflow confirmed the delete (P4): under the lifecycle
 * lease, an intent first, one Resend call keyed removed-mail-{provisionId},
 * then the removedMailSent step (stopMail set, nothing more owed). A failed
 * send is raised: the sign-up stays owed and the next teardowns step sends it.
 */
async function sendRemovedMail(sid: string, deps: SweepDeps): Promise<'sent' | 'busy' | 'skipped'> {
  const { redis } = deps
  const out = await withLifecycleLock(sid, { redis, tick: deps.tick, timers: deps.timers, log: deps.log }, async (lease) => {
    const state = await redis.hgetall(`provision:${sid}`)
    if (isEmpty(state) || state.status !== 'torn_down' || !isTrue(state.removedMailDue)) return 'skipped' as const
    const provisionId = String(state.provisionId ?? '')
    const now = (deps.now ?? Date.now)()
    const signup = (provisionId ? await redis.hgetall(`signup:${provisionId}`) : null) ?? {}
    const email = typeof signup.email === 'string' ? signup.email : ''
    if (email) {
      const mail = deps.mail
      if (!mail) throw new Error('teardown: mail not wired')
      const key = `removed-mail-${provisionId}`
      await writeIntent(redis, sid, lease, 'mail', key, { provisionId, now })
      await lease.remote('mail', MAIL_TIMEOUT_MS, signal => sendCustomerMail(email, buildRemovedMail(), key, mail, signal))
      if (await applyResult(redis, sid, lease, 'mail', 'removedMailSent', { provisionId, now }, deps.log) === 'dropped') throw new LeaseLostError('mail')
      return 'sent' as const
    }
    deps.log?.('teardown: removed mail not sent, no address')
    await transition(redis, sid, 'removedMailSent', { provisionId, now, clearIntent: true }, lease)
    return 'skipped' as const
  })
  return out === 'busy' || out === 'lost' ? 'busy' : out
}

/**
 * The QStash teardowns step (last entry of CRON_STEPS). One bounded read of
 * the due members of sweep:teardown (23-43 Task 2: one index for every
 * teardown in flight). A member with runner steps left runs stopProvision
 * under its lifecycle lock, whatever its reason: declined, held_expired,
 * build_failed (its stop moved it here from sweep:stops), and activation_failed
 * records that carry a subscriptionId (Codex 3). A torn_down member owed the
 * removed mail gets it (sendRemovedMail). Every other member leaves the set
 * only through CLEAR_INDEX_SCRIPT, which keeps one the record still needs.
 */
export async function sweepTeardowns(deps: SweepDeps): Promise<TeardownCounts> {
  const { redis } = deps
  const now = (deps.now ?? Date.now)()
  const counts: TeardownCounts = { due: 0, tornDown: 0, mailed: 0, busy: 0, cleared: 0, errors: 0 }
  const members = (await redis.zrange(TEARDOWN_INDEX, '-inf', now, { byScore: true, offset: 0, count: HELD_SWEEP_LIMIT })).map(String)
  counts.due = members.length
  const stopDeps: RetryStopDeps = { ...deps, keepAlive: undefined }
  for (const sid of members) {
    try {
      const state = await redis.hgetall(`provision:${sid}`)
      // Torn down after a 3DS hold ran out: the removed mail, once the delete is confirmed (P4).
      if (!isEmpty(state) && state.status === 'torn_down' && isTrue(state.removedMailDue) && isTrue(state.tornDown)) {
        const sent = await sendRemovedMail(sid, deps)
        if (sent === 'sent') counts.mailed++
        if (sent === 'busy') counts.busy++
        else await clearIndex(redis, sid, 'teardown')
        continue
      }
      if (isEmpty(state) || !runnerOwed(state)) {
        // Compare-and-remove (Codex 6): a member the record still needs stays.
        if (await clearIndex(redis, sid, 'teardown')) counts.cleared++
        continue
      }
      const outcome = await stopProvision(sid, stopDeps)
      if (outcome.stopped) {
        counts.tornDown++
        continue
      }
      // Not finished: another runner holds the lifecycle lock, or the invoice was paid and handed back.
      const after = await redis.hgetall(`provision:${sid}`)
      if (!isEmpty(after) && runnerOwed(after)) counts.busy++
      else counts.cleared++
    } catch {
      counts.errors++
    }
  }
  return counts
}

// --- POST /api/confirm-payment (Tom's answer 3) ---------------------------------------

/** A Stripe Checkout session id, as the success page has it (retry-stop.ts uses the same shape). */
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/
/** Only Stripe's own hosted invoice page is ever a redirect target. */
const HOSTED_PREFIX = 'https://invoice.stripe.com/'

export type ConfirmOutcome =
  | { status: 303, location: string }
  | { status: 404, body: { message: 'Not Found' } }

const NOT_FOUND = { status: 404 as const, body: { message: 'Not Found' as const } }

/**
 * The held screen's "Confirm my payment" (a form POST with session_id). Only
 * the browser that made the sign-up gets the 303 to the hosted invoice page:
 * the request's ln_invite hash must equal the ownerSessionHash stored at
 * checkout (constant time). Another session, no session, a sign-up not held,
 * or a stored URL that is not Stripe's hosted page: 404, with no URL anywhere
 * in the answer.
 */
export async function handleConfirmPayment(
  sessionId: unknown,
  requestHash: string | null | undefined,
  deps: { redis: Pick<TeardownRouteRedis, 'hgetall'> }
): Promise<ConfirmOutcome> {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !requestHash) return NOT_FOUND
  const state = await deps.redis.hgetall(`provision:${sessionId}`)
  if (isEmpty(state) || state.status !== 'held') return NOT_FOUND
  const provisionId = String(state.provisionId ?? '')
  if (!provisionId) return NOT_FOUND
  const signup = await deps.redis.hgetall(`signup:${provisionId}`)
  if (isEmpty(signup) || !sameSessionHash(signup.ownerSessionHash, requestHash)) return NOT_FOUND
  const url = typeof signup.hostedInvoiceUrl === 'string' ? signup.hostedInvoiceUrl : ''
  if (!url.startsWith(HOSTED_PREFIX)) return NOT_FOUND
  return { status: 303, location: url }
}
