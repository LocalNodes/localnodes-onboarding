// The automatic full refund (Phase 23, plan 23-43 Task 6; Tom's ruling of
// 2026-11-09, review round 1 D2, Codex 3, Argon HIGHs 2 and 3; the
// orchestrator's answers: "in full" means the refund equals the amount
// captured, the lateActivation wording, Q-probe-24h).
//
// A paid site that still cannot be handed over 24 hours after paidAt is
// refunded in full (proved against the captured amount), its subscription
// cancelled, torn down by the shared runner, mailed once and flagged. Pending
// refunds are polled; failed, partial or double refunds wait for a person.
// Every step resumes through the real cron entry point; activation and refund
// never both win.
//
// Fakes only: FakeRedis (with the lifecycle twins), a stateful Stripe double
// (a refund made under a key is answered again for the same key, as Stripe's
// idempotency does), mocked fetches for the site and for Resend, and a mocked
// teardown dispatch. No network.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Stripe from 'stripe'
import { FakeRedis } from './helpers/fake-redis'
import { refundAndTearDown, resumeRefund, sweepRefunds, type RefundDeps } from '../../server/utils/refund'
import { BILLING_INDEX, nudgeBilling, onFirstInvoicePaid, resumeBilling, sweepBilling, type BillingDeps } from '../../server/utils/billing'
import { CRON_STEPS, handleCronSweep, type SweepDeps } from '../../server/utils/cron-sweep'
import { HELD_INDEX, REFUND_INDEX, TEARDOWN_INDEX, TRANSITION_SCRIPT, transition } from '../../server/utils/lifecycle'
import { handleTeardownCheck, sweepHeld, sweepTeardowns } from '../../server/utils/teardown'
import { callbackToken, handleProvisionStatus } from '../../server/utils/provision-handlers'
import { emailKey, inviteKey } from '../../server/utils/invites'
import type { RetryStopDeps } from '../../server/utils/retry-stop'

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const INVITE_SECRET = 'invite-hash-secret-for-tests'
const SID = 'cs_test_refund'
const PID = 'ReFuNd0000000000000000'
const SUB = 'sub_r1'
const INVOICE = 'in_r1'
const PI = 'pi_r1'
const PM = 'pm_r1'
const SETUP_INTENT = 'seti_r1'
const INVITE = 'inv_r1'
const EMAIL = 'organizer@example.org'
const APP_UUID = 'app-uuid-refund'
const DAY = 86400000
/** paidAt: 2026-11-08T12:00:00Z. */
const PAID_AT = Date.parse('2026-11-08T12:00:00Z')
const PRICE = 4900

const stateKey = `provision:${SID}`
const signupKey = `signup:${PID}`
const lockKey = `provision:${SID}:lifecycle`
const markKey = `dedupe:${PID}`
const inviteHash = inviteKey(emailKey(INVITE_SECRET, EMAIL))
const bearer = `Bearer ${callbackToken(SECRET, PID)}`
const OPTS = { timeout: 15000, maxNetworkRetries: 0 }

interface RefundLike { id: string, object: 'refund', status: string, amount: number, currency: string, payment_intent: string }

/** A Stripe double that keeps the refunds it made; a create under a key already used answers the same refund (Stripe's idempotency). */
function makeStripe(opts: { amountPaid?: number, refundStatus?: string, refundAmount?: number } = {}) {
  const made: RefundLike[] = []
  const byKey = new Map<string, RefundLike>()
  const amountPaid = opts.amountPaid ?? PRICE
  const stripe = {
    made,
    /** Refunds the list shows (a test can hide one to model a list that lags). */
    listed: () => made,
    setupIntents: { retrieve: vi.fn(async () => ({ id: SETUP_INTENT, status: 'succeeded', payment_method: PM })) },
    paymentMethods: { detach: vi.fn(async () => ({ id: PM })) },
    subscriptions: {
      create: vi.fn(),
      list: vi.fn(async () => ({ data: [] })),
      retrieve: vi.fn(async () => ({ id: SUB, created: 1, status: 'active', latest_invoice: { id: INVOICE, status: 'paid', amount_paid: amountPaid, currency: 'usd' } })),
      cancel: vi.fn(async () => ({ id: SUB, status: 'canceled' }))
    },
    invoices: {
      retrieve: vi.fn(async () => ({ id: INVOICE, status: 'paid', amount_paid: amountPaid, currency: 'usd' })),
      pay: vi.fn(),
      voidInvoice: vi.fn()
    },
    invoicePayments: {
      list: vi.fn(async () => ({ data: [{ id: 'inpay_1', status: 'paid', amount_paid: amountPaid, payment: { type: 'payment_intent', payment_intent: PI } }] }))
    },
    refunds: {
      list: vi.fn(async (params: { payment_intent?: string }) => ({ data: stripe.listed().filter(r => r.payment_intent === params.payment_intent) })),
      create: vi.fn(async (params: { payment_intent: string, amount?: number }, o: { idempotencyKey: string }) => {
        const seen = byKey.get(o.idempotencyKey)
        if (seen) return seen
        const refund: RefundLike = { id: `re_${made.length + 1}`, object: 'refund', status: opts.refundStatus ?? 'succeeded', amount: opts.refundAmount ?? params.amount ?? amountPaid, currency: 'usd', payment_intent: params.payment_intent }
        made.push(refund)
        byKey.set(o.idempotencyKey, refund)
        return refund
      }),
      retrieve: vi.fn(async (id: string) => {
        const r = made.find(x => x.id === id)
        if (!r) throw new Stripe.errors.StripeInvalidRequestError({ message: 'No such refund', code: 'resource_missing', statusCode: 404 })
        return r
      })
    }
  }
  return stripe
}
type StripeMock = ReturnType<typeof makeStripe>

const reply = (status: number, body: unknown) => ({ status, json: async () => body })

async function seedPaid(redis: FakeRedis, extra: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 259200 })
  await redis.hset(stateKey, {
    status: 'ready',
    subdomain: 'cascadia',
    siteUrl: 'https://cascadia.localnodes.xyz',
    provisionId: PID,
    attempt: 1,
    failedAttempts: 0,
    appUuid: APP_UUID,
    readyAt: new Date(PAID_AT - 60000).toISOString(),
    readyAtMs: PAID_AT - 60000,
    siteAnsweredAt: new Date(PAID_AT - 30000).toISOString(),
    billing: 'paid',
    subscriptionId: SUB,
    invoiceId: INVOICE,
    amountPaid: PRICE,
    currency: 'usd',
    paidAt: new Date(PAID_AT).toISOString(),
    activationDeadline: PAID_AT + DAY,
    activationTries: 12,
    ...extra
  })
  await redis.expire(stateKey, 259200)
  await redis.hset(signupKey, { subdomain: 'cascadia', email: EMAIL, inviteId: INVITE, stripeCustomerId: 'cus_r1', setupIntentId: SETUP_INTENT, priceId: 'price_1' })
  await redis.expire(signupKey, 259200)
  await redis.hset(markKey, { checkoutSession: SID, subscriptionId: SUB, invoiceId: INVOICE })
  await redis.expire(markKey, 2592000)
  await redis.hset(inviteHash, { inviteId: INVITE, kind: 'pilot', status: 'used', usedAt: '2026-11-08T11:00:00.000Z' })
  await redis.set(`invite:u:${INVITE}`, SID, { nx: true })
  await redis.zadd('capacity:inflight', { score: 9_999_999_999, member: PID })
  await redis.hset(`byok:${PID}`, { kind: 'gemini', sealed: 'sealed-key-text' })
  await redis.zadd(BILLING_INDEX, { score: PAID_AT, member: SID })
}

