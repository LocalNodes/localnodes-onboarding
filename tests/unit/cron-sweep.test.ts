import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  CRON_STEPS,
  SWEEP_LIMIT,
  handleCronSweep,
  runCronSteps,
  sweepStops,
  type SweepDeps
} from '../../server/utils/cron-sweep'
import { PROVISIONAL_MS, STOPS_INDEX, retryProvisioning, stopProvision } from '../../server/utils/retry-stop'
import { callbackToken, handleProvisionCallback, handleProvisionStatus } from '../../server/utils/provision-handlers'
import { GATED_API, gateDecision } from '../../shared/launch'
import { BILLING_INDEX, TEARDOWN_INDEX, type BillingDeps } from '../../server/utils/billing'
import { FakeRedis } from './helpers/fake-redis'

/** The billing step's counts over an empty sweep:billing (23-32). */
const BILLING_ZERO = { due: 0, charged: 0, held: 0, declined: 0, pending: 0, activated: 0, busy: 0, errors: 0, refundStarted: 0, refundBusy: 0 }
/** 23-43 Task 6: the refunds step. */
const REFUNDS_ZERO = { due: 0, refunded: 0, pending: 0, problems: 0, tornDown: 0, busy: 0, cleared: 0, errors: 0, waiting: 0 }
/** The held and teardowns steps' counts over empty sweep:held and sweep:teardown (23-37). */
const HELD_ZERO = { due: 0, mailed: 0, confirmed: 0, expired: 0, busy: 0, errors: 0 }
const TEARDOWNS_ZERO = { due: 0, tornDown: 0, mailed: 0, busy: 0, cleared: 0, errors: 0 }

/**
 * The QStash-signed sweep (Phase 23, plan 23-38; ONB-02, D-15, D-16 as
 * superseded by T-3, D-17, D-18).
 *
 * Upstash QStash posts to /api/cron/sweep every 5 minutes. The route runs only
 * on a valid Upstash-Signature, checked by @upstash/qstash's own Receiver
 * against the raw body and the configured URL. The sweep then settles every
 * sign-up whose site-failure window has passed and finishes its stop, exactly
 * once, even with no page open.
 *
 * No network: tokens are HS256, signed here with Web Crypto and test keys, and
 * verified by the real Receiver. Redis is FakeRedis, Stripe a mock whose money
 * methods must stay unused, and Resend a mocked fetch.
 */

// --- fixtures (copied from retry-stop.test.ts) -----------------------------

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CONFIG = { provisionCallbackSecret: SECRET }
const SID = 'cs_test_cron_sweep'
const PID = 'Z9y8X7w6V5u4T3s2R1q0Pa'
const PROMO = 'promo_pilot_1'
const INVITE = 'inv_0001'
const SETUP_INTENT = 'seti_123'
const PAYMENT_METHOD = 'pm_saved_card'
const EMAIL = 'organizer@example.org'
const APP_UUID = 'app-uuid-half-made'
const RUN = { runId: 42, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/42' }

const stateKey = `provision:${SID}`
const lockKey = `provision:${SID}:lock`
const stoppingKey = `provision:${SID}:stopping`
const bearer = `Bearer ${callbackToken(SECRET, PID)}`

function makeStripe() {
  return {
    setupIntents: { retrieve: vi.fn().mockResolvedValue({ id: SETUP_INTENT, payment_method: PAYMENT_METHOD }) },
    paymentMethods: { detach: vi.fn().mockResolvedValue({ id: PAYMENT_METHOD, customer: null }) },
    // Every way to move money or start a checkout: none may ever be called here.
    refunds: { create: vi.fn() },
    invoices: { pay: vi.fn(), voidInvoice: vi.fn(), create: vi.fn(), retrieve: vi.fn() },
    invoicePayments: { list: vi.fn() },
    subscriptions: { cancel: vi.fn(), create: vi.fn(), update: vi.fn() },
    checkout: { sessions: { create: vi.fn() } },
    paymentIntents: { create: vi.fn(), cancel: vi.fn() }
  }
}

type StripeMock = ReturnType<typeof makeStripe>

function moneyCalls(stripe: StripeMock): number {
  return [
    stripe.refunds.create,
    stripe.invoices.pay, stripe.invoices.voidInvoice, stripe.invoices.create, stripe.invoices.retrieve,
    stripe.invoicePayments.list,
    stripe.subscriptions.cancel, stripe.subscriptions.create, stripe.subscriptions.update,
    stripe.checkout.sessions.create,
    stripe.paymentIntents.create, stripe.paymentIntents.cancel
  ].reduce((n, fn) => n + fn.mock.calls.length, 0)
}

async function seed(redis: FakeRedis, now: number) {
  // What 23-11 (trigger), 23-07 (checkout), 23-31 (webhook), 23-17 (room) and
  // 23-18 (own AI key) leave behind.
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
  await redis.set(lockKey, 'locked', { nx: true, ex: 3600 })
  await redis.hset(stateKey, {
    status: 'provisioning',
    subdomain: 'cascadia',
    provisionId: PID,
    attempt: 1,
    failedAttempts: 0,
    startedAt: '2026-11-08T10:00:00Z',
    updatedAt: '2026-11-08T10:00:00Z'
  })
  await redis.hset(`signup:${PID}`, {
    subdomain: 'cascadia',
    communityName: 'Cascadia Reading Group',
    email: EMAIL,
    inviteId: INVITE,
    promoId: PROMO,
    stripeCustomerId: 'cus_123',
    setupIntentId: SETUP_INTENT
  })
  await redis.zadd(`promo:holds:${PROMO}`, { score: Math.floor(now / 1000) + 7800, member: INVITE })
  await redis.zadd('capacity:inflight', { score: Math.floor(now / 1000) + 2700, member: PID })
  await redis.hset(`byok:${PID}`, { kind: 'gemini', sealed: 'sealed-key-text' })
}

// --- tokens, signed the way QStash signs them -------------------------------

const URL_ = 'https://onboarding.test/api/cron/sweep'
const CURRENT = 'sig_test_current'
const NEXT = 'sig_test_next'
const OTHER = 'sig_test_other'
/** The SDK's public dev current key (QSTASH_DEV=true). */
const SDK_DEV_CURRENT = 'sig_7kYjw48mhY7kAjqNGcy6cr29RJ6r'
const BODY = '{}'

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (value: unknown) => b64url(enc.encode(JSON.stringify(value)))

async function sha256b64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))))
}

