import { describe, it, expect, beforeEach, vi } from 'vitest'
import Stripe from 'stripe'
import {
  ACTIVATION_WINDOW_MS,
  BILLING_INDEX,
  HELD_INDEX,
  HOLD_WINDOW_SECONDS,
  TEARDOWN_INDEX,
  activateSite,
  chargeAtReady,
  classifyPayError,
  nudgeBilling,
  onFirstInvoicePaid,
  probeSite,
  resumeBilling,
  startBilling,
  subscriptionParams,
  sweepBilling,
  type BillingDeps
} from '../../server/utils/billing'
import { REARM_SCRIPT, rearmScriptTwin } from '../../server/utils/promo'
import { callbackToken, handleProvisionStatus } from '../../server/utils/provision-handlers'
import { stopProvision } from '../../server/utils/retry-stop'
import { FakeRedis } from './helpers/fake-redis'
import { TRANSITION_SCRIPT } from '../../server/utils/lifecycle'

/**
 * B-1, the first payment at ready (Phase 23, plan 23-32; ONB-01, ONB-02,
 * ONB-04; 23-RULINGS-1108.md "Billing rules" and the afternoon answers).
 *
 * Task 1 (the tracer): a ready site starts the subscription with the card saved
 * at checkout, the first invoice is paid off-session, subscriptionId is written
 * only then, the code hold is released, the new site's /localnodes/activate
 * (the 23-35 contract) answers 200 and only then is the status complete.
 *
 * Fakes only: FakeRedis, a Stripe mock (errors are the SDK's own classes, built
 * locally), and a mocked fetch for the site. No network.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const SID = 'cs_test_billing'
const PID = 'B1lLiNg0000000000000Aa'
const CUSTOMER = 'cus_1'
const SETUP_INTENT = 'seti_1'
const PM = 'pm_1'
const PROMO = 'promo_1'
const INVITE = 'inv_1'
const SUB = 'sub_1'
const INVOICE = 'in_1'
const PRICE = 'price_1'
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_secret_canary'
const EMAIL = 'organizer@example.org'
/** 2026-11-08T12:00:00Z, unix seconds. */
const CREATED = 1794225600

const stateKey = `provision:${SID}`
const signupKey = `signup:${PID}`
const lockKey = `provision:${SID}:lifecycle`
/** 23-43: every Stripe call under the lease carries these request options. */
const OPTS = { timeout: 15000, maxNetworkRetries: 0 }

function makeStripe() {
  return {
    setupIntents: { retrieve: vi.fn().mockResolvedValue({ id: SETUP_INTENT, status: 'succeeded', payment_method: PM }) },
    subscriptions: {
      create: vi.fn().mockResolvedValue({
        id: SUB,
        created: CREATED,
        status: 'incomplete',
        metadata: { provision_id: PID },
        latest_invoice: { id: INVOICE, status: 'open' }
      }),
      list: vi.fn().mockResolvedValue({ data: [] }),
      // Never called by this plan: cancelling belongs to 23-37's teardown.
      cancel: vi.fn()
    },
    invoices: {
      pay: vi.fn().mockResolvedValue({ id: INVOICE, status: 'paid' }),
      retrieve: vi.fn().mockResolvedValue({ id: INVOICE, status: 'open', hosted_invoice_url: HOSTED }),
      voidInvoice: vi.fn()
    },
    paymentMethods: { detach: vi.fn() }
  }
}

type StripeMock = ReturnType<typeof makeStripe>

function activatedReply(status = 200, body: unknown = { activated: true }) {
  return { status, json: async () => body }
}

async function seedReady(redis: FakeRedis, opts: { promo?: boolean, extra?: Record<string, unknown>, now?: number } = {}) {
  const promo = opts.promo ?? true
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
  await redis.hset(stateKey, {
    status: 'ready',
    subdomain: 'cascadia',
    siteUrl: 'https://cascadia.localnodes.xyz',
    provisionId: PID,
    attempt: 1,
    failedAttempts: 0,
    startedAt: '2026-11-08T11:50:00Z',
    updatedAt: '2026-11-08T12:00:00Z',
    // 23-43 Task 6: the site already answered the probe; the probe tests clear it.
    siteAnsweredAt: '2026-11-08T11:59:00Z',
    ...opts.extra
  })
  await redis.hset(signupKey, {
    subdomain: 'cascadia',
    communityName: 'Cascadia Reading Group',
    email: EMAIL,
    inviteId: INVITE,
    stripeCustomerId: CUSTOMER,
    setupIntentId: SETUP_INTENT,
    // 23-43 Task 3: the price frozen at checkout.
    priceId: PRICE,
    ...(promo ? { promoId: PROMO } : {})
  })
  // 23-43: lifetimes are only ever raised; real records always carry one (24 h at checkout and at the build).
  await redis.expire(stateKey, 86400)
  await redis.expire(signupKey, 86400)
  if (promo) await redis.zadd(`promo:holds:${PROMO}`, { score: Math.floor((opts.now ?? Date.now()) / 1000) + 7800, member: INVITE })
  await redis.zadd(BILLING_INDEX, { score: opts.now ?? 0, member: SID })
}

