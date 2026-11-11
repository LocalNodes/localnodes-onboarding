import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleProvisionStatus } from '../../server/utils/provision-handlers'
import { FakeRedis } from './helpers/fake-redis'
import { CHECKOUT_MARKER_TTL_SECONDS, checkoutMarkerKey, forgetCheckout, markCheckout } from '../../server/utils/checkout-marker'

/**
 * GET /api/provision-status (Phase 23, plan 23-11, D-13, T-23-34).
 *
 * The reply is an allow-list of seven keys: 23-14's six, plus the attempt
 * number (23-38, orchestrator ruling point 1 (c), 2026-11-08), so the failure
 * screen can tell a first failure from a second. A sign-in link is never
 * returned, even when Redis still holds one from a run by an old image. The
 * provisioning callback is tested in provision-callback-auth.test.ts.
 */

const SID = 'cs_test_123'
const SEVEN_KEYS = ['attempt', 'canRetry', 'reason', 'siteUrl', 'startedAt', 'status', 'stopped']

describe('provision-status: GET /api/provision-status', () => {
  let redis: FakeRedis

  beforeEach(() => {
    redis = new FakeRedis()
  })

  it('returns status and startedAt from Redis when state exists', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'provisioning',
      subdomain: 'cascadia',
      provisionId: 'A1b2C3d4E5f6G7h8I9j0Kl',
      attempt: 1,
      failedAttempts: 0,
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:01:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(result.status).toBe('provisioning')
    expect(result.startedAt).toBe('2026-03-04T10:00:00Z')
  })

  // 23-20 follow-up (2026-11-08): "unknown" used to mean both "the webhook
  // has not written the state yet" and "this session id is not one of ours".
  // Checkout marks every session it creates, so the two can be told apart.
  it('an id with no state and no checkout marker is not found: { status: "unknown", notFound: true }', async () => {
    expect(await handleProvisionStatus('cs_nonexistent', redis)).toEqual({ status: 'unknown', notFound: true })
  })

  it('an id checkout created, before the webhook writes its state, is still waiting: { status: "unknown" }', async () => {
    await markCheckout(redis, SID)
    expect(await handleProvisionStatus(SID, redis)).toEqual({ status: 'unknown' })
  })

  it('the marker lasts a day, no longer than the state it stands in for, and the expired-session hook deletes it', async () => {
    await markCheckout(redis, SID)
    expect(CHECKOUT_MARKER_TTL_SECONDS).toBe(86400)
    expect(await redis.ttl(checkoutMarkerKey(SID))).toBe(86400)
    await forgetCheckout(redis, { id: SID })
    expect(await redis.exists(checkoutMarkerKey(SID))).toBe(0)
    expect(await handleProvisionStatus(SID, redis)).toEqual({ status: 'unknown', notFound: true })
    // A session object with no id deletes nothing and does not throw.
    await markCheckout(redis, SID)
    await forgetCheckout(redis, {})
    expect(await redis.exists(checkoutMarkerKey(SID))).toBe(1)
  })

  it('a session with state is never reported as not found, marker or not', async () => {
    await redis.hset(`provision:${SID}`, { status: 'triggered', startedAt: 'x' })
    expect(await handleProvisionStatus(SID, redis)).not.toHaveProperty('notFound')
  })

  it('returns { status: "unknown" } when no state in Redis but checkout marked the session', async () => {
    await markCheckout(redis, 'cs_nonexistent')
    expect(await handleProvisionStatus('cs_nonexistent', redis)).toEqual({ status: 'unknown' })
  })

  it('returns 400 validation error when session_id is missing', async () => {
    await expect(handleProvisionStatus(undefined, redis)).rejects.toThrow('session_id is required')
  })

  it('returns siteUrl for a complete site', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'complete',
      subdomain: 'cascadia',
      siteUrl: 'https://cascadia.localnodes.xyz',
      startedAt: '2026-03-04T10:00:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(result.status).toBe('complete')
    expect(result.siteUrl).toBe('https://cascadia.localnodes.xyz')
  })

  it('returns the reason code, not free text, when status is failed', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'failed',
      reason: 'install_timeout',
      canRetry: true,
      stopped: false,
      startedAt: '2026-03-04T10:00:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(result).toMatchObject({ status: 'failed', reason: 'install_timeout', canRetry: true, stopped: false })
  })

  it('reports canRetry and stopped as stored: false when nothing set them (23-14 sets them)', async () => {
    await redis.hset(`provision:${SID}`, { status: 'failed', reason: 'unknown', startedAt: '2026-03-04T10:00:00Z' })
    const result = await handleProvisionStatus(SID, redis)
    expect(result.canRetry).toBe(false)
    expect(result.stopped).toBe(false)
  })

  it('reports stopped true only when the hash says true (T-3)', async () => {
    await redis.hset(`provision:${SID}`, { status: 'failed', reason: 'unknown', stopped: true, canRetry: false, startedAt: 'x' })
    expect(await handleProvisionStatus(SID, redis)).toMatchObject({ stopped: true, canRetry: false })
    await redis.hset(`provision:${SID}`, { stopped: 'yes' })
    expect((await handleProvisionStatus(SID, redis)).stopped).toBe(false)
  })

  it('reports the attempt number as stored: 1 for the first build, 2 after the free retry (23-38)', async () => {
    await redis.hset(`provision:${SID}`, { status: 'failed', reason: 'install_failed', attempt: 1, canRetry: false, startedAt: 'x' })
    expect((await handleProvisionStatus(SID, redis)).attempt).toBe(1)
    await redis.hset(`provision:${SID}`, { attempt: 2 })
    expect((await handleProvisionStatus(SID, redis)).attempt).toBe(2)
  })

  it('reports attempt 1 when the hash holds none or something that is not a whole number above 0 (23-38)', async () => {
    await redis.hset(`provision:${SID}`, { status: 'provisioning', startedAt: 'x' })
    expect((await handleProvisionStatus(SID, redis)).attempt).toBe(1)
    for (const bad of ['two', 0, -1, 1.5]) {
      await redis.hset(`provision:${SID}`, { attempt: bad })
      expect((await handleProvisionStatus(SID, redis)).attempt).toBe(1)
    }
  })

  it('never returns a stored refunded field from an old run (T-3 removed the key)', async () => {
    await redis.hset(`provision:${SID}`, { status: 'failed', reason: 'unknown', refunded: true, startedAt: 'x' })
    const result = await handleProvisionStatus(SID, redis)
    expect(Object.keys(result).sort()).toEqual(SEVEN_KEYS)
    expect(result).not.toHaveProperty('refunded')
  })

  it('returns exactly status, siteUrl, reason, canRetry, stopped, startedAt and attempt (T-23-34, 23-38)', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'complete',
      subdomain: 'cascadia',
      siteUrl: 'https://cascadia.localnodes.xyz',
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:05:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(Object.keys(result).sort()).toEqual(SEVEN_KEYS)
  })

  it('never returns a sign-in link, an address or any other field from a poisoned hash (T-23-34)', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'complete',
      subdomain: 'cascadia',
      email: 'someone@example.com',
      siteName: 'Cascadia',
      stripeSessionId: SID,
      siteUrl: 'https://cascadia.localnodes.xyz',
      loginUrl: 'https://cascadia.localnodes.xyz/user/reset/1/abc123/login',
      login_url: 'https://cascadia.localnodes.xyz/user/reset/1/abc123/login',
      error: 'Provisioning workflow failed. Check logs. https://x.example/user/reset/1/zzz',
      provisionId: 'A1b2C3d4E5f6G7h8I9j0Kl',
      appUuid: 'abcdefghijklmnopqrstuvwx',
      githubRunUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/1',
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:05:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(Object.keys(result).sort()).toEqual(SEVEN_KEYS)
    const text = JSON.stringify(result)
    expect(text).not.toContain('reset')
    expect(text).not.toContain('login')
    expect(text).not.toContain('someone@example.com')
    expect(text).not.toContain('A1b2C3d4E5f6G7h8I9j0Kl')
  })

  it('returns exactly the seven keys for a failed hash that holds an old error text', async () => {
    await redis.hset(`provision:${SID}`, {
      status: 'failed',
      error: 'GitHub Actions workflow timed out',
      startedAt: '2026-03-04T10:00:00Z'
    })
    const result = await handleProvisionStatus(SID, redis)
    expect(Object.keys(result).sort()).toEqual(SEVEN_KEYS)
    expect(result.reason).toBeNull()
  })

  it('drops a stored reason that is not one of the fixed codes', async () => {
    await redis.hset(`provision:${SID}`, { status: 'failed', reason: 'Coolify said: token abc123 expired', startedAt: 'x' })
    const result = await handleProvisionStatus(SID, redis)
    expect(result.reason).toBeNull()
  })

  it('drops a stored site address that is not an https address', async () => {
    await redis.hset(`provision:${SID}`, { status: 'complete', siteUrl: 'javascript:alert(1)', startedAt: 'x' })
    const result = await handleProvisionStatus(SID, redis)
    expect(result.siteUrl).toBeNull()
  })
})