let jti = 0
async function signToken(opts: { key: string, url: string, body: string, iss?: string, iat?: number, exp?: number, nbf?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: opts.iss ?? 'Upstash',
    sub: opts.url,
    iat: opts.iat ?? now,
    nbf: opts.nbf ?? now,
    exp: opts.exp ?? now + 300,
    jti: `jwt_test_${++jti}`,
    body: await sha256b64url(opts.body)
  }
  const signingInput = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(payload)}`
  const key = await crypto.subtle.importKey('raw', enc.encode(opts.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signingInput)))
  return `${signingInput}.${b64url(sig)}`
}

const valid = (overrides: Partial<Parameters<typeof signToken>[0]> = {}) =>
  signToken({ key: CURRENT, url: URL_, body: BODY, ...overrides })

const request = (signature: string | undefined, extra: Partial<{ body: string | undefined, url: string, currentSigningKey: string, nextSigningKey: string }> = {}) => ({
  signature,
  body: BODY as string | undefined,
  url: URL_,
  currentSigningKey: CURRENT,
  nextSigningKey: NEXT,
  ...extra
})

/** A promise the test resolves by hand, to hold a Stripe call in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// --- 1. auth ----------------------------------------------------------------

describe('cron-sweep auth: only a valid QStash signature for the configured URL and the exact body runs the sweep', () => {
  let logs: string[]
  let makeDeps: ReturnType<typeof vi.fn>
  const saved: Record<string, string | undefined> = {}
  const ENV = ['QSTASH_DEV', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'QSTASH_REGION']

  beforeEach(() => {
    logs = []
    makeDeps = vi.fn((): SweepDeps => ({ redis: new FakeRedis(), log: msg => logs.push(msg) }))
    for (const k of ENV) saved[k] = process.env[k]
  })

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  const run = (req: ReturnType<typeof request>) => handleCronSweep(req, makeDeps as unknown as () => SweepDeps, { log: msg => logs.push(msg) })

  async function expectRefused(req: ReturnType<typeof request>, line: 'cron-sweep: not configured' | 'cron-sweep: signature rejected') {
    const result = await run(req)
    expect(result).toEqual({ status: 401, body: { message: 'Unauthorized' } })
    expect(makeDeps).not.toHaveBeenCalled()
    expect(logs).toEqual([line])
    return result
  }

  it('no signature: 401, no client built', async () => {
    await expectRefused(request(undefined), 'cron-sweep: signature rejected')
  })

  it('an empty signature: 401, no client built', async () => {
    await expectRefused(request(''), 'cron-sweep: signature rejected')
  })

  it('a token signed with a key that is neither configured key: 401', async () => {
    await expectRefused(request(await valid({ key: OTHER })), 'cron-sweep: signature rejected')
  })

  it.each([
    ['another host', 'https://evil.test/api/cron/sweep'],
    ['the configured URL plus a trailing slash', `${URL_}/`],
    ['the configured URL plus a query', `${URL_}?x=1`]
  ])('a token whose sub is %s: 401', async (_name, url) => {
    await expectRefused(request(await valid({ url })), 'cron-sweep: signature rejected')
  })

  it('a token over another body (one byte changed): 401', async () => {
    await expectRefused(request(await valid({ body: '{ }' })), 'cron-sweep: signature rejected')
  })

  it('an expired token: 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expectRefused(request(await valid({ iat: now - 600, nbf: now - 600, exp: now - 60 })), 'cron-sweep: signature rejected')
  })

  it('a token not yet valid (nbf in the future): 401', async () => {
    const now = Math.floor(Date.now() / 1000)
    await expectRefused(request(await valid({ nbf: now + 600, exp: now + 900 })), 'cron-sweep: signature rejected')
  })

  it('a token whose iss is not Upstash: 401', async () => {
    await expectRefused(request(await valid({ iss: 'NotUpstash' })), 'cron-sweep: signature rejected')
  })

  it('an empty configured URL: 401 "not configured", even for a token signed for the empty subject', async () => {
    await expectRefused(request(await valid({ url: '' }), { url: '' }), 'cron-sweep: not configured')
  })

  it('an empty current key: 401 "not configured"', async () => {
    await expectRefused(request(await valid({ key: NEXT }), { currentSigningKey: '' }), 'cron-sweep: not configured')
  })

  it('an empty next key: 401 "not configured"', async () => {
    await expectRefused(request(await valid(), { nextSigningKey: '' }), 'cron-sweep: not configured')
  })

  it('no SDK fallback: empty configured keys are refused even while the unprefixed QSTASH_* signing keys in the environment hold the right keys', async () => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = CURRENT
    process.env.QSTASH_NEXT_SIGNING_KEY = NEXT
    await expectRefused(request(await valid(), { currentSigningKey: '', nextSigningKey: '' }), 'cron-sweep: not configured')
    logs.length = 0
    await expectRefused(request(await valid(), { currentSigningKey: '' }), 'cron-sweep: not configured')
  })

  it('QSTASH_DEV=true never switches to the SDK public dev keys: a dev-key token gets 401, the configured key still gets 200', async () => {
    process.env.QSTASH_DEV = 'true'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expectRefused(request(await valid({ key: SDK_DEV_CURRENT })), 'cron-sweep: signature rejected')
    const ok = await run(request(await valid()))
    expect(ok.status).toBe(200)
    warn.mockRestore()
  })

  it('a valid token signed with the current key: 200 with numeric counts', async () => {
    const result = await run(request(await valid()))
    expect(result).toEqual({ status: 200, body: { ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 } } } })
    expect(makeDeps).toHaveBeenCalledTimes(1)
  })

  it('a valid token signed with the next key while the current key is configured passes (key roll)', async () => {
    const result = await run(request(await valid({ key: NEXT })))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
  })

  it('a token over the empty body passes when the raw body is undefined', async () => {
    const result = await run(request(await valid({ body: '' }), { body: undefined }))
    expect(result.status).toBe(200)
  })

  it('a 401 logs one fixed line and never the Receiver message, the token, the URL or the body', async () => {
    const token = await valid({ url: 'https://evil.test/api/cron/sweep' })
    const result = await run(request(token))
    expect(logs).toEqual(['cron-sweep: signature rejected'])
    const all = logs.join('\n') + JSON.stringify(result)
    for (const secret of [token, 'evil.test', URL_, 'invalid subject', 'body hash', 'want:']) {
      expect(all).not.toContain(secret)
    }
  })

  it('a deps factory that throws (Upstash unset) answers 503 with the fixed line "cron-sweep: setup failed"', async () => {
    makeDeps.mockImplementation(() => {
      throw new Error('Upstash Redis credentials not configured')
    })
    const result = await run(request(await valid()))
    expect(result).toEqual({ status: 503, body: { ok: false, steps: {} } })
    expect(logs).toEqual(['cron-sweep: setup failed'])
  })

  it('the route reads the upstash-signature header and the raw body, and takes the URL and both keys only from runtime config', () => {
    const src = readFileSync(new URL('../../server/api/cron/sweep.post.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/getHeader\(event, 'upstash-signature'\)/)
    expect(src).toMatch(/readRawBody\(event\)/)
    expect(src).toMatch(/useRuntimeConfig\(event\)/)
    expect(src).toMatch(/config\.cronSweepUrl/)
    expect(src).toMatch(/config\.qstashCurrentSigningKey/)
    expect(src).toMatch(/config\.qstashNextSigningKey/)
    expect(src).not.toMatch(/getRequestURL|getRequestHost|x-forwarded|authorization/i)
  })

  it('the Receiver is imported from the package root, never from a helper entry', () => {
    const src = readFileSync(new URL('../../server/utils/cron-sweep.ts', import.meta.url), 'utf8')
    expect(src.match(/from '@upstash\/qstash[^']*'/g)).toEqual(['from \'@upstash/qstash\''])
    expect(src).toMatch(/devMode: false/)
  })
})

// --- 2. the sweep -------------------------------------------------------------

describe('cron-sweep (tracer): a site failure on attempt 2 with the tab closed is stopped by the next QStash call, once', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let dispatch: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let deps: SweepDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue({ id: 'email_1' })
    dispatch = vi.fn().mockResolvedValue(RUN)
    logs = []
    clock = Date.parse('2026-11-08T10:30:00Z')
    deps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      // The app delete (23-37): a mocked dispatch, never GitHub.
      teardown: vi.fn().mockResolvedValue(undefined),
      dispatch,
      now: () => clock,
      log: msg => logs.push(msg)
    }
    await seed(redis, clock)
  })

  const callback = (attempt: number, status: string, extra: Record<string, unknown> = {}) =>
    handleProvisionCallback(bearer, { provision_id: PID, attempt, status, ...extra }, CONFIG, redis, deps)
  const failed = (attempt: number, source = 'workflow') =>
    callback(attempt, 'failed', { reason: 'deploy_timeout', source, app_uuid: APP_UUID })
  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)
  const due = () => redis.zrange(STOPS_INDEX, '-inf', '+inf', { byScore: true })
  const sweep = async () => {
    const token = await valid()
    return handleCronSweep(request(token), () => deps, { log: msg => logs.push(msg) })
  }

  /** Attempt 1 failed in the workflow, the free retry ran, then the site itself failed on attempt 2. */
  async function siteFailureOnAttempt2() {
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2, 'site')
  }

  it('tracer: indexed at provisionalUntil, untouched before the window passes, then settled, stopped once and removed', async () => {
    await siteFailureOnAttempt2()
    const until = clock + PROVISIONAL_MS
    expect(await redis.zrangebyscore(STOPS_INDEX, until, until)).toEqual([SID])

    // Before the window passes: nothing changes.
    const early = await sweep()
    expect(early).toEqual({ status: 200, body: { ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 } } } })
    expect(await state()).toMatchObject({ failedAttempts: 1, provisionalUntil: until })
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()

    clock = until + 1
    const result = await sweep()
    expect(result).toEqual({ status: 200, body: { ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 1, settled: 1, stopped: 1, cleared: 1, busy: 0, errors: 0 } } } })

    expect(await state()).toMatchObject({ failedAttempts: 2, stopped: true, canRetry: false })
    expect(await redis.exists(lockKey)).toBe(0)
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith(PAYMENT_METHOD, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.setupIntents.retrieve.mock.invocationCallOrder[0]).toBeLessThan(stripe.paymentMethods.detach.mock.invocationCallOrder[0]!)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1].headers['Idempotency-Key']).toBe(`stop-mail-${PID}`)
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
    expect(await redis.zcard('capacity:inflight')).toBe(0)
    expect(await redis.exists(`byok:${PID}`)).toBe(0)
    expect(await redis.exists(stoppingKey)).toBe(0)
    expect(await due()).toEqual([])
    expect(moneyCalls(stripe)).toBe(0)
  })

  it('a site failure on attempt 1 past its window is settled to the free retry: no Stripe or Resend call, member removed', async () => {
    await failed(1, 'site')
    clock += PROVISIONAL_MS + 1
    const result = await sweep()
    expect(result.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 1, settled: 1, stopped: 0, cleared: 1, busy: 0, errors: 0 } } })
    expect(await state()).toMatchObject({ status: 'failed', failedAttempts: 1, canRetry: true, provisionalUntil: 0 })
    expect(await redis.exists(lockKey)).toBe(0)
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await due()).toEqual([])
  })

  it('a ready inside the window clears it: the sweep after the window calls nothing and removes the member', async () => {
    await failed(1, 'site')
    expect(await callback(1, 'ready', { site_url: 'https://cascadia.localnodes.xyz', source: 'site' })).toEqual({ updated: true })
    clock += PROVISIONAL_MS + 1
    const result = await sweep()
    // The ready step itself left sweep:stops (23-43: readyAfterProvisional), so the stops step has nothing due.
    // The ready joined sweep:billing, and this describe wires no billing:
    // the billing step counts it as an error and keeps it (a missing wiring is never skipped silently).
    expect(result.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: { ...BILLING_ZERO, due: 1, errors: 1 }, stops: { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 } } })
    expect(await state()).toMatchObject({ status: 'ready', failedAttempts: 0 })
    expect(await redis.zrange(BILLING_INDEX, '-inf', '+inf', { byScore: true })).toEqual([SID])
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await due()).toEqual([])
  })

  it('a member whose provision hash has expired is removed and never stopped', async () => {
    await redis.zadd(STOPS_INDEX, { score: clock - 1, member: 'cs_test_gone' })
    const result = await sweep()
    expect(result.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 1, settled: 0, stopped: 0, cleared: 1, busy: 0, errors: 0 } } })
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(await due()).toEqual([])
  })

  it('a member whose state has a subscriptionId is removed and never stopped', async () => {
    await redis.hset(stateKey, { status: 'failed', failedAttempts: 2, countedAttempt: 2, attempt: 2, subscriptionId: 'sub_123' })
    await redis.zadd(STOPS_INDEX, { score: clock - 1, member: SID })
    const result = await sweep()
    expect(result.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 1, settled: 0, stopped: 0, cleared: 1, busy: 0, errors: 0 } } })
    expect(await state()).not.toHaveProperty('stopped')
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await due()).toEqual([])
  })

  it('a stop cut short (the Resend fetch throws once) moves from sweep:stops to sweep:teardown; the teardowns step sends the mail, detaches nothing again and clears it', async () => {
    await siteFailureOnAttempt2()
    fetchMock.mockRejectedValueOnce(new Error('Resend 500'))
    clock += PROVISIONAL_MS + 1
    const first = await sweep()
    // 23-43 Task 2: the stop's first step moved it to tearing_down and sweep:teardown; the same sweep's teardowns step finishes it.
    expect(first.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: { ...TEARDOWNS_ZERO, due: 1, tornDown: 1 }, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 1, settled: 1, stopped: 0, cleared: 0, busy: 0, errors: 0 } } })
    expect(await state()).toMatchObject({ status: 'tearing_down', stopped: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(await due()).toEqual([])
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('a workflow-failure stop that scheduleStop started and that was cut short waits in sweep:teardown with score now; the next sweep finishes it', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Resend 500'))
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2)
    expect(await state()).not.toHaveProperty('stopped')
    expect(await due()).toEqual([])
    expect(await redis.zrangebyscore(TEARDOWN_INDEX, clock, clock)).toEqual([SID])

    clock += 5 * 60 * 1000
    const result = await sweep()
    expect(result.body).toEqual({ ok: true, steps: { held: HELD_ZERO, teardowns: { ...TEARDOWNS_ZERO, due: 1, tornDown: 1 }, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 } } })
    expect(await state()).toMatchObject({ stopped: true })
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('race: a status read and the sweep at the same moment give one detach and one mail', async () => {
    await siteFailureOnAttempt2()
    clock += PROVISIONAL_MS + 1
    const held = deferred<{ payment_method: string }>()
    stripe.setupIntents.retrieve.mockImplementation(() => held.promise)

    let sweepDone = false
    const read = handleProvisionStatus(SID, redis, { now: () => clock, stripe: () => stripe, mail: deps.mail, teardown: deps.teardown, log: deps.log })
    const swept = sweep().finally(() => {
      sweepDone = true
    })
    // Both runners are in flight before the held Stripe call returns: the
    // sweep has finished (it found the stop busy), or a second retrieve came.
    await vi.waitFor(() => {
      if (!sweepDone && stripe.setupIntents.retrieve.mock.calls.length < 2) throw new Error('waiting for both runners')
    }, { timeout: 5000, interval: 5 })
    held.resolve({ payment_method: PAYMENT_METHOD })
    await Promise.all([read, swept])

    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ failedAttempts: 2, stopped: true })
    if ((await due()).length) await sweep()
    expect(await due()).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('race: two sweeps at once give one detach and one mail', async () => {
    await siteFailureOnAttempt2()
    clock += PROVISIONAL_MS + 1
    const held = deferred<{ payment_method: string }>()
    stripe.setupIntents.retrieve.mockImplementation(() => held.promise)

    let done = 0
    const a = sweep().finally(() => {
      done++
    })
    const b = sweep().finally(() => {
      done++
    })
    await vi.waitFor(() => {
      if (done < 1 && stripe.setupIntents.retrieve.mock.calls.length < 2) throw new Error('waiting for both runners')
    }, { timeout: 5000, interval: 5 })
    held.resolve({ payment_method: PAYMENT_METHOD })
    const results = await Promise.all([a, b])

    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ failedAttempts: 2, stopped: true })
    const counts = results.map(r => (r.body as { steps: { stops: { stopped: number } } }).steps.stops.stopped)
    expect(counts.reduce((x, y) => x + y, 0)).toBe(1)
    expect(await due()).toEqual([])
  })

  it('two stopProvision calls at once: the second returns { stopped: false } with no Stripe or Resend call; the lock is gone afterwards', async () => {
    await failed(1)
    await retryProvisioning(SID, deps)
    await redis.hset(stateKey, { status: 'failed', failedAttempts: 2, countedAttempt: 2, canRetry: false })
    const held = deferred<{ payment_method: string }>()
    stripe.setupIntents.retrieve.mockImplementation(() => held.promise)

    const first = stopProvision(SID, deps)
    await vi.waitFor(() => {
      if (stripe.setupIntents.retrieve.mock.calls.length < 1) throw new Error('waiting')
    }, { timeout: 5000, interval: 5 })
    const second = await stopProvision(SID, deps)
    expect(second).toEqual({ stopped: false })
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    held.resolve({ payment_method: PAYMENT_METHOD })
    expect(await first).toEqual({ stopped: true })
    expect(await redis.exists(stoppingKey)).toBe(0)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bound: 60 due members give due 50 on the first run, oldest score first; members with a future score are never read', async () => {
    const reads: string[] = []
    const hgetall = redis.hgetall.bind(redis)
    redis.hgetall = (async (key: string) => {
      reads.push(key)
      return hgetall(key)
    }) as typeof redis.hgetall
    const zrange = vi.spyOn(redis, 'zrange')
    const pad = (n: number) => String(n).padStart(2, '0')
    for (let i = 60; i >= 1; i--) await redis.zadd(STOPS_INDEX, { score: clock - 100_000 + i, member: `cs_due_${pad(i)}` })
    await redis.zadd(STOPS_INDEX, { score: clock + 60_000, member: 'cs_future' })

    const result = await sweep()
    expect(SWEEP_LIMIT).toBe(50)
    expect(result.body).toMatchObject({ ok: true, steps: { stops: { due: 50, cleared: 50, errors: 0 } } })
    // One bounded read of sweep:stops (the billing step reads sweep:billing once, separately; 23-32).
    expect(zrange.mock.calls.filter(c => c[0] === STOPS_INDEX)).toHaveLength(1)
    expect(zrange).toHaveBeenCalledWith(STOPS_INDEX, '-inf', clock, { byScore: true, offset: 0, count: 50 })
    expect(reads).toEqual(Array.from({ length: 50 }, (_, i) => `provision:cs_due_${pad(i + 1)}`))
    expect(reads).not.toContain('provision:cs_future')
    expect(await due()).toEqual([...Array.from({ length: 10 }, (_, i) => `cs_due_${pad(i + 51)}`), 'cs_future'])
  })

  it('a record whose processing throws counts in errors and stays; the run goes on to the next record', async () => {
    await redis.zadd(STOPS_INDEX, { score: clock - 2, member: 'cs_test_broken' })
    await redis.zadd(STOPS_INDEX, { score: clock - 1, member: 'cs_test_gone' })
    const hgetall = redis.hgetall.bind(redis)
    redis.hgetall = (async (key: string) => {
      if (key === 'provision:cs_test_broken') throw new Error('upstash timeout')
      return hgetall(key)
    }) as typeof redis.hgetall
    const result = await sweep()
    expect(result).toEqual({ status: 200, body: { ok: true, steps: { held: HELD_ZERO, teardowns: TEARDOWNS_ZERO, refunds: REFUNDS_ZERO, billing: BILLING_ZERO, stops: { due: 2, settled: 0, stopped: 0, cleared: 1, busy: 0, errors: 1 } } } })
    expect(await due()).toEqual(['cs_test_broken'])
  })

  it('a zrange that throws answers 503 with every step { error: true }', async () => {
    redis.zrange = (async () => {
      throw new Error('upstash down')
    }) as typeof redis.zrange
    const result = await sweep()
    expect(result).toEqual({ status: 503, body: { ok: false, steps: { stops: { error: true }, held: { error: true }, billing: { error: true }, refunds: { error: true }, teardowns: { error: true } } } })
  })

  it('count-only logs: no session id, provision id or email in any log line or the reply; the D-18 line names only the Coolify app', async () => {
    const console_ = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})]
    await siteFailureOnAttempt2()
    // A second member whose hash is gone: the run settles, stops and clears.
    await redis.zadd(STOPS_INDEX, { score: clock - 1, member: 'cs_test_gone' })
    logs.length = 0
    clock += PROVISIONAL_MS + 1
    const result = await sweep()
    expect(result.body).toMatchObject({ ok: true, steps: { stops: { settled: 1, stopped: 1, cleared: 2 } } })

    const consoleLines = console_.flatMap(spy => spy.mock.calls.map(c => c.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
    const everything = [...logs, ...consoleLines, JSON.stringify(result)].join('\n')
    for (const canary of [SID, PID, EMAIL, 'cs_test_gone', SETUP_INTENT, PAYMENT_METHOD]) {
      expect(everything).not.toContain(canary)
    }
    const withId = logs.filter(l => l.includes(APP_UUID))
    expect(withId).toEqual([`retry-stop: stopped (build_failed); teardown requested for Coolify app ${APP_UUID}`])
    expect(logs).toContain('cron-sweep: stops due=2 settled=1 stopped=1 cleared=2 busy=0 errors=0')
    console_.forEach(spy => spy.mockRestore())
  })
})

// --- 3. the step list -------------------------------------------------------------

describe('cron-sweep step list', () => {
  it('CRON_STEPS starts with stops', () => {
    expect(CRON_STEPS[0]!.name).toBe('stops')
  })

  it('CRON_STEPS is [stops, held, billing, refunds, teardowns] (23-32 billing; 23-37 held second, teardowns last; 23-43 refunds fourth)', () => {
    expect(CRON_STEPS.map(s => s.name)).toEqual(['stops', 'held', 'billing', 'refunds', 'teardowns'])
  })

  it('the route\'s factory carries the stop deps (makeStopDeps: the invite secret, the app delete, the paid path)', () => {
    const src = readFileSync(new URL('../../server/api/cron/sweep.post.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/\.\.\.makeStopDeps\(config\)/)
  })

  it('no Vercel cron and no second schedule: no vercel.json, no crons in nuxt.config.ts', () => {
    expect(existsSync(new URL('../../vercel.json', import.meta.url))).toBe(false)
    expect(readFileSync(new URL('../../nuxt.config.ts', import.meta.url), 'utf8')).not.toMatch(/crons/)
  })

  it('the billing step charges and activates a due ready sign-up through the signed route, and logs counts only', async () => {
    const redis = new FakeRedis()
    const logs: string[] = []
    const SID_B = 'cs_test_billing_step'
    const PID_B = 'Bb0000000000000000000b'
    await redis.set(`provision:by-id:${PID_B}`, SID_B, { ex: 86400 })
    await redis.hset(`provision:${SID_B}`, { status: 'ready', subdomain: 'cascadia', provisionId: PID_B, attempt: 1, siteAnsweredAt: 'x' })
    await redis.hset(`signup:${PID_B}`, { stripeCustomerId: 'cus_b', setupIntentId: 'seti_b', inviteId: 'inv_b', email: EMAIL, priceId: 'price_b' })
    await redis.zadd(BILLING_INDEX, { score: 1, member: SID_B })
    const billingStripe = {
      setupIntents: { retrieve: vi.fn().mockResolvedValue({ status: 'succeeded', payment_method: 'pm_b' }) },
      subscriptions: { create: vi.fn().mockResolvedValue({ id: 'sub_b', created: 1, latest_invoice: { id: 'in_b', status: 'open' } }), list: vi.fn().mockResolvedValue({ data: [] }) },
      invoices: { pay: vi.fn().mockResolvedValue({ id: 'in_b', status: 'paid' }), retrieve: vi.fn() }
    }
    const billing: BillingDeps = {
      redis,
      stripe: () => billingStripe,
      fetch: vi.fn().mockResolvedValue({ status: 200, json: async () => ({ activated: true }) }),
      callbackSecret: SECRET,
      sleep: async () => {},
      log: msg => logs.push(msg)
    }
    const result = await handleCronSweep(request(await valid()), () => ({ redis, billing, log: msg => logs.push(msg) }), { log: msg => logs.push(msg) })
    expect(result.body).toEqual({ ok: true, steps: { stops: { due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 }, held: HELD_ZERO, billing: { due: 1, charged: 0, held: 0, declined: 0, pending: 0, activated: 1, busy: 0, errors: 0, refundStarted: 0, refundBusy: 0 }, refunds: REFUNDS_ZERO, teardowns: TEARDOWNS_ZERO } })
    expect((await redis.hgetall<Record<string, unknown>>(`provision:${SID_B}`))?.status).toBe('complete')
    expect(logs).toContain('cron-sweep: billing due=1 charged=0 held=0 declined=0 pending=0 activated=1 busy=0 errors=0 refundStarted=0 refundBusy=0')
    for (const canary of [SID_B, PID_B, 'sub_b', 'in_b', 'cus_b', EMAIL]) expect(logs.join('\n')).not.toContain(canary)
  })

  it('the route builds the billing deps in its factory with makeBillingDeps and no keepAlive (the sweep awaits)', () => {
    const src = readFileSync(new URL('../../server/api/cron/sweep.post.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/billing: makeBillingDeps\(config\)\.deps/)
  })

  it('runCronSteps runs every step in order; a step that throws reports error and the next still runs', async () => {
    const order: string[] = []
    const steps = [
      { name: 'first', run: async () => { order.push('first'); throw new Error('boom') } },
      { name: 'second', run: async () => { order.push('second'); return { n: 1 } } }
    ]
    const result = await runCronSteps({ redis: new FakeRedis() } as SweepDeps, steps)
    expect(order).toEqual(['first', 'second'])
    expect(result).toEqual({ first: { error: true }, second: { n: 1 } })
  })

  it.each(['ready', 'held', 'declined', 'complete', 'refunding', 'refunded', 'tearing_down', 'torn_down'])('a %s sign-up in sweep:stops is never counted as a failure, never stopped, and leaves the set through CLEAR_INDEX_SCRIPT', async (status) => {
    const redis = new FakeRedis()
    const sid = 'cs_test_stops_other'
    await redis.hset(`provision:${sid}`, { status, provisionId: 'St0ps00000000000000000', attempt: 2, failedAttempts: 2, countedAttempt: 1, provisionalUntil: 1, teardownReason: 'build_failed' })
    await redis.zadd(STOPS_INDEX, { score: 1, member: sid })
    const evals = vi.spyOn(redis, 'eval')
    const stopStripe = makeStripe()
    const counts = await sweepStops({ redis, stripe: () => stopStripe, mail: { apiKey: 'k', from: 'f', fetch: vi.fn() }, teardown: vi.fn(), now: () => 10 })
    expect(counts).toEqual({ due: 1, settled: 0, stopped: 0, cleared: 1, busy: 0, errors: 0 })
    expect(await redis.hgetall(`provision:${sid}`)).toMatchObject({ status, failedAttempts: 2 })
    expect(stopStripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(await redis.zrange(STOPS_INDEX, 0, -1)).toEqual([])
    // The removal was the compare-and-remove script (keys: the record, sweep:stops), never a bare ZREM.
    expect(evals.mock.calls.some(c => (c[1] as string[])[1] === STOPS_INDEX)).toBe(true)
  })

  it('sweepStops with an empty index reports zeros', async () => {
    expect(await sweepStops({ redis: new FakeRedis(), now: () => 1 })).toEqual({ due: 0, settled: 0, stopped: 0, cleared: 0, busy: 0, errors: 0 })
  })
})

// --- 4. registration -------------------------------------------------------------

describe('cron-sweep route registration', () => {
  it('/api/cron/sweep is not gated: it passes while closed and uninvited', () => {
    expect(GATED_API).not.toContain('/api/cron/sweep')
    expect(gateDecision('/api/cron/sweep', false)).toBe('pass')
  })
})