describe('billing (tracer): ready → subscription → first invoice paid → activated → complete', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let sleep: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let deps: BillingDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue(activatedReply())
    sleep = vi.fn(async () => {})
    logs = []
    clock = CREATED * 1000
    deps = {
      redis,
      stripe: () => stripe,
      fetch: fetchMock,
      callbackSecret: SECRET,
      now: () => clock,
      sleep,
      log: msg => logs.push(msg)
    }
    await seedReady(redis, { now: clock })
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  it('creates the subscription once with exactly the B-1 params and the key subscribe:{provisionId}:{subscribeAttempt}, attempt 1', async () => {
    await chargeAtReady(SID, deps)
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.create).toHaveBeenCalledWith(
      {
        customer: CUSTOMER,
        items: [{ price: PRICE }],
        default_payment_method: PM,
        discounts: [{ promotion_code: PROMO }],
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata: { provision_id: PID, subdomain: 'cascadia', invite_id: INVITE },
        expand: ['latest_invoice']
      },
      { idempotencyKey: `subscribe:${PID}:1`, ...OPTS }
    )
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledWith(SETUP_INTENT, {}, OPTS)
  })

  it('without a code the params have no discounts key', async () => {
    await redis.del(signupKey)
    await seedReady(redis, { promo: false, now: clock })
    await chargeAtReady(SID, deps)
    const params = stripe.subscriptions.create.mock.calls[0]![0] as Record<string, unknown>
    expect(params).not.toHaveProperty('discounts')
    expect(subscriptionParams({ customer: CUSTOMER, paymentMethod: PM, price: PRICE, metadata: { provision_id: PID } })).not.toHaveProperty('discounts')
  })

  it('writes pendingSubscriptionId, invoiceId and subscriptionCreatedAt before invoices.pay, and not subscriptionId', async () => {
    let atPay: Record<string, unknown> | null = null
    stripe.invoices.pay.mockImplementation(async () => {
      atPay = await state()
      return { id: INVOICE, status: 'paid' }
    })
    await chargeAtReady(SID, deps)
    expect(atPay).toMatchObject({ pendingSubscriptionId: SUB, invoiceId: INVOICE, subscriptionCreatedAt: CREATED, billing: 'charging' })
    expect(atPay).not.toHaveProperty('subscriptionId')
    expect(stripe.subscriptions.create.mock.invocationCallOrder[0]!).toBeLessThan(stripe.invoices.pay.mock.invocationCallOrder[0]!)
  })

  it('pays the first invoice once, off-session with the saved card and the key pay:{provisionId}:{payAttempt}, attempt 1; paid: subscriptionId, billing paid, paidAt, code hold released', async () => {
    await chargeAtReady(SID, deps)
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect(stripe.invoices.pay).toHaveBeenCalledWith(INVOICE, { off_session: true, payment_method: PM }, { idempotencyKey: `pay:${PID}:1`, ...OPTS })
    const s = await state()
    expect(s).toMatchObject({ subscriptionId: SUB, billing: 'paid' })
    expect(typeof s?.paidAt).toBe('string')
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
  })

  it('a first invoice already paid at creation (a 100%-off pilot) makes no pay call and takes the paid path', async () => {
    stripe.subscriptions.create.mockResolvedValue({
      id: SUB, created: CREATED, status: 'active', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'paid' }
    })
    await chargeAtReady(SID, deps)
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ subscriptionId: SUB, billing: 'paid', status: 'complete' })
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
  })

  it('activateSite POSTs /localnodes/activate with the per-provision bearer, JSON, a User-Agent, redirect manual and an abort signal (its 15 s total deadline: lifecycle.test.ts H1)', async () => {
    await chargeAtReady(SID, deps)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as [string, Record<string, any>]
    expect(url).toBe('https://cascadia.localnodes.xyz/localnodes/activate')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Authorization': `Bearer ${callbackToken(SECRET, PID)}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LocalNodes-Onboarding/1 (activate)'
    })
    expect(JSON.parse(init.body)).toEqual({ provision_id: PID })
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('on 200 {activated: true} the status is complete with activatedAt, and the member leaves sweep:billing', async () => {
    expect(await chargeAtReady(SID, deps)).toBe('activated')
    const s = await state()
    expect(s).toMatchObject({ status: 'complete', billing: 'paid' })
    expect(typeof s?.activatedAt).toBe('string')
    expect(await redis.zrange(BILLING_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('complete is not written before the site answers 200 {activated: true}: tries at 0, 5, 10, 20 and 30 s', async () => {
    const seen: unknown[] = []
    fetchMock
      .mockImplementationOnce(async () => { seen.push((await state())?.status); throw new TypeError('fetch failed') })
      .mockImplementationOnce(async () => { seen.push((await state())?.status); return activatedReply(503, { error: 'mail_failed' }) })
      .mockImplementationOnce(async () => { seen.push((await state())?.status); return activatedReply(409, { error: 'not_ready' }) })
      .mockImplementationOnce(async () => { seen.push((await state())?.status); return activatedReply(200, { activated: false }) })
      .mockImplementationOnce(async () => { seen.push((await state())?.status); return activatedReply(200, { activated: true }) })
    expect(await chargeAtReady(SID, deps)).toBe('activated')
    expect(seen).toEqual(['ready', 'ready', 'ready', 'ready', 'ready'])
    expect(sleep.mock.calls.map(c => c[0])).toEqual([5000, 10000, 20000, 30000])
    expect(await state()).toMatchObject({ status: 'complete' })
  })

  it('five unanswered tries leave the sign-up ready and paid, count the tries, and rescore the member a minute ahead', async () => {
    fetchMock.mockResolvedValue(activatedReply(502, 'Bad gateway'))
    expect(await chargeAtReady(SID, deps)).toBe('paid')
    const s = await state()
    expect(s).toMatchObject({ status: 'ready', billing: 'paid', activationTries: 5 })
    expect(s).not.toHaveProperty('activatedAt')
    expect(await redis.zrangebyscore(BILLING_INDEX, clock + 60000, clock + 60000)).toEqual([SID])
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('a 200 whose body is not JSON is not an activation', async () => {
    fetchMock.mockResolvedValue({ status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
    await chargeAtReady(SID, deps)
    expect((await state())?.status).toBe('ready')
  })

  it('resumeBilling with billing paid and no activatedAt tries the activation only, with no Stripe call', async () => {
    fetchMock.mockResolvedValue(activatedReply(503))
    await chargeAtReady(SID, deps)
    stripe.subscriptions.create.mockClear()
    stripe.invoices.pay.mockClear()
    stripe.setupIntents.retrieve.mockClear()
    fetchMock.mockResolvedValue(activatedReply())
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect((await state())?.status).toBe('complete')
  })

  it('the status reply keeps its seven keys, plus the pilot flag, and shows ready while charging; no ids, billing fields or hosted invoice URL', async () => {
    await redis.hset(stateKey, { billing: 'charging', pendingSubscriptionId: SUB, invoiceId: INVOICE, subscriptionCreatedAt: CREATED, billingTries: 1 })
    await redis.hset(signupKey, { hostedInvoiceUrl: HOSTED })
    const reply = await handleProvisionStatus(SID, redis)
    expect(Object.keys(reply).sort()).toEqual(['attempt', 'canRetry', 'pilot', 'reason', 'siteUrl', 'startedAt', 'status', 'stopped'])
    expect(reply.status).toBe('ready')
    const text = JSON.stringify(reply)
    for (const secret of [SUB, INVOICE, HOSTED, CUSTOMER, PM, 'charging', 'billing']) expect(text).not.toContain(secret)
  })

  it('two chargeAtReady calls at once give one create, one pay and one activation: the second finds the lock taken', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    stripe.subscriptions.create.mockImplementation(async () => {
      await gate
      return { id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
    })
    const first = chargeAtReady(SID, deps)
    // Let the first runner take the lock and reach the create.
    await vi.waitFor(() => expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1))
    const secondRun = chargeAtReady(SID, deps)
    // Give the second runner time to reach its lock check (and, without a lock, the create).
    await new Promise(r => setTimeout(r, 5))
    release()
    const [one, two] = await Promise.all([first, secondRun])
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(one).toBe('activated')
    expect(two).toBe('busy')
  })

  it('the lifecycle lock (23-43) is SET NX PX 60000 with a token and freed only by its holder', async () => {
    const setSpy = vi.spyOn(redis, 'set')
    await chargeAtReady(SID, deps)
    const lockCall = setSpy.mock.calls.find(c => c[0] === lockKey)!
    expect(lockCall[2]).toEqual({ nx: true, px: 60000 })
    expect(String(lockCall[1])).toMatch(/^[0-9a-f-]{36}$/)
    expect(await redis.exists(lockKey)).toBe(0)

    // A lock that expired and was taken by another runner is left alone.
    const other = { ...deps }
    stripe.subscriptions.create.mockImplementation(async () => {
      await redis.set(lockKey, 'someone-else', { px: 60000 })
      return { id: SUB, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
    })
    await redis.del(stateKey)
    await seedReady(redis, { now: clock })
    await chargeAtReady(SID, other)
    expect(await redis.get(lockKey)).toBe('someone-else')
  })

  it('acts only on a sign-up in ready with billing unset or charging', async () => {
    await redis.hset(stateKey, { status: 'complete' })
    expect(await chargeAtReady(SID, deps)).toBe('skipped')
    await redis.hset(stateKey, { status: 'ready', billing: 'paid' })
    fetchMock.mockClear()
    expect(await chargeAtReady(SID, deps)).toBe('skipped')
    await redis.hset(stateKey, { status: 'installing', billing: '' })
    expect(await chargeAtReady(SID, deps)).toBe('skipped')
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a SetupIntent that did not succeed, or has no card, is billing rejected with billingError no_card and no create', async () => {
    stripe.setupIntents.retrieve.mockResolvedValue({ id: SETUP_INTENT, status: 'requires_payment_method', payment_method: null })
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(await state()).toMatchObject({ status: 'ready', billing: 'rejected', billingError: 'no_card' })
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(await redis.zrange(BILLING_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('an error while paying leaves billing pending, no subscriptionId, and the sign-up is not yet a paying customer for stopProvision', async () => {
    stripe.invoices.pay.mockRejectedValue(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    const s = await state()
    expect(s).toMatchObject({ status: 'ready', billing: 'pending', pendingSubscriptionId: SUB })
    expect(s).not.toHaveProperty('subscriptionId')
    expect(fetchMock).not.toHaveBeenCalled()
    // 23-43 Task 2 (HIGH 3): a stop runs only from a build that failed twice, a declined payment or a teardown already
    // under way; a ready sign-up whose charge is pending is never stopped, whatever its subscription fields say.
    const stopStripe = { setupIntents: { retrieve: vi.fn().mockResolvedValue({ payment_method: PM }) }, paymentMethods: { detach: vi.fn().mockResolvedValue({}) } }
    const out = await stopProvision(SID, {
      redis,
      stripe: () => stopStripe,
      mail: { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', fetch: vi.fn().mockResolvedValue({ id: 'e1' }) },
      // The app delete (23-37): a mocked dispatch, never GitHub.
      teardown: vi.fn().mockResolvedValue(undefined),
      log: () => {}
    })
    expect(out).toEqual({ stopped: false })
    expect(stopStripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('log lines carry fixed words, a Stripe error type and code and an HTTP status only: never an id, the email, the token or the hosted URL', async () => {
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: `boom for ${CUSTOMER} ${SUB}`, code: 'api_error' }))
    await chargeAtReady(SID, deps)
    fetchMock.mockResolvedValue(activatedReply(503))
    await redis.hset(stateKey, { billing: 'paid', pendingSubscriptionId: SUB, subscriptionId: SUB })
    await resumeBilling(SID, deps)
    expect(logs.length).toBeGreaterThan(0)
    const text = logs.join('\n')
    for (const secret of [SID, PID, CUSTOMER, SUB, INVOICE, PM, PROMO, INVITE, EMAIL, HOSTED, callbackToken(SECRET, PID), 'boom']) {
      expect(text).not.toContain(secret)
    }
    expect(logs).toContain('billing: activation answered 503')
  })

  it('activateSite refuses a subdomain that is not a DNS label, with no request', async () => {
    const out = await activateSite({ subdomain: 'evil.com/x?', provisionId: PID }, deps)
    expect(out).toBe('retry')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the 30-try cap is gone: activation is retried for ACTIVATION_WINDOW_MS (24 hours) after paidAt', () => {
    expect(ACTIVATION_WINDOW_MS).toBe(86400000)
  })
})

describe('startBilling: through keepAlive when given, awaited otherwise', () => {
  it('with keepAlive the call returns before the charge ends and keepAlive holds the work', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    const stripe = makeStripe()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    stripe.setupIntents.retrieve.mockImplementation(async () => { await gate; return { id: SETUP_INTENT, status: 'succeeded', payment_method: PM } })
    const kept: Promise<void>[] = []
    const deps: BillingDeps = { redis, stripe: () => stripe, fetch: vi.fn().mockResolvedValue(activatedReply()), callbackSecret: SECRET, sleep: async () => {}, log: () => {} }
    await startBilling(SID, deps, work => { kept.push(work) })
    expect(kept).toHaveLength(1)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    release()
    await kept[0]
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
  })

  it('without keepAlive the charge is awaited, and a throw is logged, never raised', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    const stripe = makeStripe()
    const logs: string[] = []
    const deps: BillingDeps = { redis, stripe: () => stripe, fetch: vi.fn().mockResolvedValue(activatedReply()), callbackSecret: SECRET, sleep: async () => {}, log: m => logs.push(m) }
    await startBilling(SID, deps)
    expect((await redis.hgetall<Record<string, unknown>>(stateKey))?.status).toBe('complete')
    const brokenRedis = Object.assign(Object.create(redis), { set: async () => { throw new Error('upstash down') } })
    const broken: BillingDeps = { ...deps, redis: brokenRedis }
    await expect(startBilling(SID, broken)).resolves.toBeUndefined()
    expect(logs).toContain('billing: charge not finished, the next trigger resumes it')
  })
})

// --- Task 2: every other outcome, retries without doubles, the sweep -------------

const cardError = (code: string, extra: Record<string, unknown> = {}) =>
  new Stripe.errors.StripeCardError({ message: 'Your card was declined.', code, statusCode: 402, ...extra })

describe('billing: the other outcomes of the first payment (B-1 steps 4 to 6)', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let onDeclined: ReturnType<typeof vi.fn>
  let onHeld: ReturnType<typeof vi.fn>
  let deps: BillingDeps
  /** Subscriptions as Stripe holds them: a create that "succeeded" on Stripe's side lands here even when the reply was lost. */
  let stripeSide: Array<Record<string, unknown>>

  beforeEach(async () => {
    redis = new FakeRedis()
    // The promo hold's re-arm runs a Lua script: FakeRedis takes its JavaScript twin over FakeRedis's own zset.
    redis.onEval(REARM_SCRIPT, async (keys, args) => {
      await redis.zadd(keys[0]!, { score: Number(args[0]), member: String(args[1]) })
      return rearmScriptTwin(new Map(), args)
    })
    stripe = makeStripe()
    stripeSide = []
    stripe.subscriptions.create.mockImplementation(async () => {
      const sub = { id: `sub_${stripeSide.length + 1}`, created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }
      stripeSide.push(sub)
      return sub
    })
    stripe.subscriptions.list.mockImplementation(async () => ({ data: stripeSide }))
    fetchMock = vi.fn().mockResolvedValue(activatedReply())
    logs = []
    clock = CREATED * 1000 + 5000
    onDeclined = vi.fn(async () => {})
    onHeld = vi.fn(async () => {})
    deps = {
      redis,
      stripe: () => stripe,
      fetch: fetchMock,
      callbackSecret: SECRET,
      now: () => clock,
      sleep: async () => {},
      log: msg => logs.push(msg),
      onDeclined,
      onHeld
    }
    await seedReady(redis, { now: clock })
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)
  const members = (key: string) => redis.zrange(key, '-inf', '+inf', { byScore: true })
  const ttls = async () => [await redis.ttl(stateKey), await redis.ttl(`provision:by-id:${PID}`), await redis.ttl(signupKey)]

  it.each(['card_declined', 'insufficient_funds', 'expired_card'])('declined (%s): status declined, teardownReason declined, in sweep:teardown, out of sweep:billing, onDeclined once, no activation, 72-hour life', async (code) => {
    stripe.invoices.pay.mockRejectedValue(cardError(code === 'card_declined' ? 'card_declined' : code, { decline_code: code }))
    expect(await chargeAtReady(SID, deps)).toBe('declined')
    const s = await state()
    expect(s).toMatchObject({ status: 'declined', billing: 'declined', teardownReason: 'declined' })
    expect(typeof s?.declinedAt).toBe('string')
    expect(s).not.toHaveProperty('subscriptionId')
    expect(await redis.zrangebyscore(TEARDOWN_INDEX, clock, clock)).toEqual([SID])
    expect(await members(BILLING_INDEX)).toEqual([])
    expect(onDeclined).toHaveBeenCalledTimes(1)
    expect(onDeclined).toHaveBeenCalledWith(SID)
    expect(onHeld).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await ttls()).toEqual([259200, 259200, 259200])
    // Nothing is undone here: that is 23-37's teardown.
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    // A second trigger changes nothing and calls the hook no more.
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    expect(onDeclined).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invoice_payment_intent_requires_action', {}],
    ['authentication_required', {}],
    ['card_declined', { decline_code: 'authentication_required' }]
  ] as const)('3DS (%s): held until the subscription is 23 hours old, hosted URL only on signup, code hold re-armed, sweep:held, onHeld once', async (code, extra) => {
    stripe.invoices.pay.mockRejectedValue(cardError(code, extra))
    expect(await chargeAtReady(SID, deps)).toBe('held')
    const heldUntil = (CREATED + HOLD_WINDOW_SECONDS) * 1000
    expect(HOLD_WINDOW_SECONDS).toBe(82800)
    const s = await state()
    expect(s).toMatchObject({ status: 'held', billing: 'held', heldUntil })
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(INVOICE, {}, OPTS)
    expect((await redis.hgetall<Record<string, unknown>>(signupKey))?.hostedInvoiceUrl).toBe(HOSTED)
    // The hosted URL is on the sign-up record and nowhere else.
    const dump = redis.dump().split('\n').filter(line => line.includes(HOSTED))
    expect(dump.map(line => line.split(' ')[0])).toEqual([signupKey])
    expect(logs.join('\n')).not.toContain(HOSTED)
    expect(await redis.zrangebyscore(`promo:holds:${PROMO}`, heldUntil / 1000 + 600, heldUntil / 1000 + 600)).toEqual([INVITE])
    expect(await redis.zrangebyscore(HELD_INDEX, heldUntil, heldUntil)).toEqual([SID])
    expect(await members(BILLING_INDEX)).toEqual([])
    expect(onHeld).toHaveBeenCalledTimes(1)
    expect(onHeld).toHaveBeenCalledWith(SID)
    expect(onDeclined).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await ttls()).toEqual([259200, 259200, 259200])
  })

  it('a hook that throws is logged as a fixed line and never undoes the state', async () => {
    onDeclined.mockRejectedValue(new Error(`teardown down for ${EMAIL}`))
    stripe.invoices.pay.mockRejectedValue(cardError('card_declined'))
    expect(await chargeAtReady(SID, deps)).toBe('declined')
    expect((await state())?.status).toBe('declined')
    expect(logs).toContain('billing: the declined hook failed; 23-37 finds it in sweep:teardown')
    expect(logs.join('\n')).not.toContain(EMAIL)
  })

  it.each([
    ['StripeConnectionError', () => new Stripe.errors.StripeConnectionError({ message: 'socket hang up' })],
    ['StripeAPIError', () => new Stripe.errors.StripeAPIError({ message: 'server', statusCode: 500 })],
    ['StripeRateLimitError', () => new Stripe.errors.StripeRateLimitError({ message: 'slow down', statusCode: 429, code: 'rate_limit' })],
    ['a 503 of any class', () => Object.assign(new Error('unavailable'), { statusCode: 503 })]
  ])('no teardown on an API error (%s) on pay: billing pending, billingError api, tries counted, still ready, due again in a minute, no hook', async (_label, make) => {
    stripe.invoices.pay.mockRejectedValue(make())
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(await state()).toMatchObject({ status: 'ready', billing: 'pending', billingError: 'api', billingTries: 1 })
    expect(await redis.zrangebyscore(BILLING_INDEX, clock + 60000, clock + 60000)).toEqual([SID])
    expect(await members(TEARDOWN_INDEX)).toEqual([])
    expect(await members(HELD_INDEX)).toEqual([])
    expect(onDeclined).not.toHaveBeenCalled()
    expect(onHeld).not.toHaveBeenCalled()
  })

  it('no teardown on an API error on create either: pending, nothing created', async () => {
    stripe.subscriptions.create.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: 'server', statusCode: 502 }))
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(await state()).toMatchObject({ status: 'ready', billing: 'pending', billingTries: 1 })
    expect(await state()).not.toHaveProperty('pendingSubscriptionId')
    expect(onDeclined).not.toHaveBeenCalled()
  })

  it('a Stripe outage on create, then success on the next status read, ends with exactly one subscription and one pay (list and adopt by metadata)', async () => {
    // The create reached Stripe, but the reply was lost.
    stripe.subscriptions.create.mockImplementationOnce(async () => {
      stripeSide.push({ id: 'sub_1', created: CREATED, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } })
      throw new Stripe.errors.StripeConnectionError({ message: 'socket hang up' })
    })
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    clock += 60000
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(stripeSide).toHaveLength(1)
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({ customer: CUSTOMER, status: 'all', limit: 100, expand: ['data.latest_invoice'] }, OPTS)
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: 'sub_1' })
  })

  it('a retried create with nothing to adopt uses the same key subscribe:{provisionId}:1: the attempt never advances on its own (23-43 Task 3)', async () => {
    stripe.subscriptions.create.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    await resumeBilling(SID, deps)
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(2)
    expect(stripe.subscriptions.create.mock.calls[1]![1]).toEqual({ idempotencyKey: `subscribe:${PID}:1`, ...OPTS })
    expect(stripeSide).toHaveLength(1)
  })

  it('a paid invoice is not paid twice: the invoice is read before a retried pay', async () => {
    // The payment went through on Stripe's side, but the reply was lost.
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid', hosted_invoice_url: HOSTED })
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: 'sub_1' })
  })

  it('an open invoice after an error is paid again with the same key pay:{provisionId}:1 (23-43 Task 3)', async () => {
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(INVOICE, {}, OPTS)
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(2)
    expect(stripe.invoices.pay.mock.calls[1]).toEqual([INVOICE, { off_session: true, payment_method: PM }, { idempotencyKey: `pay:${PID}:1`, ...OPTS }])
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
  })

  it('a void first invoice on resume (Stripe expired it after 23 hours) is declined, with teardownReason declined', async () => {
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'void', hosted_invoice_url: null })
    expect(await resumeBilling(SID, deps)).toBe('declined')
    expect(await state()).toMatchObject({ status: 'declined', billing: 'declined', teardownReason: 'declined' })
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
    expect(onDeclined).toHaveBeenCalledTimes(1)
  })

  it('an invalid request on pay reads the invoice: paid takes the paid path', async () => {
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'Invoice is already paid', code: 'invoice_already_paid' }))
    stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid', hosted_invoice_url: HOSTED })
    expect(await chargeAtReady(SID, deps)).toBe('activated')
    expect((await state())?.subscriptionId).toBe('sub_1')
  })

  it('an invalid request on pay with the invoice not paid is billing rejected, billingError invalid, out of sweep:billing', async () => {
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'No such payment_method', code: 'resource_missing' }))
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(await state()).toMatchObject({ status: 'ready', billing: 'rejected', billingError: 'invalid' })
    expect(await members(BILLING_INDEX)).toEqual([])
    expect(onDeclined).not.toHaveBeenCalled()
    // No automatic retry.
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    expect(stripe.invoices.pay).toHaveBeenCalledTimes(1)
  })

  it('classifyPayError: authentication first, then a card error, then API trouble, then an invalid request; anything else is pending', () => {
    expect(classifyPayError(cardError('invoice_payment_intent_requires_action'))).toBe('held')
    expect(classifyPayError(cardError('authentication_required'))).toBe('held')
    expect(classifyPayError(cardError('card_declined', { decline_code: 'authentication_required' }))).toBe('held')
    expect(classifyPayError(new Stripe.errors.StripeInvalidRequestError({ code: 'invoice_payment_intent_requires_action' }))).toBe('held')
    expect(classifyPayError(cardError('card_declined'))).toBe('declined')
    expect(classifyPayError(new Stripe.errors.StripeConnectionError({}))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeAPIError({}))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeRateLimitError({}))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeInvalidRequestError({ statusCode: 500 }))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeInvalidRequestError({ statusCode: 400 }))).toBe('invalid')
    expect(classifyPayError(new Error('who knows'))).toBe('pending')
    expect(classifyPayError(undefined)).toBe('pending')
  })

  it('23-43 Task 6: activation is tried past 30 tries while the 24 h window is open; past paidAt + 24 h a status read makes no activation POST and the member stays in sweep:billing', async () => {
    fetchMock.mockResolvedValue(activatedReply(503))
    await chargeAtReady(SID, deps)
    for (let i = 0; i < 40; i++) await resumeBilling(SID, deps)
    const s = await state()
    expect(s).toMatchObject({ status: 'ready', billing: 'paid', activationTries: 45 })
    expect(await members(BILLING_INDEX)).toEqual([SID])
    expect(fetchMock).toHaveBeenCalledTimes(45)
    clock += ACTIVATION_WINDOW_MS
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    expect(fetchMock).toHaveBeenCalledTimes(45)
    expect(await members(BILLING_INDEX)).toEqual([SID])
    expect(await state()).toMatchObject({ status: 'ready', billing: 'paid' })
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
  })
})