// --- 23-37: the held and declined replies ----------------------------------------
// A held sign-up's reply adds heldUntil (ISO) and canConfirm: true only for the
// browser that made the sign-up (the request's ln_invite hash equals
// ownerSessionHash). A declined reply adds heldExpired, so the page can tell a
// declined card from a 3DS hold that ran out. The hosted invoice URL is in no
// reply (T-23-188).
describe('provision-status: held and declined (23-37)', () => {
  const PID = 'H3ld000000000000000000'
  const OWNER = 'b'.repeat(64)
  const OTHER = 'c'.repeat(64)
  const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_secret_canary'
  const HELD_UNTIL = Date.parse('2026-11-09T16:15:00Z')
  let redis: FakeRedis

  beforeEach(async () => {
    redis = new FakeRedis()
    await redis.hset(`provision:${SID}`, {
      status: 'held',
      billing: 'held',
      provisionId: PID,
      subdomain: 'cascadia',
      attempt: 1,
      heldUntil: HELD_UNTIL,
      startedAt: '2026-11-08T10:00:00Z'
    })
    await redis.hset(`signup:${PID}`, { email: 'organizer@example.org', ownerSessionHash: OWNER, hostedInvoiceUrl: HOSTED, timeZone: 'America/Denver' })
  })

  it('held, the owner\'s session: the seven keys plus heldUntil (ISO) and canConfirm true', async () => {
    const reply = await handleProvisionStatus(SID, redis, { requestHash: OWNER })
    expect(Object.keys(reply).sort()).toEqual([...SEVEN_KEYS, 'canConfirm', 'heldUntil', 'pilot'].sort())
    expect(reply).toMatchObject({ status: 'held', heldUntil: '2026-11-09T16:15:00.000Z', canConfirm: true })
  })

  it('held, another session: canConfirm false', async () => {
    expect(await handleProvisionStatus(SID, redis, { requestHash: OTHER })).toMatchObject({ status: 'held', canConfirm: false })
  })

  it('held, no cookie: canConfirm false', async () => {
    expect(await handleProvisionStatus(SID, redis, {})).toMatchObject({ status: 'held', canConfirm: false })
    expect(await handleProvisionStatus(SID, redis, { requestHash: null })).toMatchObject({ canConfirm: false })
  })

  it('held, a sign-up with no stored owner: canConfirm false even for an empty hash', async () => {
    await redis.hset(`signup:${PID}`, { ownerSessionHash: '' })
    expect(await handleProvisionStatus(SID, redis, { requestHash: '' })).toMatchObject({ canConfirm: false })
  })

  it('canary: no reply holds the hosted URL or invoice.stripe.com, for the owner or anyone', async () => {
    for (const requestHash of [OWNER, OTHER, null]) {
      const text = JSON.stringify(await handleProvisionStatus(SID, redis, { requestHash }))
      expect(text).not.toContain(HOSTED)
      expect(text).not.toContain('invoice.stripe.com')
    }
  })

  it('declined: the seven keys plus heldExpired false; no heldUntil or canConfirm', async () => {
    await redis.hset(`provision:${SID}`, { status: 'declined', teardownReason: 'declined' })
    const reply = await handleProvisionStatus(SID, redis, { requestHash: OWNER })
    expect(Object.keys(reply).sort()).toEqual([...SEVEN_KEYS, 'heldExpired', 'pilot'].sort())
    expect(reply).toMatchObject({ status: 'declined', heldExpired: false })
  })

  it('a 3DS hold that ran out (declined, teardownReason held_expired): heldExpired true', async () => {
    await redis.hset(`provision:${SID}`, { status: 'declined', teardownReason: 'held_expired' })
    expect(await handleProvisionStatus(SID, redis, {})).toMatchObject({ status: 'declined', heldExpired: true })
  })

  it.each(['ready', 'provisioning', 'complete', 'failed'])('%s: exactly the seven keys and pilot, no heldUntil, canConfirm or heldExpired', async (status) => {
    await redis.hset(`provision:${SID}`, { status })
    expect(Object.keys(await handleProvisionStatus(SID, redis, { requestHash: OWNER })).sort()).toEqual([...SEVEN_KEYS, 'pilot'].sort())
  })

  // The progress page names its payment step by this flag: a free pilot
  // confirms, a paid sign-up takes its first payment. Without a readable
  // sign-up record the reply says neither and the page keeps neutral words.
  describe('pilot', () => {
    it('is true when the sign-up record carries pilot months, and false when it carries none', async () => {
      await redis.hset(`provision:${SID}`, { status: 'provisioning' })
      expect(await handleProvisionStatus(SID, redis, {})).toMatchObject({ pilot: false })
      await redis.hset(`signup:${PID}`, { pilotMonths: 3, pilotEndsAt: 1_800_000_000 })
      expect(await handleProvisionStatus(SID, redis, {})).toMatchObject({ pilot: true })
    })

    it('is a boolean only: the months, the end and the code never reach the reply', async () => {
      await redis.hset(`signup:${PID}`, { pilotMonths: 3, pilotEndsAt: 1_800_000_000, promoCode: 'PILOT-CANARY' })
      const text = JSON.stringify(await handleProvisionStatus(SID, redis, {}))
      expect(text).toContain('"pilot":true')
      expect(text).not.toContain('PILOT-CANARY')
      expect(text).not.toContain('1800000000')
    })

    it('is left out when the sign-up record is missing or cannot be read', async () => {
      await redis.hset(`provision:${SID}`, { status: 'provisioning', provisionId: 'Nosuchsignup00000000000' })
      expect(Object.keys(await handleProvisionStatus(SID, redis, {}))).not.toContain('pilot')
      const failing = {
        hgetall: async (key: string) => {
          if (key.startsWith('signup:')) throw new Error('redis down')
          return redis.hgetall(key)
        }
      } as unknown as FakeRedis
      const reply = await handleProvisionStatus(SID, failing, {})
      expect(Object.keys(reply)).not.toContain('pilot')
      expect(reply.status).toBe('provisioning')
    })
  })

  it('the route hashes the request\'s ln_invite cookie with sha256 and passes it', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../server/api/provision-status.get.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/getCookie\(event, INVITE_COOKIE\)/)
    expect(src).toMatch(/requestHash: .*sha256\(/)
  })
})