/** One sign-up's world: Redis, Stripe, the site, Resend, the delete, the clock. */
function world(stripeOpts: Parameters<typeof makeStripe>[0] = {}) {
  const redis = new FakeRedis()
  const stripe = makeStripe(stripeOpts)
  const logs: string[] = []
  const clock = { now: PAID_AT + DAY + 1000 }
  /** The site: every activation POST is recorded with the status the record held when it was sent. */
  const sent: string[] = []
  let activation: () => Promise<{ status: number, json: () => Promise<unknown> }> = async () => reply(503, { error: 'mail_failed' })
  const fetchMock = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
    if (!init.headers.Authorization) return reply(401, { error: 'unauthorized' })
    sent.push(String((await redis.hgetall<Record<string, unknown>>(stateKey))?.status))
    return activation()
  })
  const mailFetch = vi.fn(async () => ({ id: 'email_1' }))
  const dispatch = vi.fn(async () => undefined)
  const billing: BillingDeps = {
    redis,
    stripe: () => stripe as never,
    fetch: fetchMock as never,
    callbackSecret: SECRET,
    now: () => clock.now,
    sleep: async () => {},
    log: msg => logs.push(msg)
  }
  const stop: RetryStopDeps = {
    redis: redis as never,
    stripe: () => stripe as never,
    mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: mailFetch as never },
    inviteHashSecret: INVITE_SECRET,
    teardown: dispatch,
    now: () => clock.now,
    log: msg => logs.push(msg)
  }
  const deps: RefundDeps = { billing, stop }
  const sweepDeps: SweepDeps = { ...stop, redis: redis as never, billing, keepAlive: undefined } as SweepDeps
  return {
    redis,
    stripe,
    logs,
    clock,
    sent,
    fetchMock,
    mailFetch,
    dispatch,
    billing,
    stop,
    deps,
    sweepDeps,
    setActivation: (fn: typeof activation) => {
      activation = fn
    },
    state: async () => (await redis.hgetall<Record<string, unknown>>(stateKey))!,
    flags: () => redis.zrange('reconcile:flags', 0, -1),
    refundMails: () => mailFetch.mock.calls.filter(c => (c[1] as { headers: Record<string, string> }).headers['Idempotency-Key'] === `refund-mail-${PID}`),
    check: () => handleTeardownCheck(bearer, PID, { redis: redis as never, secret: SECRET })
  }
}
type World = ReturnType<typeof world>

// --- the QStash-signed entry point (as tests/unit/cron-sweep.test.ts signs it) ------------------