describe('nudgeBilling: a status read resumes billing at most once per 10 seconds', () => {
  it('SET billing:nudge:{provisionId} NX EX 10 gates it; through keepAlive when given', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    await redis.hset(stateKey, { billing: 'paid', subscriptionId: SUB })
    const fetchMock = vi.fn().mockResolvedValue(activatedReply(503))
    const deps: BillingDeps = { redis, stripe: () => makeStripe(), fetch: fetchMock, callbackSecret: SECRET, sleep: async () => {}, log: () => {} }
    const kept: Promise<void>[] = []
    const keep = (w: Promise<void>) => { kept.push(w) }
    await nudgeBilling(SID, PID, deps, keep)
    await nudgeBilling(SID, PID, deps, keep)
    await Promise.all(kept)
    expect(kept).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await redis.ttl(`billing:nudge:${PID}`)).toBe(10)
    redis.advance(11)
    await nudgeBilling(SID, PID, deps)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reads the provision id from the hash when it is not given', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    await redis.hset(stateKey, { billing: 'paid', subscriptionId: SUB })
    const fetchMock = vi.fn().mockResolvedValue(activatedReply())
    await nudgeBilling(SID, undefined, { redis, stripe: () => makeStripe(), fetch: fetchMock, callbackSecret: SECRET, sleep: async () => {}, log: () => {} })
    expect(await redis.exists(`billing:nudge:${PID}`)).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('the status read nudges billing only for a sign-up in ready', () => {
  it('a ready sign-up: nudge called with the session and provision id; the seven-key reply is unchanged', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    const nudge = vi.fn(async () => {})
    const plain = await handleProvisionStatus(SID, redis)
    const nudged = await handleProvisionStatus(SID, redis, { billing: { nudge } })
    expect(nudged).toEqual(plain)
    expect(nudge).toHaveBeenCalledWith(SID, PID)
  })

  it.each(['installing', 'held', 'declined', 'complete', 'failed'])('a sign-up in %s: no nudge, no Stripe call', async (status) => {
    const redis = new FakeRedis()
    await seedReady(redis, { extra: { status } })
    const nudge = vi.fn(async () => {})
    await handleProvisionStatus(SID, redis, { billing: { nudge } })
    expect(nudge).not.toHaveBeenCalled()
  })

  it('a nudge that throws never breaks the reply', async () => {
    const redis = new FakeRedis()
    await seedReady(redis)
    const reply = await handleProvisionStatus(SID, redis, { billing: { nudge: async () => { throw new Error('upstash down') } }, log: () => {} })
    expect(reply.status).toBe('ready')
  })
})

describe('sweepBilling: the QStash billing step', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let clock: number
  let billing: BillingDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue(activatedReply())
    clock = CREATED * 1000
    billing = { redis, stripe: () => stripe, fetch: fetchMock, callbackSecret: SECRET, now: () => clock, sleep: async () => {}, log: () => {} }
  })

  it('reads at most 50 due members once, resumes each, and returns the counts', async () => {
    await seedReady(redis, { now: clock - 1 })
    const zrange = vi.spyOn(redis, 'zrange')
    const out = await sweepBilling({ redis, billing, now: () => clock })
    expect(zrange).toHaveBeenCalledTimes(1)
    expect(zrange).toHaveBeenCalledWith(BILLING_INDEX, '-inf', clock, { byScore: true, offset: 0, count: 50 })
    expect(out).toEqual({ due: 1, charged: 0, held: 0, declined: 0, pending: 0, activated: 1, busy: 0, errors: 0, refundStarted: 0, refundBusy: 0 })
    expect((await redis.hgetall<Record<string, unknown>>(stateKey))?.status).toBe('complete')
  })

  it('counts held, declined, pending and busy; a member no longer ready is removed; one that throws counts in errors and stays', async () => {
    const sids = ['cs_held', 'cs_declined', 'cs_pending', 'cs_busy', 'cs_gone', 'cs_done', 'cs_broken']
    const pids: Record<string, string> = {}
    for (const [i, sid] of sids.entries()) {
      const pid = `P${String(i).padStart(21, '0')}`
      pids[sid] = pid
      await redis.hset(`provision:${sid}`, { status: sid === 'cs_done' ? 'complete' : 'ready', subdomain: 'cascadia', provisionId: pid, attempt: 1, siteAnsweredAt: 'x' })
      await redis.set(`provision:by-id:${pid}`, sid, { ex: 86400 })
      await redis.hset(`signup:${pid}`, { stripeCustomerId: CUSTOMER, setupIntentId: SETUP_INTENT, inviteId: INVITE, priceId: PRICE })
      await redis.zadd(BILLING_INDEX, { score: clock - 10 + i, member: sid })
    }
    await redis.del('provision:cs_gone')
    await redis.set('provision:cs_busy:lifecycle', 'other-runner', { ex: 120 })
    stripe.invoices.pay.mockImplementation(async () => {
      const n = stripe.invoices.pay.mock.calls.length
      if (n === 1) throw cardError('authentication_required')
      if (n === 2) throw cardError('card_declined')
      throw new Stripe.errors.StripeConnectionError({ message: 'down' })
    })
    const hgetall = redis.hgetall.bind(redis)
    redis.hgetall = (async (key: string) => {
      if (key === 'provision:cs_broken') throw new Error('upstash timeout')
      return hgetall(key)
    }) as typeof redis.hgetall
    const out = await sweepBilling({ redis, billing, now: () => clock })
    expect(out).toEqual({ due: 7, charged: 0, held: 1, declined: 1, pending: 1, activated: 0, busy: 1, errors: 1, refundStarted: 0, refundBusy: 0 })
    const left = await redis.zrange(BILLING_INDEX, '-inf', '+inf', { byScore: true })
    expect(left).not.toContain('cs_gone')
    expect(left).not.toContain('cs_done')
    expect(left).toEqual(expect.arrayContaining(['cs_pending', 'cs_busy', 'cs_broken']))
  })

  it('an empty index reports zeros and needs no billing wiring; a due member without billing wiring counts in errors', async () => {
    expect(await sweepBilling({ redis, now: () => clock })).toEqual({ due: 0, charged: 0, held: 0, declined: 0, pending: 0, activated: 0, busy: 0, errors: 0, refundStarted: 0, refundBusy: 0 })
    await seedReady(redis, { now: clock - 1 })
    expect(await sweepBilling({ redis, now: () => clock })).toMatchObject({ due: 1, errors: 1 })
  })
})

