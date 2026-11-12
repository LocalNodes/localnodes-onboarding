import * as v from 'valibot'
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  CALLBACK_STATUSES,
  isReasonCode,
  PROVISION_ID_PATTERN,
  type ProvisioningState
} from '../../shared/provisioning'
import { recordFailure, resumeStop, settleProvisional, type RetryStopDeps, type RetryStopRedis } from './retry-stop'
import { removeInflight } from './capacity'
import { deleteProvisionKey } from './byo-key'
import { billingWaits, isApplied, transition } from './lifecycle'
import { sameSessionHash } from './invites'
import { hasCheckoutMarker } from './checkout-marker'
import { pilotEndOf } from './pilot-end'

type RedisLike = RetryStopRedis

/**
 * The first payment's two entry points (23-32, server/utils/billing-wiring.ts):
 * start runs the charge at ready, nudge resumes it (at most once per 10
 * seconds). Both apply keepAlive themselves; a throw is theirs to log.
 */
export interface BillingHooks {
  start: (sid: string) => Promise<void> | void
  nudge: (sid: string, provisionId?: string) => Promise<void> | void
}

/** What the failed branch needs beyond the four basic calls (retry-stop.ts), and the billing hooks. */
type CallbackDeps = Omit<RetryStopDeps, 'redis'> & { redis?: RetryStopDeps['redis'], billing?: BillingHooks }

/** Once a sign-up is ready or past it, no callback changes it (23-32; the 23-43 server-only states too). */
const AFTER_READY = new Set(['ready', 'held', 'declined', 'complete', 'tearing_down', 'torn_down', 'refunding', 'refunded'])

const httpError = (statusCode: number, message: string) => {
  const err = new Error(message)
  ;(err as any).statusCode = statusCode
  return err
}

const isHttpsUrl = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://')

// A callback body (provision contract v1). v.object drops unknown keys, so a
// sign-in link field sent by an old image is never stored (D-13), and neither
// is the old free-text error field. The reason is one of the fixed
// codes; any other text becomes "unknown" so a failure is still recorded.
// source says who reports: the workflow (the default, and the only final
// "failed") or the site's own entrypoint (a provisional "failed", 23-12).
const RELAYER_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/
const callbackBodySchema = v.object({
  provision_id: v.pipe(v.string(), v.regex(PROVISION_ID_PATTERN)),
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2)),
  // Never held, declined or complete: only the sign-up app writes those (23-32).
  status: v.picklist([...CALLBACK_STATUSES]),
  site_url: v.optional(v.pipe(v.string(), v.maxLength(200), v.regex(/^https:\/\//))),
  reason: v.optional(v.pipe(v.string(), v.maxLength(64), v.transform(r => (isReasonCode(r) ? r : 'unknown')))),
  app_uuid: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/))),
  // A practice site's relayer public address (pilot web3 B5), sent with ready only. Anything
  // but 0x and 40 hex is dropped, not refused: a ready must not be lost over a malformed
  // address. It is stored for the operator who funds the relayer; the status reply never reads it.
  relayer_address: v.optional(v.pipe(v.unknown(), v.transform(a => (typeof a === 'string' && RELAYER_ADDRESS_PATTERN.test(a) ? a : undefined)))),
  source: v.optional(v.picklist(['workflow', 'site']), 'workflow')
})