describe('the status reply projects the server-only states (23-43 Task 2)', () => {
  let redis: FakeRedis
  // refunding and refunded are page statuses since Task 7; only the teardown states stay server-only.
  const INTERNAL = ['tearing_down', 'torn_down']

  beforeEach(() => {
    redis = new FakeRedis()
  })

  const reply = async (fields: Record<string, unknown>) => {
    await redis.del(`provision:${SID}`)
    await redis.hset(`provision:${SID}`, { provisionId: 'A1b2C3d4E5f6G7h8I9j0Kl', attempt: 2, startedAt: '2026-11-08T10:00:00Z', ...fields })
    return handleProvisionStatus(SID, redis)
  }

  it.each(['tearing_down', 'torn_down'])('%s with declined shows declined, heldExpired false', async (status) => {
    expect(await reply({ status, teardownReason: 'declined' })).toMatchObject({ status: 'declined', heldExpired: false })
  })

  it.each(['tearing_down', 'torn_down'])('%s with held_expired shows declined, heldExpired true', async (status) => {
    expect(await reply({ status, teardownReason: 'held_expired' })).toMatchObject({ status: 'declined', heldExpired: true })
  })

  it.each([['tearing_down', true], ['torn_down', true], ['tearing_down', false]] as const)('%s with build_failed shows failed, stopped as stored (%s)', async (status, stopped) => {
    expect(await reply({ status, teardownReason: 'build_failed', stopped, canRetry: false })).toMatchObject({ status: 'failed', stopped, canRetry: false })
  })

  it('no internal state name reaches the reply, for every lifecycle state and every teardown reason', async () => {
    const { LIFECYCLE_STATES } = await import('../../server/utils/lifecycle')
    const { PROVISION_STATUSES } = await import('../../shared/provisioning')
    for (const status of LIFECYCLE_STATES) {
      for (const teardownReason of ['', 'build_failed', 'declined', 'held_expired', 'activation_failed']) {
        for (const extra of [{}, { refundSucceededAt: '2026-11-09T10:00:00Z', refundDone: true }, { refundZero: true, refundDone: true, stopMail: true }]) {
          const out = await reply({ status, teardownReason, ...extra })
          const text = JSON.stringify(out)
          for (const name of INTERNAL) expect(text, `${status} ${teardownReason}`).not.toContain(name)
          // Every status the page can be sent is a page status (23-43 Task 7).
          expect((PROVISION_STATUSES as readonly string[]).includes(out.status), `${status} ${teardownReason} -> ${out.status}`).toBe(true)
        }
      }
    }
  })
})