describe('onFirstInvoicePaid: invoice.paid for the first invoice takes the paid path', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let deps: BillingDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue(activatedReply())
    deps = { redis, stripe: () => stripe, fetch: fetchMock, callbackSecret: SECRET, now: () => CREATED * 1000, sleep: async () => {}, log: () => {} }
  })

  it('a held sign-up: subscriptionId, code hold released, out of sweep:held, activated, complete', async () => {
    await seedReady(redis, { extra: { status: 'held', billing: 'held', pendingSubscriptionId: SUB, invoiceId: INVOICE, heldUntil: 1 } })
    await redis.zadd(HELD_INDEX, { score: 1, member: SID })
    expect(await onFirstInvoicePaid(PID, deps)).toBe('activated')
    expect(await redis.hgetall<Record<string, unknown>>(stateKey)).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB })
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
    expect(await redis.zcard(HELD_INDEX)).toBe(0)
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
  })

  it('a pending sign-up whose subscription id never got written takes it from the invoice', async () => {
    await seedReady(redis, { extra: { billing: 'pending', billingTries: 1 } })
    expect(await onFirstInvoicePaid(PID, deps, SUB)).toBe('activated')
    expect((await redis.hgetall<Record<string, unknown>>(stateKey))?.subscriptionId).toBe(SUB)
  })

  it('an activation that does not answer leaves the sign-up ready and paid, due in sweep:billing', async () => {
    fetchMock.mockResolvedValue(activatedReply(503))
    await seedReady(redis, { extra: { status: 'held', billing: 'held', pendingSubscriptionId: SUB } })
    expect(await onFirstInvoicePaid(PID, deps)).toBe('paid')
    expect(await redis.hgetall<Record<string, unknown>>(stateKey)).toMatchObject({ status: 'ready', billing: 'paid' })
    expect(await redis.zcard(BILLING_INDEX)).toBe(1)
  })

  it.each([
    ['complete', { status: 'complete', billing: 'paid', subscriptionId: SUB }],
    ['declined', { status: 'declined', billing: 'declined' }],
    ['already paid', { status: 'ready', billing: 'paid', subscriptionId: SUB, activatedAt: 'x' }]
  ])('a sign-up %s changes nothing', async (_label, extra) => {
    await seedReady(redis, { extra })
    const before = redis.dump()
    await onFirstInvoicePaid(PID, deps)
    expect(redis.dump()).toBe(before)
  })

  it('an unknown provision id changes nothing', async () => {
    expect(await onFirstInvoicePaid('Zz0000000000000000000z', deps)).toBe('skipped')
  })
})