const URL_ = 'https://onboarding.test/api/cron/sweep'
const CURRENT = 'sig_test_current'
const NEXT = 'sig_test_next'
const BODY = '{}'
const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (value: unknown) => b64url(enc.encode(JSON.stringify(value)))
let jti = 0
async function signed(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(BODY))))
  const payload = { iss: 'Upstash', sub: URL_, iat: now, nbf: now, exp: now + 300, jti: `jwt_refund_${++jti}`, body }
  const input = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(payload)}`
  const key = await crypto.subtle.importKey('raw', enc.encode(CURRENT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `${input}.${b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(input))))}`
}
async function cron(w: World) {
  const out = await handleCronSweep({ signature: await signed(), body: BODY, url: URL_, currentSigningKey: CURRENT, nextSigningKey: NEXT }, () => w.sweepDeps, { log: msg => w.logs.push(msg) })
  expect(out.status === 200 || out.status === 503).toBe(true)
  return out
}

/** The set fields of a TRANSITION_SCRIPT call (from its flat ARGV). */
function setFields(args: string[]): Record<string, string> {
  let i = 3
  i += 1 + Number(args[i])
  i += 1 + 3 * Number(args[i])
  const n = Number(args[i])
  i += 1
  const out: Record<string, string> = {}
  for (let k = 0; k < n; k++) out[args[i + 2 * k]!] = args[i + 2 * k + 1]!
  return out
}

/** Stop the run right before the first transition that matches: a throw (both tries), or a lost lease (another token takes the lock). */
function killBefore(w: World, match: (set: Record<string, string>) => boolean, mode: 'throw' | 'lost') {
  const original = w.redis.eval.bind(w.redis)
  let fired = 0
  vi.spyOn(w.redis, 'eval').mockImplementation(async (script: string, keys: string[], args: unknown[]) => {
    if (fired < 2 && script === TRANSITION_SCRIPT && match(setFields(args as string[]))) {
      fired++
      if (mode === 'throw') throw new Error('killed: the function was stopped')
      fired = 2
      await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    }
    return original(script, keys, args)
  })
}

const freeStolenLock = async (w: World) => {
  if ((await w.redis.get(lockKey)) === 'another-runner') await w.redis.del(lockKey)
}

// --- the happy path and the state table ------------------------------------------------------------

describe('refundAndTearDown: a paid site never handed over is refunded in full, cancelled, torn down, mailed once and flagged (23-43 Task 6)', () => {
  let w: World
  beforeEach(async () => {
    w = world()
    await seedPaid(w.redis)
  })

  it('succeeded in full, through the QStash billing step: one last try, refunding, the cancel (at the refund start, C1), the refund for exactly amount_paid under refund:{provisionId}, refunded, then the shared runner; teardown-check 200', async () => {
    await cron(w)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', teardownReason: 'activation_failed', refundId: 're_1', refundDone: true, refundCancelled: true, tornDown: true, stopCard: true, stopInvite: true, stopMail: true, stopApp: true })
    expect(typeof s.refundSucceededAt).toBe('string')
    expect(s.activatedAt).toBeUndefined()
    // One last activation try first, while the sign-up was still ready.
    expect(w.sent).toEqual(['ready'])
    expect(w.stripe.invoices.retrieve).toHaveBeenCalledWith(INVOICE, {}, OPTS)
    expect(w.stripe.invoicePayments.list).toHaveBeenCalledWith({ invoice: INVOICE, status: 'paid' }, OPTS)
    expect(w.stripe.refunds.list).toHaveBeenCalledWith({ payment_intent: PI }, OPTS)
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: PI, amount: PRICE, metadata: { provision_id: PID } }, { idempotencyKey: `refund:${PID}`, ...OPTS })
    // "In full": the refund asked for and the refund returned both equal amount_paid.
    expect(w.stripe.made).toHaveLength(1)
    expect(w.stripe.made[0]!.amount).toBe(PRICE)
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledWith(SUB, { invoice_now: false, prorate: false }, OPTS)
    // Code review fix round 1, C1: the subscription is cancelled when the refund starts, before any refund call.
    expect(w.stripe.subscriptions.cancel.mock.invocationCallOrder[0]!).toBeLessThan(w.stripe.invoices.retrieve.mock.invocationCallOrder[0]!)
    expect(w.stripe.subscriptions.cancel.mock.invocationCallOrder[0]!).toBeLessThan(w.stripe.refunds.create.mock.invocationCallOrder[0]!)
    expect(w.fetchMock.mock.invocationCallOrder[0]!).toBeLessThan(w.stripe.subscriptions.cancel.mock.invocationCallOrder[0]!)
    expect(await w.redis.hgetall(markKey)).toMatchObject({ refundId: 're_1' })
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledWith({ subdomain: 'cascadia', provisionId: PID }, expect.any(AbortSignal))
    expect(w.stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(await w.flags()).toEqual([`refund_started:${SID}`])
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    expect(await w.redis.zrange(BILLING_INDEX, 0, -1)).toEqual([])
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
    // Nothing voided, nothing paid, nothing created: the invoice was paid.
    expect(w.stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(w.stripe.invoices.pay).not.toHaveBeenCalled()
  })

  it('the one mail is the approved P1 mail, keyed refund-mail-{provisionId}, sent after the refund succeeded; the invite is reopened before it', async () => {
    await cron(w)
    expect(w.refundMails()).toHaveLength(1)
    const [, init] = w.refundMails()[0]! as [string, { body: { subject: string, text: string, reply_to: string } }]
    expect(init.body.subject).toBe('We\'ve refunded your payment')
    expect(init.body.text).toContain('We couldn\'t finish setting up your site, so we\'ve refunded your payment in full.')
    expect(init.body.text).toContain('Try again: https://localnodes.xyz/invite')
    expect(init.body.reply_to).toBe('hello@localnodes.xyz')
    expect(w.mailFetch).toHaveBeenCalledTimes(1)
    expect(w.stripe.refunds.create.mock.invocationCallOrder[0]!).toBeLessThan(w.mailFetch.mock.invocationCallOrder[0]!)
    expect(await w.redis.hgetall(inviteHash)).toMatchObject({ status: 'open' })
  })

  it('a partial refund is a problem: a refund answering 4800 for a 4900 payment is refund_problem, out of sweep:refund, no refunded state, no mail, no teardown, never a second refund; the subscription was already cancelled at the refund start (C1)', async () => {
    w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    await cron(w)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundProblem: 'partial', refundId: 're_1' })
    expect(s.refundSucceededAt).toBeUndefined()
    expect(await w.flags()).toEqual([`refund_problem:${SID}`, `refund_started:${SID}`].sort())
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(s.refundCancelled).toBe(true)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
    for (let i = 0; i < 3; i++) {
      w.clock.now += 61000
      await cron(w)
    }
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect((await w.state()).status).toBe('refunding')
  })

  it('a pending refund keeps refunding: refundId stored, no refundSucceededAt, no mail; the subscription is already cancelled (C1); the refunds step polls it with refunds.retrieve and goes on once it succeeded', async () => {
    w = world({ refundStatus: 'pending' })
    await seedPaid(w.redis)
    await cron(w)
    let s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundId: 're_1' })
    expect(s.refundSucceededAt).toBeUndefined()
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(s.refundCancelled).toBe(true)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
    // Still pending a minute later: polled, nothing else.
    w.clock.now += 61000
    await cron(w)
    expect(w.stripe.refunds.retrieve).toHaveBeenCalledWith('re_1', {}, OPTS)
    expect((await w.state()).status).toBe('refunding')
    // It succeeds: the next refunds step finishes everything.
    w.stripe.made[0]!.status = 'succeeded'
    w.clock.now += 61000
    await cron(w)
    s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', refundId: 're_1', tornDown: true })
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.refundMails()).toHaveLength(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'canceled'])('a %s refund is a problem for a person: flagged, no refunded state, no mail, no teardown', async (status) => {
    w = world({ refundStatus: status })
    await seedPaid(w.redis)
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundProblem: status })
    expect(await w.flags()).toContain(`refund_problem:${SID}`)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
  })

  it('two refunds for the payment: a problem, and no refund is created', async () => {
    w.stripe.made.push(
      { id: 're_a', object: 'refund', status: 'succeeded', amount: 2000, currency: 'usd', payment_intent: PI },
      { id: 're_b', object: 'refund', status: 'succeeded', amount: 2900, currency: 'usd', payment_intent: PI }
    )
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundProblem: 'multiple' })
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
    expect(w.mailFetch).not.toHaveBeenCalled()
  })

  it.each([
    ['another currency', { currency: 'eur' }, 'mismatch'],
    ['another payment', { payment_intent: 'pi_other' }, 'mismatch']
  ])('a succeeded refund in %s is a problem', async (_l, change, kind) => {
    w.stripe.refunds.create.mockImplementationOnce(async (params: { payment_intent: string, amount?: number }) => {
      const r = { id: 're_x', object: 'refund' as const, status: 'succeeded', amount: params.amount ?? PRICE, currency: 'usd', payment_intent: params.payment_intent, ...change }
      w.stripe.made.push(r)
      return r
    })
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundProblem: kind })
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('a refund already there for this payment, succeeded in full, is adopted: no create', async () => {
    w.stripe.made.push({ id: 're_old', object: 'refund', status: 'succeeded', amount: PRICE, currency: 'usd', payment_intent: PI })
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'tearing_down', refundId: 're_old' })
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
  })

  it('a zero invoice makes no payment or refund call: refundZero, the cancel, the teardown and the approved Stopped mail (P5), keyed refund-mail-{provisionId}', async () => {
    w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    await cron(w)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', refundZero: true, tornDown: true })
    expect(s.refundId).toBeUndefined()
    expect(w.stripe.invoices.retrieve).toHaveBeenCalledTimes(1)
    expect(w.stripe.invoicePayments.list).not.toHaveBeenCalled()
    expect(w.stripe.refunds.list).not.toHaveBeenCalled()
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(w.refundMails()).toHaveLength(1)
    const [, init] = w.refundMails()[0]! as [string, { body: { subject: string, text: string } }]
    expect(init.body.subject).toBe('We couldn\'t set up your site')
    expect(init.body.text).toContain('We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.')
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
  })

  it('a record missing invoiceId recovers it from the subscription\'s latest invoice and records it', async () => {
    await w.redis.hset(stateKey, { invoiceId: '', amountPaid: '', currency: '' })
    await cron(w)
    expect(w.stripe.subscriptions.retrieve).toHaveBeenCalledWith(SUB, { expand: ['latest_invoice'] }, OPTS)
    expect(await w.state()).toMatchObject({ invoiceId: INVOICE, amountPaid: PRICE, currency: 'usd', status: 'tearing_down', refundId: 're_1' })
  })

  it('an already-canceled subscription counts as done', async () => {
    w.stripe.subscriptions.cancel.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'already canceled', code: 'resource_missing', statusCode: 400 }))
    w.stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: SUB, created: 1, status: 'canceled', latest_invoice: { id: INVOICE, status: 'paid', amount_paid: PRICE, currency: 'usd' } })
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'tearing_down', refundCancelled: true })
  })

  it('inside the 24 h window the billing step only tries to activate: no refund', async () => {
    w.clock.now = PAID_AT + DAY - 1000
    await cron(w)
    expect(w.sent).toEqual(['ready'])
    expect((await w.state()).status).toBe('ready')
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
    expect(w.stripe.invoices.retrieve).not.toHaveBeenCalled()
  })

  it('past the window a status read never starts the refund: no activation POST, no Stripe call, still ready', async () => {
    const reply1 = await handleProvisionStatus(SID, w.redis as never, { billing: { nudge: (sid, pid) => nudgeBilling(sid, pid, w.billing) } })
    expect(reply1.status).toBe('ready')
    expect(w.fetchMock).not.toHaveBeenCalled()
    expect(w.stripe.invoices.retrieve).not.toHaveBeenCalled()
    expect((await w.state()).status).toBe('ready')
    expect(await resumeBilling(SID, w.billing)).toBe('skipped')
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
  })

  it('sweepBilling counts the refund it started (refundStarted) and one it found busy (refundBusy)', async () => {
    const counts = await sweepBilling({ redis: w.redis as never, billing: w.billing, refund: w.deps, now: () => w.clock.now })
    expect(counts).toMatchObject({ due: 1, refundStarted: 1, refundBusy: 0, errors: 0 })
    const v = world()
    await seedPaid(v.redis)
    await v.redis.set(lockKey, 'another-runner', { px: 60000 })
    expect(await sweepBilling({ redis: v.redis as never, billing: v.billing, refund: v.deps, now: () => v.clock.now })).toMatchObject({ due: 1, refundStarted: 0, refundBusy: 1, errors: 0 })
  })

  it('CRON_STEPS is stops, held, billing, refunds, teardowns', () => {
    expect(CRON_STEPS.map(s => s.name)).toEqual(['stops', 'held', 'billing', 'refunds', 'teardowns'])
  })

  it('a retried refund refunds once: a create whose reply was lost, with a list that does not show it yet, is sent again under the same key refund:{provisionId}', async () => {
    let lost = true
    const realCreate = w.stripe.refunds.create.getMockImplementation()!
    w.stripe.refunds.create.mockImplementation(async (params, o) => {
      const r = await realCreate(params, o)
      if (lost) {
        lost = false
        throw new Stripe.errors.StripeConnectionError({ message: 'socket hang up' })
      }
      return r
    })
    // The list lags: the refund Stripe made is not listed yet.
    w.stripe.listed = () => []
    // The billing step's create loses its reply; the refunds step (same run, or the next) sends it again.
    await cron(w)
    w.clock.now += 61000
    await cron(w)
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(2)
    for (const call of w.stripe.refunds.create.mock.calls) expect(call[1]).toMatchObject({ idempotencyKey: `refund:${PID}` })
    expect(w.stripe.made).toHaveLength(1)
    expect(await w.state()).toMatchObject({ status: 'tearing_down', refundId: 're_1' })
  })

  it('two runs at once give one refund: the second answers busy', async () => {
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    w.setActivation(async () => {
      await held
      return reply(503, { error: 'mail_failed' })
    })
    const first = refundAndTearDown(SID, w.deps)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    const second = await refundAndTearDown(SID, w.deps)
    release()
    expect(await first).toBe('torn_down')
    expect(second).toBe('busy')
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.stripe.made).toHaveLength(1)
    expect(w.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('billing in review past the window is never refunded or torn down automatically', async () => {
    await w.redis.hset(stateKey, { billing: 'review' })
    await cron(w)
    expect((await w.state()).status).toBe('ready')
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('resumeRefund leaves a sign-up that is not refunding alone', async () => {
    expect(await resumeRefund(SID, w.deps)).toBe('skipped')
    expect(w.stripe.invoices.retrieve).not.toHaveBeenCalled()
  })

  it('sweepRefunds with an empty index reports zeros', async () => {
    const v = world()
    expect(await sweepRefunds(v.sweepDeps)).toEqual({ due: 0, refunded: 0, pending: 0, problems: 0, tornDown: 0, busy: 0, cleared: 0, errors: 0, waiting: 0 })
  })

  it('log lines hold fixed words only: no session, provision, refund, payment intent, subscription or invoice id, and no email', async () => {
    await cron(w)
    for (const canary of [SID, PID, 're_1', PI, SUB, INVOICE, EMAIL, 'cus_r1']) expect(w.logs.join('\n')).not.toContain(canary)
    expect(w.logs).toContain('cron-sweep: billing due=1 charged=0 held=0 declined=0 pending=0 activated=0 busy=0 errors=0 refundStarted=1 refundBusy=0')
  })
})

// --- kill after each step, resumed through the real cron entry point (Codex 3) ---------------------

describe('kill after each step: every run ends with one refund call at most, one cancel, one mail and one dispatch (23-43 Task 6, Codex 3)', () => {
  const POINTS: Array<[string, (set: Record<string, string>) => boolean]> = [
    ['step 1, the last activation try', set => set.status === 'refunding'],
    ['step 2, the refunding step', set => set.intentOp === 'cancel'],
    ['step 3, the cancel (at the refund start, C1)', set => set.intentOp === 'refund'],
    ['step 4, the refund', set => set.status === 'refunded'],
    ['step 5, refunded', set => set.status === 'tearing_down'],
    ['step 6, inside the runner after the mail', set => set.intentOp === 'dispatch']
  ]
  const cases = POINTS.flatMap(([name, match]) => (['throw', 'lost'] as const).map(mode => [name, mode, match] as const))

  it.each(cases)('the run stopped right after %s (%s) is finished by the next cron runs', async (_name, mode, match) => {
    const w = world()
    await seedPaid(w.redis)
    killBefore(w, match, mode)
    await cron(w)
    vi.mocked(w.redis.eval).mockRestore()
    for (let tick = 0; tick < 6; tick++) {
      await freeStolenLock(w)
      w.clock.now += 61000
      await cron(w)
    }
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', teardownReason: 'activation_failed', refundId: 're_1', tornDown: true, stopApp: true, stopMail: true })
    expect(w.stripe.refunds.create.mock.calls.length).toBeLessThanOrEqual(1)
    expect(w.stripe.made).toHaveLength(1)
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(w.refundMails()).toHaveLength(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(s.activatedAt).toBeUndefined()
    expect(w.sent.every(status => status === 'ready')).toBe(true)
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
  })
})

// --- exactly one winner: activation or refund ---------------------------------------------------------

describe('exactly one winner: activation and refund never both win (23-43 Task 6)', () => {
  it('(a) the site was activated but the reply was lost: the last try gets 200, complete is written, no refund, no teardown, teardown-check 409', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.setActivation(async () => reply(200, { activated: true }))
    expect(await refundAndTearDown(SID, w.deps)).toBe('activated')
    const s = await w.state()
    expect(s.status).toBe('complete')
    expect(typeof s.activatedAt).toBe('string')
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(0)
    expect(w.stripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
    expect(await w.redis.zrange(BILLING_INDEX, 0, -1)).toEqual([])
  })

  it.each([
    ['a 503', async () => reply(503, { error: 'mail_failed' })],
    ['a network error', async () => { throw new TypeError('fetch failed') }]
  ])('(b) the last try gets %s: the refund wins, and complete is refused on every path afterwards', async (_l, answer) => {
    const w = world()
    await seedPaid(w.redis)
    w.setActivation(answer as never)
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    w.setActivation(async () => reply(200, { activated: true }))
    expect(await resumeBilling(SID, w.billing)).toBe('skipped')
    await handleProvisionStatus(SID, w.redis as never, { billing: { nudge: (sid, pid) => nudgeBilling(sid, pid, w.billing) } })
    expect(await onFirstInvoicePaid(PID, w.billing, SUB, { id: INVOICE, amount_paid: PRICE, currency: 'usd' })).toBe('skipped')
    expect((await transition(w.redis, SID, 'complete', { provisionId: PID })).result).toBe('refused')
    const s = await w.state()
    expect(s.status).toBe('tearing_down')
    expect(s.activatedAt).toBeUndefined()
    // No activation POST after the refunding step: every one was sent while the sign-up was ready.
    expect(w.sent).toEqual(['ready'])
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
    // invoice.paid redelivered for a refund case is not a payment on a voided sign-up.
    expect(await w.flags()).toEqual([`refund_started:${SID}`])
  })

  it('(c) an activation run holding the lease when the sweep comes: the refund answers busy and writes nothing', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.clock.now = PAID_AT + DAY - 1000
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    w.setActivation(async () => {
      await held
      return reply(503, { error: 'mail_failed' })
    })
    const activation = resumeBilling(SID, w.billing)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    w.clock.now = PAID_AT + DAY + 1000
    const before = w.redis.dump()
    expect(await refundAndTearDown(SID, w.deps)).toBe('busy')
    expect(w.redis.dump()).toBe(before)
    release()
    await activation
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
  })

  it('lateActivation: a 200 from an activation already in flight, seen after the refunding step, writes lateActivation and a late_activation flag and changes nothing else; the mail then says only "We\'ve refunded your payment in full."', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.clock.now = PAID_AT + DAY - 1000
    let answer!: () => void
    const inFlight = new Promise<void>(r => { answer = r })
    let calls = 0
    w.setActivation(async () => {
      calls++
      if (calls === 1) {
        await inFlight
        return reply(200, { activated: true })
      }
      return reply(503, { error: 'mail_failed' })
    })
    // An activation run whose request hangs; its lease runs out (another token takes the lock, then it expires).
    const stale = resumeBilling(SID, w.billing)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    await w.redis.del(lockKey)
    w.clock.now = PAID_AT + DAY + 1000
    // The site answers the stale request while the refund is being made.
    const realCreate = w.stripe.refunds.create.getMockImplementation()!
    w.stripe.refunds.create.mockImplementation(async (params, o) => {
      answer()
      await stale
      return realCreate(params, o)
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', lateActivation: true, refundId: 're_1' })
    expect(s.activatedAt).toBeUndefined()
    expect(await w.flags()).toEqual([`late_activation:${SID}`, `refund_started:${SID}`].sort())
    const [, init] = w.refundMails()[0]! as [string, { body: { text: string } }]
    expect(init.body.text.split('\n\n')[0]).toBe('We\'ve refunded your payment in full.')
    expect(init.body.text).not.toMatch(/couldn't finish/)
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
  })

  it('(d) many interleavings of the sweep, status nudges and invoice.paid: no final record holds a refundId together with complete or activatedAt', async () => {
    for (let round = 0; round < 24; round++) {
      const w = world()
      await seedPaid(w.redis)
      // Odd rounds start with the window still open, so nudges and invoice.paid make activation tries too.
      if (round % 2 === 1) w.clock.now = PAID_AT + DAY - 30000
      const wins = round % 3 === 0
      const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
      w.setActivation(async () => {
        await delay(round % 4)
        return wins && w.sent.length >= 2 ? reply(200, { activated: true }) : reply(503, { error: 'mail_failed' })
      })
      const runs = [
        () => cron(w),
        () => refundAndTearDown(SID, w.deps),
        () => handleProvisionStatus(SID, w.redis as never, { billing: { nudge: (sid, pid) => nudgeBilling(sid, pid, w.billing) } }),
        () => onFirstInvoicePaid(PID, w.billing, SUB, { id: INVOICE, amount_paid: PRICE, currency: 'usd' }),
        () => resumeBilling(SID, w.billing),
        () => resumeRefund(SID, w.deps)
      ]
      const order = runs.map((_, i) => (i * 7 + round) % runs.length)
      await Promise.allSettled(order.map(async (i, k) => {
        await delay((k + round) % 3)
        return runs[i]!()
      }))
      for (let tick = 0; tick < 4; tick++) {
        w.clock.now += 61000
        await cron(w)
      }
      const s = await w.state()
      const refunded = Boolean(s.refundId) || w.stripe.made.length > 0
      const activated = s.status === 'complete' || Boolean(s.activatedAt)
      expect(refunded && activated, `round ${round}: ${JSON.stringify(s)}`).toBe(false)
      expect(refunded || activated, `round ${round}`).toBe(true)
      expect(w.stripe.made.length).toBeLessThanOrEqual(1)
      if (refunded) expect(w.dispatch).toHaveBeenCalledTimes(1)
      else expect(w.dispatch).not.toHaveBeenCalled()
    }
  })
})

// Orchestrator ruling (a), 2026-11-09 (23-ORCH-INBOX.md): a zero-charge sign-up
// (refundZero) whose late activation lands before the delete is asked for keeps
// its site: one guarded, fenced step (keepLateActivation) under the lifecycle
// lock, taken by whichever runner holds the lock at that moment. The welcome
// mail is the site's own (Drupal sends it on activation); this app sends no
// Stopped mail afterwards. If the delete was already asked for, nothing changes:
// the late_activation flag stays and a person reaches out.
describe('orchestrator ruling (a): a free site that activates late (23-43 Task 7)', () => {
  /** An activation run whose request hangs while its lease is lost; its 200 lands when answer() is called. */
  async function staleActivation(w: World) {
    w.clock.now = PAID_AT + DAY - 1000
    let answer!: () => void
    const inFlight = new Promise<void>(r => { answer = r })
    let calls = 0
    w.setActivation(async () => {
      calls++
      if (calls === 1) {
        await inFlight
        return reply(200, { activated: true })
      }
      return reply(503, { error: 'mail_failed' })
    })
    const stale = resumeBilling(SID, w.billing)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    await w.redis.del(lockKey)
    w.clock.now = PAID_AT + DAY + 1000
    return { answer, stale }
  }
  const stoppedMails = (w: World) => w.refundMails()

  it('activation wins before the dispatch: the late 200 lands during the cancel; the runner keeps the site live (complete), no Stopped mail, no card detach, no delete, teardown-check 409, flagged kept', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    const { answer, stale } = await staleActivation(w)
    w.stripe.subscriptions.cancel.mockImplementation(async () => {
      answer()
      await stale
      return { id: SUB, status: 'canceled' }
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('activated')
    const s = await w.state()
    expect(s).toMatchObject({ status: 'complete', lateActivation: true, refundZero: true, lateKeptAfter: 'cancel' })
    expect(typeof s.activatedAt).toBe('string')
    expect(stoppedMails(w)).toHaveLength(0)
    expect(w.stripe.paymentMethods.detach).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
    expect(await w.flags()).toEqual([`late_activation:${SID}`, `late_activation:${SID}:kept:mail_none:cancel`, `refund_started:${SID}`].sort())
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    expect(await w.redis.zrange(TEARDOWN_INDEX, 0, -1)).toEqual([])
    // The page shows the normal welcome path, not the Stopped screen (P5).
    expect(await handleProvisionStatus(SID, w.redis as never)).toMatchObject({ status: 'complete', stopped: false })
    // Later cron runs leave it alone.
    w.clock.now += 61000
    await cron(w)
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(stoppedMails(w)).toHaveLength(0)
  })

  it('dispatch wins first: the late 200 lands while the delete is being sent; no state change, the teardown proceeds, the late_activation flag is raised and no kept flag', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    const { answer, stale } = await staleActivation(w)
    w.dispatch.mockImplementation(async () => {
      answer()
      await stale
      return undefined
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', lateActivation: true, refundZero: true, stopApp: true, tornDown: true })
    expect(s.activatedAt).toBeUndefined()
    expect(s.lateKeptAt).toBeUndefined()
    expect(w.dispatch).toHaveBeenCalledTimes(1)
    expect(stoppedMails(w)).toHaveLength(1)
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
    expect(await w.flags()).toEqual([`late_activation:${SID}`, `refund_started:${SID}`].sort())
  })

  it('a Stopped mail already sent is recorded on the flag: the runner stopped after the mail and before the delete; the late 200 then takes the free lock and keeps the site live', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    const { answer, stale } = await staleActivation(w)
    // The run stops right before the delete's intent (both tries), and no other step resumes it yet.
    killBefore(w, set => set.intentOp === 'dispatch', 'throw')
    await expect(refundAndTearDown(SID, w.deps)).rejects.toThrow(/killed/)
    vi.mocked(w.redis.eval).mockRestore()
    expect(await w.state()).toMatchObject({ status: 'tearing_down', stopMail: true })
    expect(stoppedMails(w)).toHaveLength(1)
    answer()
    await stale
    const s = await w.state()
    expect(s).toMatchObject({ status: 'complete', stoppedMail: 'sent', lateKeptAfter: 'cancel,hold,lock,card,invite,capacity,aikey' })
    expect(await w.flags()).toContain(`late_activation:${SID}:kept:mail_sent:cancel,hold,lock,card,invite,capacity,aikey`)
    w.clock.now += 61000
    await cron(w)
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
  })

  it('the late 200 lands while the Stopped mail is being sent: the runner keeps the site at its check before the delete, and the flag records the mail as sent', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    const { answer, stale } = await staleActivation(w)
    w.mailFetch.mockImplementation(async () => {
      answer()
      await stale
      return { id: 'email_1' }
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('activated')
    expect(await w.state()).toMatchObject({ status: 'complete', stoppedMail: 'sent', lateKeptAfter: 'cancel,hold,lock,card,invite,capacity,aikey' })
    expect(stoppedMails(w)).toHaveLength(1)
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.flags()).toContain(`late_activation:${SID}:kept:mail_sent:cancel,hold,lock,card,invite,capacity,aikey`)
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
  })

  it('a paid sign-up whose late 200 lands before the delete is still refunded and torn down: the keep is for a zero invoice only', async () => {
    const w = world()
    await seedPaid(w.redis)
    const { answer, stale } = await staleActivation(w)
    w.stripe.subscriptions.cancel.mockImplementation(async () => {
      answer()
      await stale
      return { id: SUB, status: 'canceled' }
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    expect(await w.state()).toMatchObject({ status: 'tearing_down', lateActivation: true, refundId: 're_1' })
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })
})

// Code review fix round 1, C4: the refund runner's own last activation try can
// succeed after its lease was lost. Its fenced complete is then dropped, and the
// 200 must still be recorded (lateActivation and the late_activation flag), as
// billing.ts does for its tries; otherwise a free site misses the keep and a
// paid one keeps the setup-failure wording.
describe('C4: the refund runner records a late activation its lost lease could not apply', () => {
  it('the last try\'s 200 lands after another runner took the lock and started the refund: lateActivation and the flag are written, nothing is activated', async () => {
    const w = world()
    await seedPaid(w.redis)
    let answer!: () => void
    const inFlight = new Promise<void>(r => { answer = r })
    let calls = 0
    w.setActivation(async () => {
      calls++
      if (calls === 1) {
        await inFlight
        return reply(200, { activated: true })
      }
      return reply(503, { error: 'mail_failed' })
    })
    // The first runner's last try hangs; its lease is lost (another token takes the lock, then frees it).
    const first = refundAndTearDown(SID, w.deps)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    await w.redis.del(lockKey)
    // A second runner: its last try answers 503, so it starts the refund and finishes the teardown.
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    // The first runner's 200 lands now.
    answer()
    expect(await first).toBe('lost')
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', lateActivation: true, refundId: 're_1' })
    expect(s.activatedAt).toBeUndefined()
    expect(await w.flags()).toContain(`late_activation:${SID}`)
    expect(w.logs).toContain('billing: the site activated after the refund began; flagged for a person')
  })
})

// Code review fix round 1, C1 (23-43-CODE-REVIEW.md): a refund that stays
// pending or requires_action past 72 h let the record expire; sweepRefunds then
// dropped it and the subscription, cancelled only after a succeeded refund,
// could renew. Now every refund row raises the record to 72 h (each poll raises
// it again), the subscription is cancelled when the refund starts, and a refund
// still pending 7 days after the refund started is flagged for a person
// (refund_problem:{sid}:pending), while it stays refunding and is still polled.
describe('C1: a refund pending for days keeps its record, its subscription is already cancelled, and a person is told after 7 days', () => {
  const HOUR = 3600000
  /** Run the cron every `stepMs` for `totalMs`, moving the app clock and Redis's clock together. */
  async function wait(w: World, totalMs: number, stepMs: number) {
    for (let t = 0; t < totalMs; t += stepMs) {
      w.clock.now += stepMs
      w.redis.advance(stepMs / 1000)
      await cron(w)
    }
  }

  it('the cancel happens at the refund start: refundCancelled before any refund call, and while the refund is pending', async () => {
    const w = world({ refundStatus: 'requires_action' })
    await seedPaid(w.redis)
    await cron(w)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundStatus: 'requires_action', refundCancelled: true })
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledWith(SUB, { invoice_now: false, prorate: false }, OPTS)
    expect(w.stripe.subscriptions.cancel.mock.invocationCallOrder[0]!).toBeLessThan(w.stripe.refunds.create.mock.invocationCallOrder[0]!)
    // Polls never cancel again.
    await wait(w, 3 * 61000, 61000)
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
  })

  it('the record outlives 72 h while the refund is pending: every poll raises all three keys to 72 h again; once it succeeds the teardown runs', async () => {
    const w = world({ refundStatus: 'pending' })
    await seedPaid(w.redis)
    await cron(w)
    // Five days of polls, every 6 hours (each one a refundPending step).
    await wait(w, 5 * DAY, 6 * HOUR)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundId: 're_1', refundStatus: 'pending' })
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(`provision:by-id:${PID}`)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(signupKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    w.stripe.made[0]!.status = 'succeeded'
    await wait(w, 61000, 61000)
    expect(await w.state()).toMatchObject({ status: 'tearing_down', tornDown: true, refundCancelled: true })
    expect(w.stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a refund still pending 7 days after the refund started is flagged refund_problem for a person, once; it stays refunding, polled, and its keys are still raised', async () => {
    const w = world({ refundStatus: 'pending' })
    await seedPaid(w.redis)
    await cron(w)
    await wait(w, 6 * DAY, 12 * HOUR)
    expect(await w.flags()).not.toContain(`refund_problem:${SID}:pending`)
    await wait(w, DAY + HOUR, 12 * HOUR)
    const flags = await w.flags()
    expect(flags).toContain(`refund_problem:${SID}:pending`)
    const raisedAt = await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:pending`)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundStatus: 'pending' })
    expect(s.refundProblem).toBeUndefined()
    expect(typeof s.refundStaleAt).toBe('string')
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    // Still polled and still raised; the flag is not raised again.
    const polls = w.stripe.refunds.retrieve.mock.calls.length
    await wait(w, 2 * DAY, 12 * HOUR)
    expect(w.stripe.refunds.retrieve.mock.calls.length).toBeGreaterThan(polls)
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:pending`)).toBe(raisedAt)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })
})

// Code review fix round 1, C2 (orchestrator ruling (a)): the last keptLate()
// read before the delete and the dispatch intent were two steps. A late 200 that
// lands between them was recorded (lateActivation) but the intent still wrote
// dispatchAskedAt and the site was deleted. The dispatch intent is now one
// guarded transition that refuses while lateActivation is set on a zero-charge
// (refundZero) sign-up, and the runner then keeps the site.
describe('C2: a late activation that lands between the last check and the dispatch intent keeps a free site', () => {
  async function staleActivation(w: World) {
    w.clock.now = PAID_AT + DAY - 1000
    let answer!: () => void
    const inFlight = new Promise<void>(r => { answer = r })
    let calls = 0
    w.setActivation(async () => {
      calls++
      if (calls === 1) {
        await inFlight
        return reply(200, { activated: true })
      }
      return reply(503, { error: 'mail_failed' })
    })
    const stale = resumeBilling(SID, w.billing)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    await w.redis.del(lockKey)
    w.clock.now = PAID_AT + DAY + 1000
    return { answer, stale }
  }

  /** The late 200 lands right before the dispatch intent's EVAL, after the runner's last keptLate() read. */
  function landBeforeDispatchIntent(w: World, land: () => Promise<void>) {
    const original = w.redis.eval.bind(w.redis)
    let fired = false
    vi.spyOn(w.redis, 'eval').mockImplementation(async (script: string, keys: string[], args: unknown[]) => {
      if (!fired && script === TRANSITION_SCRIPT && setFields(args as string[]).intentOp === 'dispatch') {
        fired = true
        await land()
      }
      return original(script, keys, args)
    })
  }

  it('zero charge: the site is kept (complete), the delete is never asked for, teardown-check answers 409, flagged kept', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    const { answer, stale } = await staleActivation(w)
    landBeforeDispatchIntent(w, async () => {
      answer()
      await stale
      expect((await w.state()).lateActivation).toBe(true)
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('activated')
    const s = await w.state()
    expect(s).toMatchObject({ status: 'complete', lateActivation: true, refundZero: true, stoppedMail: 'sent' })
    expect(typeof s.activatedAt).toBe('string')
    expect(s.dispatchAskedAt).toBeUndefined()
    expect(s.stopApp).toBeUndefined()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
    expect(await w.flags()).toContain(`late_activation:${SID}:kept:mail_sent:cancel,hold,lock,card,invite,capacity,aikey`)
  })

  it('a real payment: the same late 200 never keeps the site; the delete goes ahead', async () => {
    const w = world()
    await seedPaid(w.redis)
    const { answer, stale } = await staleActivation(w)
    landBeforeDispatchIntent(w, async () => {
      answer()
      await stale
    })
    expect(await refundAndTearDown(SID, w.deps)).toBe('torn_down')
    expect(await w.state()).toMatchObject({ status: 'tearing_down', lateActivation: true, refundId: 're_1', stopApp: true })
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })
})

// Code review round 2, R2-1 (escalation answer (a)): with the cancel first, a
// cancel that kept failing threw before the refund, and nothing on that path
// raised the record's lifetime; after 72 h the record expired with no refund
// and a live subscription. Now every refund-runner pass raises the lifetime
// first (refundTick, and a floor on the intent row), a failed cancel never
// blocks the refund, the cancel is retried on later passes, an unresolved
// cancel is flagged refund_problem:{sid}:cancel once after 7 days, and the
// record turns refunded only when both are done.
describe('R2-1: a failing cancel never blocks the refund, and the record stays alive', () => {
  const HOUR = 3600000
  async function wait(w: World, totalMs: number, stepMs: number) {
    for (let t = 0; t < totalMs; t += stepMs) {
      w.clock.now += stepMs
      w.redis.advance(stepMs / 1000)
      await cron(w)
    }
  }
  const stripeDown = () => new Stripe.errors.StripeAPIError({ message: 'Stripe is down', statusCode: 500 })

  it('the cancel fails on every pass: the refund is made anyway, the record is not refunded, the cancel is retried, and the keys stay alive for days', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    let s = await w.state()
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(s).toMatchObject({ status: 'refunding', refundDone: true, refundId: 're_1' })
    expect(s.refundCancelled).toBeUndefined()
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    const tries = w.stripe.subscriptions.cancel.mock.calls.length
    await wait(w, 5 * DAY, 6 * HOUR)
    s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundDone: true })
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBeGreaterThan(tries)
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(`provision:by-id:${PID}`)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(signupKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
  })

  it('the cancel succeeds on a later pass: refunded only then, and the teardown follows', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    await wait(w, 2 * 61000, 61000)
    expect((await w.state()).status).toBe('refunding')
    w.stripe.subscriptions.cancel.mockResolvedValue({ id: SUB, status: 'canceled' })
    await wait(w, 61000, 61000)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', refundDone: true, refundCancelled: true, tornDown: true })
    expect(typeof s.refundedAt).toBe('string')
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.refundMails()).toHaveLength(1)
    expect(w.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a cancel still failing 7 days after the refund started is flagged refund_problem:{sid}:cancel once; the record stays refunding, retried and alive', async () => {
    const w = world()
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    await wait(w, 6 * DAY, 12 * HOUR)
    expect(await w.flags()).not.toContain(`refund_problem:${SID}:cancel`)
    await wait(w, DAY + HOUR, 12 * HOUR)
    expect(await w.flags()).toContain(`refund_problem:${SID}:cancel`)
    const raisedAt = await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:cancel`)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundDone: true })
    expect(typeof s.refundCancelStaleAt).toBe('string')
    const tries = w.stripe.subscriptions.cancel.mock.calls.length
    await wait(w, 2 * DAY, 12 * HOUR)
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBeGreaterThan(tries)
    expect(await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:cancel`)).toBe(raisedAt)
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
  })

  it('a Stripe outage on every poll of a pending refund (no row applies) still keeps the record alive: the pass raises it first', async () => {
    const w = world({ refundStatus: 'pending' })
    await seedPaid(w.redis)
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundCancelled: true, refundStatus: 'pending' })
    w.stripe.refunds.retrieve.mockRejectedValue(stripeDown())
    await wait(w, 5 * DAY, 6 * HOUR)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundId: 're_1' })
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
  })
})

// Code review round 2, R2-2 (escalation answer (a)): notboth refused every
// dispatch while a zero charge's late activation was recorded, including a
// retry after the first dispatch intent had already applied (dispatchAskedAt)
// and GitHub had errored. The keep refuses then too (dispatchAskedAt), so the
// stop was stuck forever. notboth now applies to the first dispatch decision
// only; a retry of a recorded dispatch goes through, and the late_activation
// flag (raised with the field) tells a person to reach out.
describe('R2-2: a retried dispatch after a recorded one goes through, with the late-activation flag', () => {
  it('the dispatch intent applies, GitHub errors, a stale activation records lateActivation; the next teardown pass sends the delete', async () => {
    const w = world({ amountPaid: 0 })
    await seedPaid(w.redis, { amountPaid: 0 })
    w.clock.now = PAID_AT + DAY - 1000
    let answer!: () => void
    const inFlight = new Promise<void>(r => { answer = r })
    let calls = 0
    w.setActivation(async () => {
      calls++
      if (calls === 1) {
        await inFlight
        return reply(200, { activated: true })
      }
      return reply(503, { error: 'mail_failed' })
    })
    const stale = resumeBilling(SID, w.billing)
    await vi.waitFor(() => expect(w.fetchMock).toHaveBeenCalledTimes(1))
    await w.redis.set(lockKey, 'another-runner', { px: 60000 })
    await w.redis.del(lockKey)
    w.clock.now = PAID_AT + DAY + 1000
    w.dispatch.mockRejectedValueOnce(new Error('github: 502'))
    await expect(refundAndTearDown(SID, w.deps)).rejects.toThrow(/github/)
    expect(await w.state()).toMatchObject({ status: 'tearing_down', refundZero: true })
    expect(typeof (await w.state()).dispatchAskedAt).toBe('string')
    answer()
    await stale
    expect((await w.state()).lateActivation).toBe(true)
    for (let tick = 0; tick < 3; tick++) {
      w.clock.now += 61000
      await cron(w)
    }
    const s = await w.state()
    expect(s).toMatchObject({ status: 'tearing_down', lateActivation: true, stopApp: true, tornDown: true })
    expect(s.activatedAt).toBeUndefined()
    expect(w.dispatch).toHaveBeenCalledTimes(2)
    expect(await w.flags()).toContain(`late_activation:${SID}`)
    expect((await w.flags()).some(f => f.includes(':kept:'))).toBe(false)
    expect(await w.check()).toEqual({ status: 200, body: { teardown: true } })
  })
})

// Code review round 3 (the confirming pass, 2026-11-11), R3-1. The rule, kept
// in tests/unit/subscription-rule.test.ts: "A sign-up never leaves every sweep
// while its Stripe subscription can still renew." R2-1 let the refund go ahead
// after a failed cancel, which made a new combination reachable: the refund
// then turns into a problem for a person while the cancel is still not done.
// refundProblem took the sign-up out of sweep:refund and the runner returned
// before the cancel, so nothing retried the cancel or renewed the record.
// Now a refund problem whose cancel is not done stays in sweep:refund: each
// pass raises the record and retries the cancel only. It never calls the
// refund again, never mails and never tears down, and it leaves the sweep once
// the cancel is recorded done (refundProblemSettled).
describe('R3-1: a refund problem with the cancel not done stays in sweep:refund until the cancel is done', () => {
  const HOUR = 3600000
  async function wait(w: World, totalMs: number, stepMs: number) {
    for (let t = 0; t < totalMs; t += stepMs) {
      w.clock.now += stepMs
      w.redis.advance(stepMs / 1000)
      await cron(w)
    }
  }
  const stripeDown = () => new Stripe.errors.StripeAPIError({ message: 'Stripe is down', statusCode: 500 })
  const refundCalls = (w: World) => ({
    create: w.stripe.refunds.create.mock.calls.length,
    list: w.stripe.refunds.list.mock.calls.length,
    retrieve: w.stripe.refunds.retrieve.mock.calls.length,
    payments: w.stripe.invoicePayments.list.mock.calls.length,
    invoice: w.stripe.invoices.retrieve.mock.calls.length
  })

  it('the cancel is retried on every pass and the record stays alive for days; no refund call, no mail, no teardown', async () => {
    const w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    let s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundProblem: 'partial', refundId: 're_1' })
    expect(s.refundCancelled).toBeUndefined()
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    expect(await w.flags()).toEqual([`refund_problem:${SID}`, `refund_problem:${SID}:cancel`, `refund_started:${SID}`].sort())
    const raisedAt = await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:cancel`)
    const tries = w.stripe.subscriptions.cancel.mock.calls.length
    const before = refundCalls(w)
    await wait(w, 5 * DAY, 6 * HOUR)
    s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundProblem: 'partial' })
    expect(s.refundCancelled).toBeUndefined()
    expect(s.refundSettledAt).toBeUndefined()
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBeGreaterThanOrEqual(tries + 20)
    expect(refundCalls(w)).toEqual(before)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(`provision:by-id:${PID}`)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(signupKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.zscore('reconcile:flags', `refund_problem:${SID}:cancel`)).toBe(raisedAt)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect(await w.check()).toEqual({ status: 409, body: { teardown: false } })
  })

  it('once the cancel goes through the sign-up leaves the sweep: still a refund problem for a person, never refunded, mailed or torn down, and nothing is called again', async () => {
    const w = world({ refundStatus: 'failed' })
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    await wait(w, 3 * 61000, 61000)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    w.stripe.subscriptions.cancel.mockResolvedValue({ id: SUB, status: 'canceled' })
    await wait(w, 61000, 61000)
    const s = await w.state()
    expect(s).toMatchObject({ status: 'refunding', refundProblem: 'failed', refundCancelled: true })
    expect(typeof s.refundSettledAt).toBe('string')
    expect(s.refundedAt).toBeUndefined()
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    const cancels = w.stripe.subscriptions.cancel.mock.calls.length
    const reads = w.stripe.subscriptions.retrieve.mock.calls.length
    const before = refundCalls(w)
    await wait(w, 5 * 61000, 61000)
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBe(cancels)
    expect(w.stripe.subscriptions.retrieve.mock.calls.length).toBe(reads)
    expect(refundCalls(w)).toEqual(before)
    expect(w.stripe.refunds.create).toHaveBeenCalledTimes(1)
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
    expect((await w.state()).status).toBe('refunding')
  })

  it('a subscription found already canceled at Stripe after a cancel error counts as done and the sign-up leaves the sweep', async () => {
    const w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([SID])
    w.stripe.subscriptions.retrieve.mockResolvedValue({ id: SUB, created: 1, status: 'canceled', latest_invoice: { id: INVOICE, status: 'paid', amount_paid: PRICE, currency: 'usd' } })
    await wait(w, 61000, 61000)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundProblem: 'partial', refundCancelled: true })
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
  })

  it('a direct resume of a refund problem whose cancel is not done retries the cancel and answers problem; one already settled calls nothing', async () => {
    const w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(stripeDown())
    await cron(w)
    const tries = w.stripe.subscriptions.cancel.mock.calls.length
    expect(await resumeRefund(SID, w.deps)).toBe('problem')
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBe(tries + 1)
    w.stripe.subscriptions.cancel.mockResolvedValue({ id: SUB, status: 'canceled' })
    expect(await resumeRefund(SID, w.deps)).toBe('problem')
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    const settled = w.stripe.subscriptions.cancel.mock.calls.length
    expect(await resumeRefund(SID, w.deps)).toBe('problem')
    expect(w.stripe.subscriptions.cancel.mock.calls.length).toBe(settled)
  })

  // The confirming pass, disclosure 1: refundAndTearDown resumes a refund already started without
  // writing a fresh refunding row, so only continueRefund's own refundTick raises the record there.
  it('refundAndTearDown resuming a pending refund while Stripe is down raises the record before its first Stripe call', async () => {
    const w = world({ refundStatus: 'pending' })
    await seedPaid(w.redis)
    await cron(w)
    expect(await w.state()).toMatchObject({ status: 'refunding', refundCancelled: true, refundStatus: 'pending' })
    w.stripe.refunds.retrieve.mockRejectedValue(stripeDown())
    w.clock.now += 71 * HOUR
    w.redis.advance(71 * 3600)
    expect(await w.redis.pttl(stateKey)).toBeLessThan(2 * HOUR)
    await expect(refundAndTearDown(SID, w.deps)).rejects.toThrow()
    expect(await w.redis.pttl(stateKey)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(`provision:by-id:${PID}`)).toBeGreaterThan(70 * HOUR)
    expect(await w.redis.pttl(signupKey)).toBeGreaterThan(70 * HOUR)
  })
})