// 23-43 Task 7: the page statuses for the refund and the removal (23-UI-SPEC.md
// "Billing copy additions for 23-43", P2, P3, P5 and P6, with their truth
// conditions; the orchestrator's round-2 answer on the P3 fallback).
describe('the status reply for the refund and removal screens (23-43 Task 7)', () => {
  let redis: FakeRedis
  const PAID = { billing: 'paid', paidAt: '2026-11-08T10:00:00Z', subscriptionId: 'sub_1', invoiceId: 'in_1', amountPaid: 2900, currency: 'usd' }

  beforeEach(() => {
    redis = new FakeRedis()
  })

  const reply = async (fields: Record<string, unknown>) => {
    await redis.del(`provision:${SID}`)
    await redis.hset(`provision:${SID}`, { provisionId: 'A1b2C3d4E5f6G7h8I9j0Kl', attempt: 1, startedAt: '2026-11-08T10:00:00Z', ...fields })
    return handleProvisionStatus(SID, redis)
  }

  // --- removing and removed (P3; "removed only after the deletion is confirmed") ---

  it('removing until the deletion is confirmed: held_expired in tearing_down shows declined, heldExpired true, removed false', async () => {
    expect(await reply({ status: 'tearing_down', teardownReason: 'held_expired', billing: 'declined' })).toMatchObject({ status: 'declined', heldExpired: true, removed: false })
  })

  it('removed once the workflow confirmed it: held_expired in torn_down shows removed true', async () => {
    expect(await reply({ status: 'torn_down', teardownReason: 'held_expired', billing: 'declined' })).toMatchObject({ status: 'declined', heldExpired: true, removed: true })
  })

  it('a legacy declined record with held_expired (no teardown state yet) reads as removing, never removed', async () => {
    expect(await reply({ status: 'declined', teardownReason: 'held_expired' })).toMatchObject({ status: 'declined', heldExpired: true, removed: false })
  })

  it('a 3DS hold that ran out: the seven keys plus heldExpired, removed, noCapture and refundProven; a declined card keeps the seven plus heldExpired only', async () => {
    const held = await reply({ status: 'tearing_down', teardownReason: 'held_expired' })
    expect(Object.keys(held).sort()).toEqual([...SEVEN_KEYS, 'heldExpired', 'noCapture', 'refundProven', 'removed'].sort())
    const card = await reply({ status: 'tearing_down', teardownReason: 'declined' })
    expect(Object.keys(card).sort()).toEqual([...SEVEN_KEYS, 'heldExpired'].sort())
  })

  // --- the P3 truth check (noCapture; orchestrator, Argon 1) ---

  it('noCapture is true only with no paidAt, no subscriptionId, billing not paid and no amountPaid above 0', async () => {
    const base = { status: 'torn_down', teardownReason: 'held_expired', billing: 'declined' }
    expect(await reply(base)).toMatchObject({ noCapture: true, refundProven: false })
    expect(await reply({ ...base, amountPaid: 0 })).toMatchObject({ noCapture: true })
    for (const extra of [{ paidAt: '2026-11-09T10:00:00Z' }, { subscriptionId: 'sub_1' }, { billing: 'paid' }, { amountPaid: 2900 }, { amountPaid: 1 }]) {
      expect(await reply({ ...base, ...extra }), JSON.stringify(extra)).toMatchObject({ noCapture: false })
    }
  })

  it('a captured payment never shows You weren\'t charged: noCapture false, and refundProven only once D2\'s refundSucceededAt is set with no refund problem', async () => {
    const captured = { status: 'torn_down', teardownReason: 'held_expired', ...PAID }
    expect(await reply(captured)).toMatchObject({ noCapture: false, refundProven: false })
    expect(await reply({ ...captured, refundId: 're_1', refundStatus: 'pending' })).toMatchObject({ refundProven: false })
    expect(await reply({ ...captured, refundSucceededAt: '2026-11-09T11:00:00Z', refundDone: true })).toMatchObject({ noCapture: false, refundProven: true })
    expect(await reply({ ...captured, refundSucceededAt: '2026-11-09T11:00:00Z', refundProblem: 'partial' })).toMatchObject({ refundProven: false })
  })

  // --- refunding (P6) and refunded (P2); D2 ---

  it('refunding (any sub-step, including a refund problem) shows refunding, with lateActivation as stored', async () => {
    const base = { ...PAID, status: 'refunding', teardownReason: 'activation_failed' }
    for (const extra of [{}, { refundId: 're_1', refundStatus: 'pending' }, { refundProblem: 'partial' }, { refundDone: true }, { refundDone: true, refundCancelled: true }]) {
      expect(await reply({ ...base, ...extra }), JSON.stringify(extra)).toMatchObject({ status: 'refunding', lateActivation: false })
    }
    expect(await reply({ ...base, lateActivation: true })).toMatchObject({ status: 'refunding', lateActivation: true })
  })

  it('the refunded screen only after the refund succeeded: refunding with a succeeded refund still shows refunding until the refunded step', async () => {
    expect(await reply({ ...PAID, status: 'refunding', teardownReason: 'activation_failed', refundSucceededAt: '2026-11-09T11:00:00Z', refundDone: true })).toMatchObject({ status: 'refunding' })
  })

  it.each(['refunded', 'tearing_down', 'torn_down'])('the refunded screen only after the refund succeeded: %s with activation_failed and refundSucceededAt shows refunded, lateActivation as stored', async (status) => {
    const base = { ...PAID, status, teardownReason: 'activation_failed', refundDone: true, refundCancelled: true, refundSucceededAt: '2026-11-09T11:00:00Z' }
    expect(await reply(base)).toMatchObject({ status: 'refunded', lateActivation: false })
    expect(await reply({ ...base, lateActivation: true })).toMatchObject({ status: 'refunded', lateActivation: true })
  })

  it.each(['refunded', 'tearing_down', 'torn_down'])('%s with activation_failed but no refundSucceededAt and no refundZero shows the waiting screen (refunding), never refunded', async (status) => {
    expect(await reply({ ...PAID, status, teardownReason: 'activation_failed', refundDone: true })).toMatchObject({ status: 'refunding' })
  })

  it('refunding and refunded: the seven keys plus lateActivation, nothing else', async () => {
    const refunding = await reply({ ...PAID, status: 'refunding', teardownReason: 'activation_failed' })
    expect(Object.keys(refunding).sort()).toEqual([...SEVEN_KEYS, 'lateActivation'].sort())
    const refunded = await reply({ ...PAID, status: 'refunded', teardownReason: 'activation_failed', refundSucceededAt: 'x', refundDone: true })
    expect(Object.keys(refunded).sort()).toEqual([...SEVEN_KEYS, 'lateActivation'].sort())
  })

  // --- a zero invoice (P5: the approved Stopped screen) ---

  it.each(['tearing_down', 'torn_down'])('%s with activation_failed and refundZero, once the Stopped mail step ran, shows failed with stopped true and no retry, even though stopped is not stored', async (status) => {
    const out = await reply({ ...PAID, amountPaid: 0, status, teardownReason: 'activation_failed', refundZero: true, refundDone: true, stopCard: true, stopMail: true })
    expect(out).toMatchObject({ status: 'failed', stopped: true, canRetry: false, reason: null })
    expect(Object.keys(out).sort()).toEqual(SEVEN_KEYS)
  })

  it.each(['refunding', 'refunded', 'tearing_down'])('%s with refundZero before the Stopped mail step shows the waiting screen (ready): never "we\'re refunding" for a zero invoice, and P5 only once its card and mail steps ran', async (status) => {
    const out = await reply({ ...PAID, amountPaid: 0, status, teardownReason: 'activation_failed', refundZero: true, refundDone: true })
    expect(out).toMatchObject({ status: 'ready', stopped: false })
  })

  it('refunding and refunded are page statuses and never callback statuses', async () => {
    const { PROVISION_STATUSES, CALLBACK_STATUSES } = await import('../../shared/provisioning')
    for (const s of ['refunding', 'refunded']) {
      expect((PROVISION_STATUSES as readonly string[]).includes(s), s).toBe(true)
      expect((CALLBACK_STATUSES as readonly string[]).includes(s), s).toBe(false)
    }
  })
})

describe('the status read nudges billing only while billing can still move (23-43 Task 3)', () => {
  it.each([
    ['unset', undefined, 1],
    ['pending', 'pending', 1],
    ['rejected', 'rejected', 0],
    ['review', 'review', 0]
  ] as const)('a ready sign-up with billing %s: nudged the given number of times, and the reply is ready either way', async (_label, billing, times) => {
    const redis = new FakeRedis()
    await redis.hset(`provision:${SID}`, { status: 'ready', provisionId: 'StAtUs0000000000000000', attempt: 1, ...(billing ? { billing } : {}) })
    const nudge = vi.fn(async () => {})
    const out = await handleProvisionStatus(SID, redis, { billing: { nudge }, log: () => {} })
    expect(out.status).toBe('ready')
    expect(nudge).toHaveBeenCalledTimes(times)
  })
})