describe('Task 2: terminal states in billing (23-43)', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let deps: BillingDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue(activatedReply())
    deps = { redis, stripe: () => stripe, fetch: fetchMock, callbackSecret: SECRET, now: () => CREATED * 1000, sleep: async () => {}, log: () => {} }
  })

  const record = () => redis.hgetall<Record<string, unknown>>(stateKey)
  const stripeCalls = () => [stripe.setupIntents.retrieve, stripe.subscriptions.create, stripe.subscriptions.list, stripe.invoices.pay, stripe.invoices.retrieve]
    .reduce((n, fn) => n + fn.mock.calls.length, 0)

  it.each(['tearing_down', 'torn_down', 'refunding', 'refunded'])('%s is never charged: chargeAtReady, resumeBilling, onFirstInvoicePaid, the status nudge and the billing step make no Stripe call and write nothing on the record', async (status) => {
    await seedReady(redis, { extra: { status, billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE } })
    const before = await record()
    await chargeAtReady(SID, deps)
    await resumeBilling(SID, deps)
    await onFirstInvoicePaid(PID, deps, SUB, { id: INVOICE, amount_paid: 4900, currency: 'usd' })
    await handleProvisionStatus(SID, redis, { billing: { nudge: (sid: string, pid?: string) => nudgeBilling(sid, pid, deps) } })
    await sweepBilling({ redis, billing: deps, now: () => CREATED * 1000 })
    expect(await record()).toEqual(before)
    expect(stripeCalls()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['tearing_down', 'torn_down'])('invoice.paid on %s adds one paid_after_void entry to reconcile:flags (a person decides) and writes nothing else', async (status) => {
    await seedReady(redis, { extra: { status, billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE, stopInvoice: true } })
    const before = await record()
    expect(await onFirstInvoicePaid(PID, deps, SUB, { id: INVOICE, amount_paid: 4900, currency: 'usd' })).toBe('skipped')
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([`paid_after_void:${SID}`])
    expect(await record()).toEqual(before)
  })

  it('invoice.paid on a declined sign-up hands it back in one step (HIGH 8): ready and paid with the invoice, amount and currency, teardownReason cleared, out of sweep:teardown, the code hold released, activated', async () => {
    await seedReady(redis, { extra: { status: 'declined', billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE } })
    await redis.zrem(BILLING_INDEX, SID)
    await redis.zadd(TEARDOWN_INDEX, { score: 1, member: SID })
    expect(await onFirstInvoicePaid(PID, deps, undefined, { id: INVOICE, amount_paid: 4900, currency: 'usd' })).toBe('activated')
    expect(await record()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB, invoiceId: INVOICE, amountPaid: 4900, currency: 'usd', teardownReason: '' })
    expect(await redis.zcard(TEARDOWN_INDEX)).toBe(0)
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
    expect(stripeCalls()).toBe(0)
  })

  it('with no pending subscription, the hand-back takes the webhook invoice\'s own subscription', async () => {
    await seedReady(redis, { extra: { status: 'declined', billing: 'declined', teardownReason: 'declined', invoiceId: INVOICE } })
    expect(await onFirstInvoicePaid(PID, deps, 'sub_from_webhook', { id: INVOICE, amount_paid: 4900, currency: 'usd' })).toBe('activated')
    expect(await record()).toMatchObject({ status: 'complete', subscriptionId: 'sub_from_webhook' })
  })

  it('a declined sign-up whose void is done (stopInvoice) is not handed back: flagged for a person instead', async () => {
    await seedReady(redis, { extra: { status: 'declined', billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE, stopInvoice: true } })
    const before = await record()
    expect(await onFirstInvoicePaid(PID, deps, SUB, { id: INVOICE })).toBe('skipped')
    expect(await record()).toEqual(before)
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([`paid_after_void:${SID}`])
  })

  it('HIGH 8: when invoice.paid won the lease first and completed the sign-up, the void step then sees complete, stops with { stopped: false } and writes nothing', async () => {
    await seedReady(redis, { extra: { status: 'declined', billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: SUB, invoiceId: INVOICE } })
    expect(await onFirstInvoicePaid(PID, deps, undefined, { id: INVOICE, amount_paid: 4900, currency: 'usd' })).toBe('activated')
    const before = redis.dump()
    const stopStripe = { setupIntents: { retrieve: vi.fn() }, paymentMethods: { detach: vi.fn() }, invoices: { retrieve: vi.fn(), voidInvoice: vi.fn() }, subscriptions: { cancel: vi.fn(), retrieve: vi.fn() } }
    expect(await stopProvision(SID, { redis, stripe: () => stopStripe, teardown: vi.fn(), log: () => {} })).toEqual({ stopped: false })
    expect(redis.dump()).toBe(before)
    expect(stopStripe.invoices.retrieve).not.toHaveBeenCalled()
  })

  it('held and declined keep all three keys 72 hours (keepRecords\'s floor, now in the held and declined rows), and so does a paid sign-up not yet activated', async () => {
    const { transition } = await import('../../server/utils/lifecycle')
    const KEEP_MS = 259200 * 1000
    const keys = [stateKey, `provision:by-id:${PID}`, signupKey]
    await seedReady(redis, { extra: { billing: 'pending' } })
    expect((await transition(redis, SID, 'held', { provisionId: PID, heldUntil: CREATED * 1000 })).result).toBe('applied')
    for (const k of keys) expect(await redis.pttl(k), k).toBe(KEEP_MS)
    for (const k of keys) await redis.expire(k, 86400)
    expect((await transition(redis, SID, 'declined', { provisionId: PID })).result).toBe('applied')
    for (const k of keys) expect(await redis.pttl(k), k).toBe(KEEP_MS)
    redis = new FakeRedis()
    await seedReady(redis, { extra: { billing: 'pending' } })
    expect((await transition(redis, SID, 'paid', { provisionId: PID, subscriptionId: SUB })).result).toBe('applied')
    for (const k of keys) expect(await redis.pttl(k), k).toBe(KEEP_MS)
  })
})

// --- Task 3: Stripe duplicate protection (23-43; escalation point 4, HIGH 4, review round 1 D3) ----
//
// A Stripe double that keeps results by idempotency key, as Stripe does ("Retries with the same
// key return the saved response, including 500 errors"; a validation failure or a request that
// conflicts with one still running is not saved). A replayed error carries the
// idempotent-replayed header (lowercase, as the SDK hands Node's headers over). Its list pages the
// customer's subscriptions by starting_after and answers has_more. Errors are the SDK's own classes.

type Planned =
  | 'ok'
  /** Stripe made the subscription, the reply never arrived: the key holds the success. */
  | { lost: Error }
  /** Stripe answered this error; store: whether it is the key's saved result. made: Stripe made the subscription too. */
  | { error: Error, store: boolean, made?: boolean }

interface SubRow { id: string, created: number, status: string, metadata: Record<string, string>, latest_invoice: { id: string, status: string } }

function replayed(err: Error): Error {
  const e = err as Stripe.errors.StripeError
  const Cls = e.constructor as new (raw: Record<string, unknown>) => Error
  return new Cls({ message: e.message, code: e.code, statusCode: e.statusCode, headers: { ...(e.headers ?? {}), 'idempotent-replayed': 'true' } })
}