// Code review round 3, R3-2 (the last confirming pass, 2026-11-11). The refunds step reads the 50
// oldest due members of sweep:refund. A sign-up whose cancel keeps failing kept its old score, so
// with 50 of them the same 50 were read on every run and a 51st got no pass: no cancel try, no
// lifetime raised, and its record ran out with the subscription still able to renew. Now the
// first write of every pass (refundTick) also moves the sign-up to the back of the queue, so
// every member is reached in turn, and the step's counts say how many due members were left over.
const MANY = 51
const manySid = (i: number) => `cs_test_many_${String(i).padStart(2, '0')}`
const manySub = (i: number) => `many${String(i).padStart(2, '0')}`
const manyPid = (i: number) => `MaNy${String(i).padStart(18, '0')}`
async function seedMany(redis: FakeRedis, index: string, fields: (i: number) => Record<string, unknown>, score: (i: number) => number) {
  for (let i = 1; i <= MANY; i++) {
    await redis.set(`provision:by-id:${manyPid(i)}`, manySid(i), { ex: 3600 })
    await redis.hset(`signup:${manyPid(i)}`, { subdomain: manySub(i), email: `m${i}@example.org`, stripeCustomerId: `cus_m${i}`, priceId: 'price_1' })
    await redis.expire(`signup:${manyPid(i)}`, 3600)
    await redis.hset(`provision:${manySid(i)}`, { provisionId: manyPid(i), attempt: 1, failedAttempts: 0, subdomain: manySub(i), siteUrl: `https://${manySub(i)}.localnodes.xyz`, appUuid: `app-m${i}`, ...fields(i) })
    await redis.expire(`provision:${manySid(i)}`, 3600)
    await redis.zadd(index, { score: score(i), member: manySid(i) })
  }
}
const firstArgs = (fn: { mock: { calls: unknown[][] } }) => new Set(fn.mock.calls.map(c => String(c[0])))
const down = () => new Stripe.errors.StripeAPIError({ message: 'Stripe is down', statusCode: 500 })