/** The stored attempt number, or 1 when the hash holds none or something that is not a whole number above 0. */
function wholeAttempt(value: unknown): number {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/**
 * Handle GET /api/provision-status requests.
 * Pure function for testability.
 *
 * The reply is an allow-list of seven keys (D-13, T-23-34): 23-14's six plus
 * the attempt number (23-38, orchestrator ruling point 1 (c), 2026-11-08), so
 * the failure screen can tell a first failure from a second. Nothing else in
 * the hash is read, so a field an old run left behind (a sign-in link, an
 * error text, an address) cannot reach the browser. Two statuses add keys
 * (23-37): held adds heldUntil and canConfirm, declined adds heldExpired.
 * With no state at all the reply is {status: 'unknown'} for a session checkout
 * marked (checkout-marker.ts) and {status: 'unknown', notFound: true} for any
 * other id (23-20 follow-up).
 */
export async function handleProvisionStatus(
  sessionId: string | undefined,
  redis: RedisLike,
  opts: Omit<RetryStopDeps, 'redis' | 'dispatch'> & {
    billing?: Pick<BillingHooks, 'nudge'>
    /** sha256 of the request's own ln_invite cookie (23-37): decides canConfirm on a held sign-up. */
    requestHash?: string | null
  } = {}
): Promise<{
  status: string
  siteUrl?: string | null
  reason?: string | null
  canRetry?: boolean
  stopped?: boolean
  startedAt?: string
  attempt?: number
  heldUntil?: string
  canConfirm?: boolean
  heldExpired?: boolean
  removed?: boolean
  noCapture?: boolean
  refundProven?: boolean
  lateActivation?: boolean
  notFound?: boolean
  /** True for a free pilot, false for a paid sign-up; absent when the sign-up record could not be read. */
  pilot?: boolean
}> {
  if (!sessionId) {
    throw httpError(400, 'session_id is required')
  }

  const key = `provision:${sessionId}`
  let data = await redis.hgetall(key) as Partial<ProvisioningState> | null

  // No state yet. A session checkout created is still waiting for its webhook
  // ("unknown"); an id checkout never made, or one whose day has passed, is
  // not found, and /success shows its empty state (23-20 follow-up).
  if (!data || Object.keys(data).length === 0) {
    return (await hasCheckoutMarker(redis, sessionId)) ? { status: 'unknown' } : { status: 'unknown', notFound: true }
  }

  // A site's own "failed" past its 10-minute window becomes final on this read
  // (23-14); at the second failure the stop starts here, in the background.
  if (await settleProvisional(sessionId, data as Record<string, unknown>, { ...opts, redis })) {
    data = (await redis.hgetall(key) as Partial<ProvisioningState> | null) ?? data
  }

  // A sign-up in ready owes its first payment or its activation: the read
  // nudges billing (23-32; at most once per 10 seconds, in the background).
  // The reply below is the same either way.
  // Billing rejected or in review (23-43 Task 3), or a site that never answered the probe (Task 6), waits for a person: no nudge.
  if (data.status === 'ready' && opts.billing && !billingWaits(data as Record<string, unknown>)) {
    try {
      await opts.billing.nudge(sessionId, data.provisionId ? String(data.provisionId) : undefined)
    } catch {
      opts.log?.('provision-status: billing not nudged')
    }
  }

  const raw = data as Record<string, unknown>
  // The server-only states never reach the page (23-43 Task 2): tearing_down
  // and torn_down show as the screen their reason had (declined, a 3DS hold
  // that ran out, a build that failed twice). The refund case (Task 7) shows
  // refunding while the money is on its way back, refunded only after D2's
  // check passed, and a zero invoice the approved Stopped screen (P5).
  const shown = projectStatus(raw)
  // P5 (a zero invoice): stopped is not stored for an activation_failed
  // teardown (stopFinished sets it for a build failure only), so the reply says
  // it, with no retry: the Stopped screen, never the failure-and-retry one.
  const zeroStopped = shown === 'failed' && isRefundCase(raw)
  const pilot = await readPilot(raw, redis, opts.log)
  const reply = {
    status: shown,
    siteUrl: isHttpsUrl(data.siteUrl) ? data.siteUrl : null,
    reason: isReasonCode(data.reason) ? data.reason : null,
    // Set by the retry and stop flow (23-14); read here as stored.
    canRetry: zeroStopped ? false : String(data.canRetry) === 'true',
    stopped: zeroStopped || String(data.stopped) === 'true',
    startedAt: data.startedAt,
    // 1 for the first build, 2 after the free retry (23-14 counts it up).
    attempt: wholeAttempt(data.attempt),
    // Whether the first step is a free pilot or a payment, so the progress page names it right.
    ...(pilot === undefined ? {} : { pilot })
  }

  // Held for the bank's confirmation (23-37): the end of the hold, and whether
  // this browser made the sign-up (its ln_invite hash equals ownerSessionHash,
  // constant time). Only that browser gets the "Confirm my payment" button. The
  // hosted invoice URL is never read here (T-23-188).
  if (raw.status === 'held') {
    const until = Number(raw.heldUntil)
    let canConfirm = false
    if (opts.requestHash && raw.provisionId) {
      const signup = await redis.hgetall(`signup:${String(raw.provisionId)}`)
      canConfirm = sameSessionHash(signup?.ownerSessionHash, opts.requestHash)
    }
    return {
      ...reply,
      heldUntil: Number.isFinite(until) && until > 0 ? new Date(until).toISOString() : undefined,
      canConfirm
    }
  }
  // Declined (23-37): a declined card, or a 3DS hold that ran out. The page
  // shows a different screen for each. A 3DS hold that ran out (23-43 Task 7)
  // adds removed (true only once the workflow confirmed the delete: torn_down),
  // noCapture (P3's "You weren't charged" only when it is true) and
  // refundProven (the P3 fallback: P6's sentence until D2's check passed, then P2's).
  if (shown === 'declined') {
    const heldExpired = raw.teardownReason === 'held_expired'
    if (!heldExpired) return { ...reply, heldExpired }
    return { ...reply, heldExpired, removed: raw.status === 'torn_down', noCapture: noCapture(raw), refundProven: refundProven(raw) }
  }
  // The refund screens (23-43 Task 7): P6 and P2, each with the lateActivation wording rule.
  if (shown === 'refunding' || shown === 'refunded') {
    return { ...reply, lateActivation: isTrueField(raw.lateActivation) }
  }
  return reply
}

/**
 * Whether this sign-up is a free pilot, from its sign-up record (a pilot has
 * pilotMonths, a paid sign-up has none). Undefined when the record is missing
 * or cannot be read, so the page does not guess: it keeps its neutral words.
 */
async function readPilot(raw: Record<string, unknown>, redis: RedisLike, log?: (msg: string) => void): Promise<boolean | undefined> {
  if (!raw.provisionId) return undefined
  try {
    const signup = await redis.hgetall(`signup:${String(raw.provisionId)}`)
    if (!signup || Object.keys(signup).length === 0) return undefined
    return pilotEndOf(signup, 0).pilot
  } catch {
    log?.('provision-status: pilot flag not read')
    return undefined
  }
}

const isTrueField = (value: unknown) => String(value) === 'true'
const isFilled = (value: unknown) => value !== undefined && value !== null && String(value) !== ''

/** The stored states a refund case (teardownReason activation_failed, 23-43 Task 6) passes through. */
const REFUND_CASE_STATES = ['refunding', 'refunded', 'tearing_down', 'torn_down']

function isRefundCase(raw: Record<string, unknown>): boolean {
  const status = String(raw.status ?? '')
  return REFUND_CASE_STATES.includes(status) && (raw.teardownReason === 'activation_failed' || status === 'refunding' || status === 'refunded')
}

/**
 * D2's check passed (23-43 Task 6): refundSucceededAt is written only by the
 * refundSucceeded step, after a refund was seen succeeded, for exactly the
 * amount paid, in the invoice's currency and on its payment. A refund problem
 * beside it (a person's hand edit gone half way) is not proof.
 */
export function refundProven(raw: Record<string, unknown>): boolean {
  return isFilled(raw.refundSucceededAt) && !isFilled(raw.refundProblem)
}

/**
 * P3's truth check (the orchestrator's answer, Argon 1): no capture exists.
 * True only with no paidAt, no subscriptionId, billing not paid and no
 * amountPaid above 0; an amountPaid that is not a number counts as a capture.
 */
export function noCapture(raw: Record<string, unknown>): boolean {
  const amountClear = !isFilled(raw.amountPaid) || Number(raw.amountPaid) <= 0
  return !isFilled(raw.paidAt) && !isFilled(raw.subscriptionId) && String(raw.billing ?? '') !== 'paid' && amountClear
}

/**
 * A refund case's page status (23-43 Task 7; 23-UI-SPEC "Billing copy
 * additions for 23-43"):
 *   - a zero invoice (refundZero): the approved Stopped screen (P5, failed with
 *     stopped) once its card and mail steps ran, so "we've removed your saved
 *     card" and "we've emailed you" are true; before that the waiting screen
 *     (ready), never "we're refunding" for money that was never taken;
 *   - refunded, or its teardown, with D2's check passed: refunded (P2);
 *   - anything else, including a pending refund and a refund problem waiting
 *     for a person: refunding (P6, the waiting screen).
 * A zero invoice whose site activated before the delete was dispatched is
 * complete by then (orchestrator ruling (a)) and never reaches this function.
 */
function refundScreen(raw: Record<string, unknown>): string {
  if (isTrueField(raw.refundZero)) return isTrueField(raw.stopCard) && isTrueField(raw.stopMail) ? 'failed' : 'ready'
  if (raw.status !== 'refunding' && refundProven(raw)) return 'refunded'
  return 'refunding'
}

/** The status the page sees: a stored status, with the server-only ones mapped to the screen they stand for. */
export function projectStatus(raw: Record<string, unknown>): string {
  const status = String(raw.status ?? '')
  const reason = String(raw.teardownReason ?? '')
  if (isRefundCase(raw)) return refundScreen(raw)
  if (status === 'tearing_down' || status === 'torn_down') {
    if (reason === 'declined' || reason === 'held_expired') return 'declined'
    if (reason === 'build_failed') return 'failed'
    return 'ready'
  }
  return status
}

/**
 * The bearer token one site sends: hex HMAC-SHA256 keyed by the callback
 * secret, over the provision id. The workflow computes the same value with
 * openssl dgst -sha256 -hmac. Server only (node:crypto); it lived in
 * shared/provisioning.ts until 23-20, when the browser began to load that file.
 */
export function callbackToken(secret: string, provisionId: string): string {
  return createHmac('sha256', secret).update(provisionId).digest('hex')
}

/**
 * Does this Authorization header carry the token for this provision id?
 * hex HMAC-SHA256(secret, provision_id), compared in constant time. With no
 * secret configured nothing passes: a token made from an empty key would be
 * computable by anyone.
 */
export function hasValidProvisionToken(authHeader: string | undefined, provisionId: string, secret: string): boolean {
  if (!secret || !authHeader || !authHeader.startsWith('Bearer ')) return false
  const given = Buffer.from(authHeader.slice('Bearer '.length))
  const expected = Buffer.from(callbackToken(secret, provisionId))
  // timingSafeEqual throws on buffers of different length, so a length mismatch
  // is answered first. The length of a token is not a secret.
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/**
 * Handle POST /api/provision-callback requests.
 * Pure function for testability.
 *
 * Each site reports only on itself: the bearer token is HMAC(secret,
 * provision_id) for the id in the body (D-17, T-23-35). The token is checked
 * before any Redis read.
 */
export async function handleProvisionCallback(
  authHeader: string | undefined,
  body: unknown,
  config: { provisionCallbackSecret: string },
  redis: RedisLike,
  deps?: CallbackDeps
): Promise<{ updated: boolean }> {
  // Authenticate first: the token depends on the id, so read the id alone.
  const claimedId = (body as { provision_id?: unknown } | null)?.provision_id
  if (
    typeof claimedId !== 'string'
    || !PROVISION_ID_PATTERN.test(claimedId)
    || !hasValidProvisionToken(authHeader, claimedId, config.provisionCallbackSecret)
  ) {
    throw httpError(401, 'Unauthorized')
  }

  // Validate body
  const parsed = v.safeParse(callbackBodySchema, body)
  if (!parsed.success) {
    throw httpError(400, 'Invalid callback')
  }
  const cb = parsed.output

  const sessionId = await redis.get(`provision:by-id:${cb.provision_id}`)
  if (typeof sessionId !== 'string' || !sessionId) {
    throw httpError(404, 'Unknown provision')
  }

  const key = `provision:${sessionId}`

  // A callback from an older attempt than the stored one changes nothing: a
  // late or replayed message must not overwrite a newer run. A missing state
  // hash (it expired) has nothing to protect and nothing to update.
  let current = await redis.hgetall(key)
  if (!current || Object.keys(current).length === 0) return { updated: false }
  if (cb.attempt < Number(current.attempt ?? 1)) return { updated: false }
  // A stopped sign-up is over: nothing a site says changes it.
  if (String(current.stopped) === 'true') return { updated: false }
  // Ready and after: the build is over and the payment decides (23-32). A late
  // installing, or a workflow failed after a teardown removed the app, changes
  // nothing. A repeated ready (23-35's redeploy re-send) only nudges billing.
  if (AFTER_READY.has(String(current.status))) {
    if (current.status === 'ready' && cb.status === 'ready' && deps?.billing && !billingWaits(current)) {
      try {
        await deps.billing.nudge(sessionId, cb.provision_id)
      } catch {
        deps.log?.('provision-callback: billing not nudged')
      }
    }
    // A replayed failed for a build-failure stop cut short finishes it (23-38); nothing is counted again (23-43).
    if (current.status === 'tearing_down' && cb.status === 'failed' && String(current.teardownReason) === 'build_failed' && deps?.stripe && deps.mail) {
      await resumeStop(sessionId, { ...deps, redis: deps.redis ?? redis as unknown as RetryStopDeps['redis'] })
    }
    return { updated: false }
  }
  // A site's own "failed" past its window is final now, before this news is read.
  if (await settleProvisional(sessionId, current, { ...deps, redis: deps?.redis ?? redis })) {
    current = (await redis.hgetall(key)) ?? current
  }

  // A failure goes through the retry and stop flow (23-14): it counts once per
  // attempt, frees the lock, offers the free retry or, at the second, stops.
  if (cb.status === 'failed') {
    // The lifetimes are raised inside the step (never lowered, 23-43).
    return recordFailure(sessionId, current, {
      attempt: cb.attempt,
      reason: cb.reason,
      appUuid: cb.app_uuid,
      source: cb.source
    }, { ...deps, redis: deps?.redis ?? redis })
  }

  // This attempt's failure is final (counted): later news about it changes nothing.
  if (Number(current.countedAttempt ?? 0) >= cb.attempt) return { updated: false }
  // A site's own "failed" is waiting on its window: only a "ready" wins.
  const provisional = Number(current.provisionalUntil ?? 0) > 0
  if (provisional && cb.status !== 'ready') return { updated: false }

  // The write is one guarded step (23-43): progress only between building
  // statuses, ready from a building status or this attempt's provisional
  // failed, each with the attempt guards. ready writes readyAt once, joins
  // sweep:billing and raises all three keys to 72 hours (through the 24 h
  // probe window); a progress step raises the record to a day. Refused: the
  // sign-up moved on since the read above, and nothing is written.
  const name = cb.status === 'ready' ? (provisional ? 'readyAfterProvisional' : 'ready') : 'progress'
  const applied = await transition(redis, sessionId, name, {
    provisionId: cb.provision_id,
    now: (deps?.now ?? Date.now)(),
    attempt: cb.attempt,
    status: cb.status,
    siteUrl: cb.site_url,
    reason: cb.reason,
    appUuid: cb.app_uuid,
    relayerAddress: cb.status === 'ready' ? cb.relayer_address : undefined
  })
  if (!isApplied(applied)) return { updated: false }

  // A ready site is running now, so Coolify counts it: it stops holding room
  // as a sign-up in flight (23-17). A failed removal only means the member runs
  // out on its own within 45 minutes. Then the first payment starts (23-32).
  if (cb.status === 'ready') {
    try {
      await removeInflight(redis, cb.provision_id)
    } catch {
      deps?.log?.('provision-callback: in-flight count not updated')
    }
    // The site has the organizer's key by now (D-21): forget it here too, in
    // case the workflow's ack never arrived. A failure leaves it to its 24-hour life.
    try {
      await deleteProvisionKey(redis, cb.provision_id)
    } catch {
      deps?.log?.('provision-callback: AI key slot not deleted')
    }
    // Indexed in the ready step itself, so a charge cut short (or never
    // started, with no billing wiring) is found by the next status read or
    // QStash run.
    if (deps?.billing) {
      try {
        await deps.billing.start(sessionId)
      } catch {
        deps.log?.('provision-callback: billing not started, the sweep resumes it')
      }
    }
  }

  return { updated: true }
}