function idempotentStripe() {
  const subs: SubRow[] = []
  const saved = new Map<string, { ok: SubRow } | { err: Error }>()
  const plan: Planned[] = []
  const keys: string[] = []
  let listHidden = false
  let n = 0
  const make = (pid = PID): SubRow => {
    n++
    const sub = { id: `sub_made_${n}`, created: CREATED, status: 'incomplete', metadata: { provision_id: pid }, latest_invoice: { id: `in_made_${n}`, status: 'open' } }
    subs.push(sub)
    return sub
  }
  const base = makeStripe()
  const stripe = {
    ...base,
    subscriptions: {
      ...base.subscriptions,
      create: vi.fn(async (_params: unknown, opts: { idempotencyKey: string }) => {
        const key = opts.idempotencyKey
        keys.push(key)
        const prior = saved.get(key)
        if (prior) {
          if ('ok' in prior) return prior.ok
          throw replayed(prior.err)
        }
        const next = plan.shift() ?? 'ok'
        if (next === 'ok') {
          const sub = make()
          saved.set(key, { ok: sub })
          return sub
        }
        if ('lost' in next) {
          saved.set(key, { ok: make() })
          throw next.lost
        }
        if (next.made) make()
        if (next.store) saved.set(key, { err: next.error })
        throw next.error
      }),
      list: vi.fn(async (params: { limit: number, starting_after?: string }, _opts: unknown) => {
        const visible = listHidden ? [] : subs
        const from = params.starting_after ? visible.findIndex(x => x.id === params.starting_after) + 1 : 0
        const data = visible.slice(from, from + params.limit)
        return { data, has_more: from + params.limit < visible.length }
      }),
      retrieve: vi.fn(async (id: string, _params: unknown, _opts: unknown) => {
        const found = subs.find(x => x.id === id)
        if (!found) throw new Stripe.errors.StripeInvalidRequestError({ message: 'No such subscription', code: 'resource_missing', statusCode: 404 })
        return found
      })
    },
    invoices: {
      ...base.invoices,
      pay: vi.fn(async (id: string, _params: unknown, _opts: unknown) => ({ id, status: 'paid' })),
      retrieve: vi.fn(async (id: string) => ({ id, status: 'open', hosted_invoice_url: HOSTED }))
    }
  }
  return { stripe, subs, saved, plan, keys, make, hide: (v: boolean) => { listHidden = v } }
}

const apiError500 = () => new Stripe.errors.StripeAPIError({ message: 'server error', statusCode: 500 })
const connectionError = () => new Stripe.errors.StripeConnectionError({ message: 'socket hang up' })

describe('Stripe duplicate protection (23-43 Task 3, D3)', () => {
  let redis: FakeRedis
  let sx: ReturnType<typeof idempotentStripe>
  let clock: number
  let logs: string[]
  let deps: BillingDeps
  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)
  const flags = () => redis.zrange('reconcile:flags', 0, -1)
  const billingMembers = () => redis.zrange(BILLING_INDEX, 0, -1)
  const tick = async (fn: (sid: string, d: BillingDeps) => Promise<unknown>) => {
    clock += 60000
    return fn(SID, deps)
  }

  beforeEach(async () => {
    redis = new FakeRedis()
    sx = idempotentStripe()
    clock = CREATED * 1000
    logs = []
    deps = {
      redis,
      stripe: () => sx.stripe as never,
      fetch: vi.fn().mockResolvedValue(activatedReply()),
      callbackSecret: SECRET,
      now: () => clock,
      sleep: async () => {},
      log: m => logs.push(m)
    }
    await seedReady(redis, { now: clock })
  })

  it('a run cut short after Stripe made the subscription ends with one subscription (the same key finds it, even when the list does not show it yet)', async () => {
    // The create applied at Stripe; the record's pendingSubscription step then failed twice (Redis down).
    sx.hide(true)
    redis.failEvals(TRANSITION_SCRIPT, 2, args => args.includes('subscriptionCreatedAt'))
    await expect(chargeAtReady(SID, deps)).rejects.toThrow()
    expect(await state()).toMatchObject({ billing: 'charging', intentOp: 'subscribe' })
    expect(await tick(resumeBilling)).toBe('activated')
    expect(sx.subs).toHaveLength(1)
    expect(new Set(sx.keys)).toEqual(new Set([`subscribe:${PID}:1`]))
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: 'sub_made_1' })
  })

  it('an unclear create error then a retry adopts the subscription (listed before any retried create)', async () => {
    // Stripe made it and answered 500; the 500 is the key's saved result.
    sx.plan.push({ error: apiError500(), store: true, made: true })
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(await tick(resumeBilling)).toBe('activated')
    expect(sx.stripe.subscriptions.create).toHaveBeenCalledTimes(1)
    expect(sx.subs).toHaveLength(1)
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: 'sub_made_1' })
  })

  it('the stored-500 sequence, tick by tick: pending, unclear 1, unclear 2, unclear 3 flagged for a person; one key throughout, never advanced', async () => {
    sx.plan.push({ error: apiError500(), store: true })
    // Tick 1: the 500 itself (not replayed): pending.
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    let st = await state()
    expect(st).toMatchObject({ billing: 'pending', billingTries: 1, subscribeAttempt: 1 })
    expect(st).not.toHaveProperty('unclearTries')
    // Tick 2: the adopt list is empty and the same key replays the stored 500: unclear 1.
    expect(await tick(resumeBilling)).toBe('pending')
    expect(await state()).toMatchObject({ billing: 'pending', billingError: 'unclear', unclearTries: 1, billingTries: 2, subscribeAttempt: 1 })
    expect(await billingMembers()).toEqual([SID])
    // Tick 3: unclear 2.
    expect(await tick(resumeBilling)).toBe('pending')
    expect(await state()).toMatchObject({ unclearTries: 2, billingTries: 3 })
    // Tick 4: unclear 3: billing review, stripe_unclear, out of sweep:billing.
    expect(await tick(resumeBilling)).toBe('review')
    st = await state()
    expect(st).toMatchObject({ status: 'ready', billing: 'review', billingError: 'stripe_unclear', unclearTries: 3, billingTries: 4, subscribeAttempt: 1 })
    expect(await flags()).toEqual([`stripe_unclear:${SID}`])
    expect(await billingMembers()).toEqual([])
    // No create with any other key at any point; the billingTries cap of 10 is not what stopped it.
    expect(new Set(sx.keys)).toEqual(new Set([`subscribe:${PID}:1`]))
    expect(sx.stripe.subscriptions.create).toHaveBeenCalledTimes(4)
    expect(sx.subs).toHaveLength(0)
    // Tick 5: nothing more, no Stripe call.
    const calls = sx.stripe.subscriptions.list.mock.calls.length
    expect(await tick(resumeBilling)).toBe('skipped')
    expect(sx.stripe.subscriptions.list.mock.calls.length).toBe(calls)
    expect(sx.stripe.subscriptions.create).toHaveBeenCalledTimes(4)
    expect(logs).toContain('billing: Stripe outcome unclear, flagged for a person')
  })

  it('a run cut short after the stored 500 (pending never written): the next run lists, finds nothing, replays the 500 and counts unclear 1', async () => {
    sx.plan.push({ error: apiError500(), store: true })
    // The first run is cut short after the 500 was saved but before pending was written.
    redis.failEvals(TRANSITION_SCRIPT, 2, args => args.includes('billingTries'))
    await expect(chargeAtReady(SID, deps)).rejects.toThrow()
    expect(await tick(resumeBilling)).toBe('pending')
    expect(await state()).toMatchObject({ billingError: 'unclear', unclearTries: 1, billingTries: 1 })
    expect(new Set(sx.keys)).toEqual(new Set([`subscribe:${PID}:1`]))
  })

  it('the match on page 2 is adopted (every page is read, starting_after the last id)', async () => {
    for (let i = 0; i < 100; i++) sx.make(`Other${String(i).padStart(17, '0')}xx`)
    const mine = sx.make()
    await redis.hset(stateKey, { billing: 'pending', billingTries: 1, subscribeAttempt: 1, payAttempt: 1 })
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(sx.stripe.subscriptions.list).toHaveBeenCalledTimes(2)
    expect(sx.stripe.subscriptions.list.mock.calls[1]![0]).toMatchObject({ starting_after: sx.subs[99]!.id, limit: 100 })
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: mine.id })
  })

  it('two matches stop billing and flag: billing review, multiple_subscriptions, nothing created, nothing paid', async () => {
    sx.make()
    sx.make()
    await redis.hset(stateKey, { billing: 'pending', billingTries: 1, subscribeAttempt: 1, payAttempt: 1 })
    expect(await resumeBilling(SID, deps)).toBe('review')
    expect(await state()).toMatchObject({ status: 'ready', billing: 'review', billingError: 'multiple_subscriptions' })
    expect(await state()).not.toHaveProperty('pendingSubscriptionId')
    expect(await flags()).toEqual([`multiple_subscriptions:${SID}`])
    expect(await billingMembers()).toEqual([])
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(sx.stripe.invoices.pay).not.toHaveBeenCalled()
    expect(logs).toContain('billing: several subscriptions carry this provision id, flagged for a person')
  })

  it('two matches found by the next holder\'s reconcile also stop billing', async () => {
    sx.make()
    sx.make()
    await redis.hset(stateKey, { billing: 'charging', subscribeAttempt: 1, payAttempt: 1, intentOp: 'subscribe', intentKey: `subscribe:${PID}:1`, intentToken: 'old-lease', intentAt: 'x' })
    expect(await chargeAtReady(SID, deps)).toBe('review')
    expect(await state()).toMatchObject({ billing: 'review', billingError: 'multiple_subscriptions' })
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
  })

  it('a price change after checkout changes nothing: the create uses the frozen priceId, never a runtime price', async () => {
    await redis.hset(signupKey, { priceId: 'price_frozen_at_checkout' })
    const changed = { ...deps, price: 'price_raised_later' } as BillingDeps
    expect(await chargeAtReady(SID, changed)).toBe('activated')
    const params = sx.stripe.subscriptions.create.mock.calls[0]![0] as { items: Array<{ price: string }> }
    expect(params.items).toEqual([{ price: 'price_frozen_at_checkout' }])
  })

  it('a sign-up with no frozen priceId is rejected (no_price), with a fixed line, and nothing is created', async () => {
    await redis.hset(signupKey, { priceId: '' })
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'no_price' })
    expect(await billingMembers()).toEqual([])
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(logs).toContain('billing: rejected (no_price)')
  })

  it('the record\'s pendingSubscriptionId lost and the marker intact: the marker\'s subscription is retrieved and adopted; nothing is created', async () => {
    const sub = sx.make()
    await redis.hset(`dedupe:${PID}`, { checkoutSession: SID, subscriptionId: sub.id })
    await redis.expire(`dedupe:${PID}`, 2592000)
    await redis.hset(stateKey, { billing: 'pending', billingTries: 1, subscribeAttempt: 1, payAttempt: 1 })
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(sx.stripe.subscriptions.retrieve).toHaveBeenCalledWith(sub.id, { expand: ['latest_invoice'] }, OPTS)
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(sx.subs).toHaveLength(1)
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: sub.id })
  })

  it('the marker is filled by the run itself: checkoutSession stays, subscriptionId and invoiceId are added', async () => {
    await redis.hset(`dedupe:${PID}`, { checkoutSession: SID })
    await redis.expire(`dedupe:${PID}`, 2592000)
    expect(await chargeAtReady(SID, deps)).toBe('activated')
    expect(await redis.hgetall(`dedupe:${PID}`)).toMatchObject({ checkoutSession: SID, subscriptionId: 'sub_made_1', invoiceId: 'in_made_1' })
  })

  it('a StripeIdempotencyError with statusCode 409 (idempotency_key_in_use) is transient: pending, counted, the same key, then created with it', async () => {
    sx.plan.push({ error: new Stripe.errors.StripeIdempotencyError({ message: 'in use', code: 'idempotency_key_in_use', statusCode: 409 }), store: false })
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(await state()).toMatchObject({ billing: 'pending', billingTries: 1, subscribeAttempt: 1 })
    expect(await state()).not.toHaveProperty('unclearTries')
    expect(await tick(resumeBilling)).toBe('activated')
    expect(new Set(sx.keys)).toEqual(new Set([`subscribe:${PID}:1`]))
    expect(sx.subs).toHaveLength(1)
  })

  it('a StripeIdempotencyError with statusCode 400 (other parameters under the key) is invalid: rejected, a fixed line, idempotency_mismatch flagged', async () => {
    sx.plan.push({ error: new Stripe.errors.StripeIdempotencyError({ message: 'Keys for idempotent requests can only be used with the same parameters', statusCode: 400 }), store: false })
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'invalid' })
    expect(await flags()).toEqual([`idempotency_mismatch:${SID}`])
    expect(await billingMembers()).toEqual([])
    expect(logs).toContain('billing: the idempotency key was used with other parameters, flagged for a person')
  })

  it('classifyPayError: 409 or idempotency_key_in_use is pending; an idempotency error with 400 is invalid', () => {
    expect(classifyPayError(new Stripe.errors.StripeIdempotencyError({ message: 'x', statusCode: 409 }))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeIdempotencyError({ message: 'x', code: 'idempotency_key_in_use', statusCode: 400 }))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeInvalidRequestError({ message: 'x', code: 'idempotency_key_in_use', statusCode: 409 }))).toBe('pending')
    expect(classifyPayError(new Stripe.errors.StripeIdempotencyError({ message: 'x', statusCode: 400 }))).toBe('invalid')
  })

  it('the tenth unclear error rejects: billing rejected, billingError tries, out of sweep:billing, a fixed line and a reconcile:flags entry', async () => {
    for (let i = 0; i < 10; i++) sx.plan.push({ error: connectionError(), store: false })
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    for (let i = 2; i <= 9; i++) {
      expect(await tick(resumeBilling)).toBe('pending')
      expect(await state()).toMatchObject({ billing: 'pending', billingTries: i })
    }
    expect(await tick(resumeBilling)).toBe('rejected')
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'tries', billingTries: 10 })
    expect(await billingMembers()).toEqual([])
    expect(await flags()).toEqual([`stripe_unclear:${SID}`])
    expect(logs).toContain('billing: rejected (tries)')
    expect(new Set(sx.keys)).toEqual(new Set([`subscribe:${PID}:1`]))
  })

  it('pay: an unclear pay outcome follows the same rule (the invoice read first, open; the same key replays the saved 500)', async () => {
    let stored: Error | null = null
    sx.stripe.invoices.pay.mockImplementation(async () => {
      if (stored) throw replayed(stored)
      stored = apiError500()
      throw stored
    })
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(await tick(resumeBilling)).toBe('pending')
    expect(await state()).toMatchObject({ billingError: 'unclear', unclearTries: 1, payAttempt: 1 })
    for (const call of sx.stripe.invoices.pay.mock.calls) expect(call[2]).toMatchObject({ idempotencyKey: `pay:${PID}:1` })
    expect(sx.stripe.invoices.retrieve).toHaveBeenCalled()
  })

  it('pay: a paid invoice found by the read before a retried pay takes the paid path', async () => {
    sx.stripe.invoices.pay.mockRejectedValueOnce(apiError500())
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    sx.stripe.invoices.retrieve.mockResolvedValue({ id: 'in_made_1', status: 'paid', hosted_invoice_url: HOSTED })
    expect(await tick(resumeBilling)).toBe('activated')
    expect(sx.stripe.invoices.pay).toHaveBeenCalledTimes(1)
  })

  it('an invoices.retrieve error goes through classifyPayError: transient is pending, resource_missing is rejected', async () => {
    sx.stripe.invoices.pay.mockRejectedValueOnce(connectionError())
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    sx.stripe.invoices.retrieve.mockRejectedValueOnce(connectionError())
    expect(await tick(resumeBilling)).toBe('pending')
    sx.stripe.invoices.retrieve.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'No such invoice', code: 'resource_missing', statusCode: 404 }))
    expect(await tick(resumeBilling)).toBe('rejected')
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'invalid' })
  })

  it.each(['rejected', 'review'])('billing %s: nudgeBilling takes no nudge key and makes no Stripe call; resume, charge and invoice.paid do nothing', async (billing) => {
    await redis.hset(stateKey, { billing })
    await nudgeBilling(SID, PID, deps)
    expect(await redis.get(`billing:nudge:${PID}`)).toBeNull()
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    expect(await chargeAtReady(SID, deps)).toBe('skipped')
    expect(await onFirstInvoicePaid(PID, deps, 'sub_x', { id: 'in_x', amount_paid: 900, currency: 'usd' })).toBe('skipped')
    expect(await state()).toMatchObject({ billing })
    expect(sx.stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(sx.stripe.subscriptions.list).not.toHaveBeenCalled()
    expect(sx.stripe.subscriptions.create).not.toHaveBeenCalled()
  })
})