describe('R3-2: more than 50 stuck refunds do not starve the rest', () => {
  const HOUR = 3600000
  const stuck = (now: number) => (i: number): Record<string, unknown> => ({
    status: 'refunding',
    teardownReason: 'activation_failed',
    billing: 'paid',
    subscriptionId: `sub_m${i}`,
    invoiceId: `in_m${i}`,
    amountPaid: PRICE,
    currency: 'usd',
    refundingAtMs: now,
    refundId: `re_m${i}`,
    // Odd: a refund problem with the cancel not done (R3-1). Even: refunded, the cancel still failing (R2-1).
    ...(i % 2 ? { refundProblem: 'partial', refundCancelStaleAt: 'x' } : { refundDone: true, refundStatus: 'succeeded', refundSucceededAt: new Date(now).toISOString() })
  })

  it('51 sign-ups whose cancel keeps failing: the 51st is served on the second run, every record is kept alive, and no refund is made', async () => {
    const w = world()
    await seedMany(w.redis, REFUND_INDEX, stuck(w.clock.now), i => w.clock.now - 100000 + i)
    w.stripe.subscriptions.cancel.mockRejectedValue(down())
    const first = await sweepRefunds(w.sweepDeps)
    expect(first).toMatchObject({ due: 50, waiting: 1 })
    expect(firstArgs(w.stripe.subscriptions.cancel).has('sub_m51')).toBe(false)
    w.clock.now += 1000
    const second = await sweepRefunds(w.sweepDeps)
    expect(second.due).toBe(50)
    expect(firstArgs(w.stripe.subscriptions.cancel).has('sub_m51')).toBe(true)
    w.clock.now += 1000
    await sweepRefunds(w.sweepDeps)
    expect(firstArgs(w.stripe.subscriptions.cancel).size).toBe(MANY)
    for (let i = 1; i <= MANY; i++) {
      expect(await w.redis.pttl(`provision:${manySid(i)}`), manySid(i)).toBeGreaterThan(70 * HOUR)
      expect(await w.redis.zscore(REFUND_INDEX, manySid(i)), manySid(i)).not.toBeNull()
    }
    expect(w.stripe.refunds.create).not.toHaveBeenCalled()
    expect(w.mailFetch).not.toHaveBeenCalled()
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('a run that reads every due member reports nothing waiting', async () => {
    const w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    w.stripe.subscriptions.cancel.mockRejectedValue(down())
    await cron(w)
    w.clock.now += 61000
    expect(await sweepRefunds(w.sweepDeps)).toMatchObject({ due: 1, waiting: 0 })
  })

  it('a settled refund problem resumed directly is not put back into sweep:refund', async () => {
    const w = world({ refundAmount: 4800 })
    await seedPaid(w.redis)
    await cron(w)
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
    expect(await resumeRefund(SID, w.deps)).toBe('problem')
    expect(await w.redis.zrange(REFUND_INDEX, 0, -1)).toEqual([])
  })
})

// The same question for the other three sweeps that can hold a sign-up with a subscription, as
// tests only (orchestrator, 2026-11-11: report what they show, fix nothing in this diff). Each
// seeds 51 members whose step keeps failing and asks whether the 51st is reached within two runs.
// A test named KNOWN GAP pins a sweep that does NOT reach it today: it asserts the first member is
// tried and the 51st is not, so it fails once the gap is closed and closing it has to come back
// here. The launch-gate todo "sweep fairness across all five sweeps before capacity is raised
// above 50" tracks them.
describe('sweep fairness with 51 stuck members, the other sweeps (tests only, R3-2 follow-up)', () => {
  it('sweep:billing: 51 paid sign-ups whose site keeps refusing activation; the 51st is tried within two runs', async () => {
    const w = world()
    w.clock.now = PAID_AT + 60000
    await seedMany(w.redis, BILLING_INDEX, i => ({
      status: 'ready', billing: 'paid', subscriptionId: `sub_m${i}`, invoiceId: `in_m${i}`, amountPaid: PRICE, currency: 'usd',
      siteAnsweredAt: new Date(PAID_AT).toISOString(), readyAtMs: PAID_AT, paidAt: new Date(PAID_AT).toISOString(), activationDeadline: PAID_AT + DAY
    }), i => PAID_AT + i)
    const run = () => sweepBilling({ ...w.sweepDeps, refund: w.deps })
    await run()
    w.clock.now += 61000
    await run()
    expect(firstArgs(w.fetchMock).has('https://many01.localnodes.xyz/localnodes/activate')).toBe(true)
    expect(firstArgs(w.fetchMock).has('https://many51.localnodes.xyz/localnodes/activate')).toBe(true)
  })

  it('KNOWN GAP, sweep:held: 51 holds that ran out while Stripe is down; the 51st is not tried within two runs', async () => {
    const w = world()
    await seedMany(w.redis, HELD_INDEX, i => ({
      status: 'held', billing: 'held', pendingSubscriptionId: `sub_m${i}`, invoiceId: `in_m${i}`, heldUntil: w.clock.now - 100000 + i, heldMailSent: true
    }), i => w.clock.now - 100000 + i)
    w.stripe.invoices.retrieve.mockRejectedValue(down())
    await sweepHeld(w.sweepDeps)
    w.clock.now += 61000
    await sweepHeld(w.sweepDeps)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m1')).toBe(true)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m50')).toBe(true)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m51')).toBe(false)
  })

  it('KNOWN GAP, sweep:teardown: 51 declined sign-ups whose void keeps failing; the 51st is not tried within two runs', async () => {
    const w = world()
    await seedMany(w.redis, TEARDOWN_INDEX, i => ({
      status: 'declined', billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: `sub_m${i}`, invoiceId: `in_m${i}`
    }), i => w.clock.now - 100000 + i)
    w.stripe.invoices.retrieve.mockRejectedValue(down())
    await sweepTeardowns(w.sweepDeps)
    w.clock.now += 61000
    await sweepTeardowns(w.sweepDeps)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m1')).toBe(true)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m50')).toBe(true)
    expect(firstArgs(w.stripe.invoices.retrieve).has('in_m51')).toBe(false)
  })
})