// --- 23-43 Task 6: no charge before the site answers over HTTPS (the probe) -------------------------

describe('the probe: nothing is charged before the site answers (23-43 Task 6)', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let deps: BillingDeps
  /** What the site answers the probe (no Authorization header) with; the activation always 200 {activated: true}. */
  let probeReply: () => Promise<{ status: number, json: () => Promise<unknown> }>
  const unauthorized = async () => activatedReply(401, { error: 'unauthorized' })
  const notFound = async () => activatedReply(404, { error: 'not_found' })
  const probeCalls = () => fetchMock.mock.calls.filter(c => !(c[1] as { headers: Record<string, string> }).headers.Authorization)
  const activationCalls = () => fetchMock.mock.calls.filter(c => (c[1] as { headers: Record<string, string> }).headers.Authorization)

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    probeReply = notFound
    fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => (init.headers.Authorization ? activatedReply() : probeReply()))
    logs = []
    clock = CREATED * 1000
    deps = { redis, stripe: () => stripe, fetch: fetchMock, callbackSecret: SECRET, now: () => clock, sleep: async () => {}, log: msg => logs.push(msg) }
    await seedReady(redis, { now: clock, extra: { siteAnsweredAt: '', readyAtMs: clock } })
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  it('probeSite POSTs /localnodes/activate with no Authorization header, an empty body, the activation User-Agent, redirect manual and a signal', async () => {
    probeReply = unauthorized
    expect(await probeSite({ subdomain: 'cascadia' }, deps)).toBe('answering')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as [string, { method: string, headers: Record<string, string>, body: string, redirect: string, signal: AbortSignal }]
    expect(url).toBe('https://cascadia.localnodes.xyz/localnodes/activate')
    expect(init.method).toBe('POST')
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.headers['User-Agent']).toBe('LocalNodes-Onboarding/1 (activate)')
    expect(init.body).toBe('')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('a 404 from a site with no token is not an answer', async () => {
    probeReply = notFound
    expect(await probeSite({ subdomain: 'cascadia' }, deps)).toBe('not_yet')
  })

  it.each([
    ['200', async () => activatedReply(200, { activated: true })],
    ['a redirect', async () => activatedReply(302, null)],
    ['a 503', async () => activatedReply(503, { error: 'unavailable' })],
    ['a 401 with another body', async () => activatedReply(401, { error: 'nope' })],
    ['a 401 that is not JSON', async () => ({ status: 401, json: async () => { throw new SyntaxError('<html>') } })],
    ['a 403', async () => activatedReply(403, { error: 'unauthorized' })],
    ['a network error', async () => { throw new TypeError('fetch failed') }]
  ])('%s is not an answer', async (_l, reply) => {
    probeReply = reply as typeof probeReply
    expect(await probeSite({ subdomain: 'cascadia' }, deps)).toBe('not_yet')
  })

  it('probeSite refuses a subdomain that is not a DNS label, with no request; its log names the HTTP status only', async () => {
    expect(await probeSite({ subdomain: 'evil.com/x?' }, deps)).toBe('not_yet')
    expect(fetchMock).not.toHaveBeenCalled()
    probeReply = notFound
    await probeSite({ subdomain: 'cascadia' }, deps)
    expect(logs).toContain('billing: probe answered 404')
    expect(logs.join('\n')).not.toContain('cascadia')
  })

  it('nothing is charged before the site answers: not yet means billing stays unset, probeTries plus one and sweep:billing due 60 s later', async () => {
    expect(await chargeAtReady(SID, deps)).toBe('waiting')
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    const s = await state()
    expect(s?.billing).toBeUndefined()
    expect(s).toMatchObject({ probeTries: 1 })
    expect(await redis.zrangebyscore(BILLING_INDEX, clock + 60000, clock + 60000)).toEqual([SID])
    expect(await resumeBilling(SID, deps)).toBe('waiting')
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ probeTries: 2 })
  })

  it('the first answer writes siteAnsweredAt and the charge goes on in the same run; once set, nothing probes again', async () => {
    probeReply = unauthorized
    expect(await chargeAtReady(SID, deps)).toBe('activated')
    expect((await state())?.siteAnsweredAt).toBe(new Date(clock).toISOString())
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
    expect(probeCalls()).toHaveLength(1)
    expect(activationCalls()).toHaveLength(1)
    // The probe ran before any Stripe call.
    expect(fetchMock.mock.invocationCallOrder[0]!).toBeLessThan(stripe.setupIntents.retrieve.mock.invocationCallOrder[0]!)
  })

  it('a retried pay never probes', async () => {
    probeReply = unauthorized
    stripe.invoices.pay.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({}))
    expect(await chargeAtReady(SID, deps)).toBe('pending')
    expect(probeCalls()).toHaveLength(1)
    probeReply = notFound
    expect(await resumeBilling(SID, deps)).toBe('activated')
    expect(probeCalls()).toHaveLength(1)
  })

  it('no answer within 24 hours of readyAt: siteNeverAnswered, out of sweep:billing, one reconcile:flags entry, a fixed log line; nothing charged and nothing torn down', async () => {
    clock += 86400000
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    const s = await state()
    expect(s).toMatchObject({ status: 'ready', siteNeverAnswered: true })
    expect(s?.billing).toBeUndefined()
    expect(await redis.zrange(BILLING_INDEX, 0, -1)).toEqual([])
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([`site_never_answered:${SID}`])
    expect(logs).toContain('billing: the site never answered the probe in 24 hours; flagged for a person')
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('after siteNeverAnswered, chargeAtReady, resumeBilling, the status read\'s nudge and a repeated ready all skip it: no probe, no Stripe call', async () => {
    clock += 86400000
    await resumeBilling(SID, deps)
    probeReply = unauthorized
    expect(await chargeAtReady(SID, deps)).toBe('skipped')
    expect(await resumeBilling(SID, deps)).toBe('skipped')
    await nudgeBilling(SID, PID, deps)
    expect(await redis.get(`billing:nudge:${PID}`)).toBeNull()
    const nudge = vi.fn()
    await handleProvisionStatus(SID, redis as never, { billing: { nudge } })
    expect(nudge).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ siteNeverAnswered: true })
  })
})

// ---------------------------------------------------------------------------
// The free pilot ends unless its organizer says yes (fresh3 23, pilot end;
// project rule). A pilot sign-up carries pilotMonths
// and the frozen pilotEndsAt from checkout; its subscription is created with
// cancel_at there, and a pilot is never paid by billing.
describe('billing: the free pilot ends by itself', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let clock: number
  let deps: BillingDeps
  const END = CREATED + 80 * 86400

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    clock = CREATED * 1000
    deps = {
      redis,
      stripe: () => stripe,
      fetch: vi.fn().mockResolvedValue(activatedReply()),
      callbackSecret: SECRET,
      now: () => clock,
      sleep: vi.fn(async () => {}),
      log: () => {}
    }
    await seedReady(redis, { now: clock })
    await redis.hset(signupKey, { pilotMonths: 3, pilotEndsAt: END })
    stripe.subscriptions.create.mockResolvedValue({
      id: SUB, created: CREATED, status: 'active', cancel_at: END, metadata: { provision_id: PID, pilot: 'ends' }, latest_invoice: { id: INVOICE, status: 'paid' }
    })
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  it('subscriptionParams without cancelAt is byte for byte what it was; with it, cancel_at, no proration and the pilot metadata', () => {
    const base = { customer: CUSTOMER, paymentMethod: PM, price: PRICE, promoId: PROMO, metadata: { provision_id: PID } }
    expect(JSON.stringify(subscriptionParams(base))).toBe(JSON.stringify({
      customer: CUSTOMER,
      items: [{ price: PRICE }],
      default_payment_method: PM,
      discounts: [{ promotion_code: PROMO }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata: { provision_id: PID },
      expand: ['latest_invoice']
    }))
    expect(subscriptionParams({ ...base, cancelAt: END })).toMatchObject({
      cancel_at: END,
      proration_behavior: 'none',
      metadata: { provision_id: PID, pilot: 'ends', pilot_ends_at: String(END) }
    })
  })

  it('a sign-up from a 100%-off once code carries no pilot fields, so its subscription is created with the paid params: no cancel_at', async () => {
    await redis.del(signupKey)
    await seedReady(redis, { now: clock })
    stripe.subscriptions.create.mockResolvedValue({
      id: SUB, created: CREATED, status: 'active', cancel_at: null, metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'paid' }
    })
    await chargeAtReady(SID, deps)
    const params = stripe.subscriptions.create.mock.calls[0]![0] as Record<string, unknown>
    expect(params).not.toHaveProperty('cancel_at')
    expect(params).not.toHaveProperty('proration_behavior')
    expect(params).toMatchObject({ discounts: [{ promotion_code: PROMO }], metadata: { provision_id: PID } })
    expect(params.metadata).not.toHaveProperty('pilot')
  })

  it('a pilot is created with cancel_at at its frozen end, and its paid-at-creation invoice takes the paid path with no pay call', async () => {
    await chargeAtReady(SID, deps)
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.create.mock.calls[0]![0]).toMatchObject({
      cancel_at: END,
      proration_behavior: 'none',
      discounts: [{ promotion_code: PROMO }],
      metadata: { provision_id: PID, subdomain: 'cascadia', invite_id: INVITE, pilot: 'ends', pilot_ends_at: String(END) }
    })
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ subscriptionId: SUB, billing: 'paid' })
  })

  it('a retried create sends the same frozen end, under the same key, however late it runs', async () => {
    stripe.subscriptions.create.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    clock += 3 * 3600 * 1000
    await resumeBilling(SID, deps)
    expect(stripe.subscriptions.create).toHaveBeenCalledTimes(2)
    expect(stripe.subscriptions.create.mock.calls[1]![0]).toEqual(stripe.subscriptions.create.mock.calls[0]![0])
    expect(stripe.subscriptions.create.mock.calls[1]![1]).toEqual({ idempotencyKey: `subscribe:${PID}:1`, ...OPTS })
  })

  it('a pilot with no end, an unreadable end, or one a day away or less is rejected (no_pilot_end): nothing created, nothing paid', async () => {
    for (const end of ['', 'soon', String(CREATED + 86400)]) {
      await redis.del(stateKey)
      await redis.del(signupKey)
      stripe = makeStripe()
      await seedReady(redis, { now: clock })
      await redis.hset(signupKey, { pilotMonths: 3, pilotEndsAt: end })
      expect(await chargeAtReady(SID, deps)).toBe('rejected')
      expect(stripe.subscriptions.create).not.toHaveBeenCalled()
      expect(stripe.invoices.pay).not.toHaveBeenCalled()
      expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'no_pilot_end' })
    }
  })

  it('a pilot whose first invoice is not already paid is never paid (pilot_not_free); Stripe expires it', async () => {
    stripe.subscriptions.create.mockResolvedValue({
      id: SUB, created: CREATED, status: 'incomplete', cancel_at: END, metadata: { provision_id: PID, pilot: 'ends' }, latest_invoice: { id: INVOICE, status: 'open' }
    })
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'pilot_not_free' })
    // A later run does not pay it either.
    clock += 60000
    await resumeBilling(SID, deps)
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
  })

  it('an adopted pilot subscription whose cancel_at is not the frozen end is rejected (no_pilot_end), never paid', async () => {
    stripe.subscriptions.create.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: SUB, created: CREATED, status: 'incomplete', cancel_at: null, metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } }],
      has_more: false
    })
    clock += 60000
    expect(await resumeBilling(SID, deps)).toBe('rejected')
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'no_pilot_end' })
  })

  it('a pilot subscription adopted from the dedupe marker with no end is rejected (no_pilot_end) even when its invoice reads paid', async () => {
    await redis.hset(`dedupe:${PID}`, { subscriptionId: SUB })
    const retrieve = vi.fn().mockResolvedValue({
      id: SUB, created: CREATED, status: 'active', cancel_at: null, metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'paid' }
    })
    ;(stripe.subscriptions as Record<string, unknown>).retrieve = retrieve
    expect(await chargeAtReady(SID, deps)).toBe('rejected')
    expect(retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.create).not.toHaveBeenCalled()
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ billing: 'rejected', billingError: 'no_pilot_end' })
  })

  it('an adopted pilot subscription with the frozen end and a paid invoice takes the paid path', async () => {
    stripe.subscriptions.create.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }))
    await chargeAtReady(SID, deps)
    stripe.subscriptions.list.mockResolvedValue({
      data: [{ id: SUB, created: CREATED, status: 'active', cancel_at: END, metadata: { provision_id: PID, pilot: 'ends' }, latest_invoice: { id: INVOICE, status: 'paid' } }],
      has_more: false
    })
    stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid', hosted_invoice_url: HOSTED })
    clock += 60000
    await resumeBilling(SID, deps)
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ subscriptionId: SUB, billing: 'paid' })
  })
})
