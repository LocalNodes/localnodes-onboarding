// Invoice events on the Stripe webhook (Phase 23, plan 23-32; B-1 step 8 and
// the B-2 Phase 23 part). Uses the real Stripe SDK to sign and verify events
// offline; Redis is FakeRedis and the new site's /localnodes/activate is a
// mocked fetch. No network.
//
// - invoice.paid for a first invoice (billing_reason subscription_create) of
//   this app's subscription takes the paid path for a held or pending sign-up,
//   open or closed.
// - invoice.payment_failed and invoice.payment_action_required for a first
//   invoice do nothing: the pay call's own result decides.
// - Renewals (any other billing_reason) go to onRenewalProblem (Task 3 wires
//   the mail).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Stripe from 'stripe'
import { handleStripeWebhook, type WebhookDeps } from '../../server/utils/stripe-webhook'
import { HELD_INDEX, routeInvoiceEvent, type BillingDeps, type InvoiceRouteDeps } from '../../server/utils/billing'
import { FakeRedis } from './helpers/fake-redis'

const WHSEC = 'whsec_test_secret'
const stripe = new Stripe('sk_test_not_used')
const CALLBACK_SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const SID = 'cs_test_invoice'
const PID = 'InV0iCe000000000000000'
const SUB = 'sub_inv_1'
const INVOICE = 'in_inv_1'
const PROMO = 'promo_1'
const INVITE = 'inv_1'
const EMAIL = 'organizer@example.org'
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_canary_link'
/** 2026-11-08T00:00:00Z. */
const EVENT_CREATED = 1794182400

const stateKey = `provision:${SID}`

function invoicePayload(type: string, over: Record<string, unknown> = {}, opts: { legacyMetadata?: boolean, noProvision?: boolean } = {}) {
  const metadata = opts.noProvision ? {} : { provision_id: PID, subdomain: 'cascadia', invite_id: INVITE }
  const invoice: Record<string, unknown> = {
    id: INVOICE,
    object: 'invoice',
    billing_reason: 'subscription_create',
    customer: 'cus_1',
    customer_email: EMAIL,
    hosted_invoice_url: HOSTED,
    status: type === 'invoice.paid' ? 'paid' : 'open',
    parent: opts.legacyMetadata
      ? null
      : { type: 'subscription_details', quote_details: null, subscription_details: { metadata, subscription: SUB } },
    ...(opts.legacyMetadata ? { subscription_details: { metadata } } : {}),
    ...over
  }
  return JSON.stringify({ id: `evt_${type}`, object: 'event', type, created: EVENT_CREATED, data: { object: invoice } })
}

const sign = (payload: string) => stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC })

async function seed(redis: FakeRedis, extra: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
  await redis.hset(stateKey, {
    status: 'held',
    billing: 'held',
    subdomain: 'cascadia',
    provisionId: PID,
    attempt: 1,
    pendingSubscriptionId: SUB,
    invoiceId: INVOICE,
    heldUntil: 1,
    startedAt: '2026-11-08T00:00:00Z',
    ...extra
  })
  await redis.hset(`signup:${PID}`, { email: EMAIL, inviteId: INVITE, promoId: PROMO, stripeCustomerId: 'cus_1', setupIntentId: 'seti_1', priceId: 'price_1', hostedInvoiceUrl: HOSTED })
  await redis.zadd(`promo:holds:${PROMO}`, { score: 9_999_999_999, member: INVITE })
  await redis.zadd(HELD_INDEX, { score: 1, member: SID })
}

describe('stripe webhook: invoice events (23-32)', () => {
  let redis: FakeRedis
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]
  let onRenewalProblem: ReturnType<typeof vi.fn> | undefined
  let routeDeps: InvoiceRouteDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ activated: true }) })
    logs = []
    onRenewalProblem = undefined
    const billing: BillingDeps = {
      redis,
      stripe: () => { throw new Error('no Stripe call expected') },
      fetch: fetchMock,
      callbackSecret: CALLBACK_SECRET,
      sleep: async () => {},
      log: msg => logs.push(msg)
    }
    routeDeps = billing
  })

  const deps = (open: boolean, over: Partial<WebhookDeps> = {}): WebhookDeps => ({
    open,
    constructEvent: (body, sig) => stripe.webhooks.constructEvent(body, sig, WHSEC),
    onCheckoutCompleted: vi.fn(async () => {}),
    onInvoice: event => routeInvoiceEvent(event, { ...routeDeps, onRenewalProblem }).then(() => undefined),
    log: msg => logs.push(msg),
    ...over
  })
  const send = (payload: string, open = true, over: Partial<WebhookDeps> = {}) => handleStripeWebhook(payload, sign(payload), deps(open, over))
  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  it.each([true, false])('invoice.paid for a first invoice activates a held sign-up (launch open: %s)', async (open) => {
    await seed(redis)
    expect(await send(invoicePayload('invoice.paid'), open)).toEqual({ status: 200, body: { received: true } })
    expect(await state()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB })
    expect(await redis.zcard(HELD_INDEX)).toBe(0)
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('invoice.paid for a first invoice activates a pending sign-up', async () => {
    await seed(redis, { status: 'ready', billing: 'pending', billingTries: 2 })
    await send(invoicePayload('invoice.paid'))
    expect(await state()).toMatchObject({ status: 'complete', subscriptionId: SUB })
  })

  it('reads the provision id from subscription_details.metadata when parent has none', async () => {
    await seed(redis)
    await send(invoicePayload('invoice.paid', {}, { legacyMetadata: true }))
    expect((await state())?.status).toBe('complete')
  })

  it.each([
    ['a renewal', { billing_reason: 'subscription_cycle' }, {}],
    ['an invoice without provision_id', {}, { noProvision: true }]
  ] as const)('invoice.paid for %s: 200, nothing changes', async (_label, over, opts) => {
    await seed(redis)
    const before = redis.dump()
    expect(await send(invoicePayload('invoice.paid', over, opts))).toEqual({ status: 200, body: { received: true } })
    expect(redis.dump()).toBe(before)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['tearing_down', 'torn_down'])('invoice.paid for a sign-up %s (its invoice was voided): 200, a paid_after_void flag for a person, the record unchanged (23-43 Task 2)', async (status) => {
    await seed(redis, { status, billing: 'declined', teardownReason: 'held_expired', stopInvoice: true })
    const before = await state()
    expect(await send(invoicePayload('invoice.paid'))).toEqual({ status: 200, body: { received: true } })
    expect(await state()).toEqual(before)
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([`paid_after_void:${SID}`])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // 23-43 orchestrator addition (23-ORCH-INBOX.md, judgement call 3): an invoice.paid that billing
  // review (or a rejected billing) skips is never dropped without a trace. One reconcile:flags entry
  // per event names the event id, the invoice id and the amount; its score is the event's time.
  it.each([
    ['review', 'stripe_unclear'],
    ['review', 'multiple_subscriptions'],
    ['rejected', 'tries']
  ])('invoice.paid on billing %s (%s): 200, skipped, and recorded in reconcile:flags with the event id, invoice id, amount and time; a redelivery adds nothing', async (billing, billingError) => {
    await seed(redis, { status: 'ready', billing, billingError, pendingSubscriptionId: SUB })
    await redis.zadd('reconcile:flags', { score: 5, member: `${billingError === 'tries' ? 'stripe_unclear' : billingError}:${SID}` })
    const before = await state()
    const payload = invoicePayload('invoice.paid', { amount_paid: 4900, currency: 'usd' })
    expect(await send(payload)).toEqual({ status: 200, body: { received: true } })
    expect(await state()).toEqual(before)
    expect(fetchMock).not.toHaveBeenCalled()
    const member = `paid_in_review:${SID}:evt_invoice.paid:${INVOICE}:4900`
    const flags = await redis.zrange('reconcile:flags', 0, -1)
    expect(flags).toContain(member)
    expect(flags).toHaveLength(2)
    // The time: the event's own created, in ms, so a redelivery scores the same.
    expect(await redis.zrangebyscore('reconcile:flags', EVENT_CREATED * 1000, EVENT_CREATED * 1000)).toEqual([member])
    // A redelivery of the same event changes nothing at all: the same member, the same score.
    const dumped = redis.dump()
    expect(await send(payload)).toEqual({ status: 200, body: { received: true } })
    expect(redis.dump()).toBe(dumped)
    expect(await redis.zcard('reconcile:flags')).toBe(2)
    expect(logs).toContain('billing: a payment on a sign-up waiting for a person; recorded for the reconciliation')
  })

  it('invoice.paid for a sign-up already complete: 200, nothing changes', async () => {
    await seed(redis, { status: 'complete', billing: 'paid', subscriptionId: SUB, activatedAt: '2026-11-08T00:01:00Z' })
    const before = redis.dump()
    await send(invoicePayload('invoice.paid'))
    expect(redis.dump()).toBe(before)
  })

  it.each(['invoice.payment_failed', 'invoice.payment_action_required'])('%s for a first invoice: 200, nothing changes, the log names the event type only', async (type) => {
    await seed(redis, { status: 'ready', billing: 'charging' })
    onRenewalProblem = vi.fn(async () => {})
    const before = redis.dump()
    expect(await send(invoicePayload(type))).toEqual({ status: 200, body: { received: true } })
    expect(redis.dump()).toBe(before)
    expect(onRenewalProblem).not.toHaveBeenCalled()
    expect(logs).toEqual([`stripe-webhook: first invoice ${type}, the pay call decides`])
  })

  it.each([true, false])('a throw while handling an invoice event answers 503 so Stripe retries (launch open: %s)', async (open) => {
    await seed(redis)
    const r = await send(invoicePayload('invoice.paid'), open, { onInvoice: async () => { throw new Error(`redis down ${EMAIL}`) } })
    expect(r).toEqual({ status: 503, body: { error: 'Temporarily unavailable' } })
    expect(logs).toEqual(['stripe-webhook: infrastructure error handling an invoice event, Stripe will retry'])
  })

  // Review fix (2026-11-09, fresh3 23-REVIEWS.md item 2): the billing lock is
  // held by another runner (a charge in flight, or a hold being written). A 200
  // here would end Stripe's deliveries and leave a paid organizer held for up to
  // 23 hours, so the answer is 503 and nothing is written: the redelivery does
  // the work, once.
  const BILLING_LOCK = `provision:${SID}:lifecycle`
  const BUSY_LOG = 'stripe-webhook: a sign-up was busy with an invoice event, Stripe will retry'

  it.each([true, false])('invoice.paid while the billing lock is held: 503, nothing written, no activation call (launch open: %s)', async (open) => {
    await seed(redis)
    await redis.set(BILLING_LOCK, 'other-runner', { ex: 120 })
    const before = redis.dump()
    expect(await send(invoicePayload('invoice.paid'), open)).toEqual({ status: 503, body: { error: 'Temporarily unavailable' } })
    expect(redis.dump()).toBe(before)
    expect(await state()).toMatchObject({ status: 'held', billing: 'held' })
    expect((await state())?.subscriptionId).toBeUndefined()
    expect(await redis.zcard(HELD_INDEX)).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs).toEqual([BUSY_LOG])
  })

  it('after a 503 for a held lock, the redelivery once the lock is free takes the paid path exactly once', async () => {
    await seed(redis)
    await redis.set(BILLING_LOCK, 'other-runner', { ex: 120 })
    const payload = invoicePayload('invoice.paid')
    expect((await send(payload)).status).toBe(503)
    await redis.del(BILLING_LOCK)
    expect(await send(payload)).toEqual({ status: 200, body: { received: true } })
    expect(await state()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB })
    expect(await redis.zcard(HELD_INDEX)).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const after = redis.dump()
    expect(await send(payload)).toEqual({ status: 200, body: { received: true } })
    expect(redis.dump()).toBe(after)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('routeInvoiceEvent raises on a busy lock instead of returning it, so no caller can acknowledge it by mistake', async () => {
    await seed(redis)
    await redis.set(BILLING_LOCK, 'other-runner', { ex: 120 })
    const event = JSON.parse(invoicePayload('invoice.paid'))
    await expect(routeInvoiceEvent(event, routeDeps)).rejects.toMatchObject({ name: 'BillingBusyError' })
  })

  it('the busy 503 log carries no id, email or link', async () => {
    await seed(redis)
    await redis.set(BILLING_LOCK, 'other-runner', { ex: 120 })
    await send(invoicePayload('invoice.paid'))
    const text = logs.join('\n')
    expect(text).not.toBe('')
    for (const secret of [SID, PID, SUB, INVOICE, EMAIL, HOSTED, INVITE, PROMO, 'cus_1']) expect(text).not.toContain(secret)
  })

  it('a renewal payment_failed with no renewal handler wired is a no-op', async () => {
    await seed(redis, { status: 'complete', billing: 'paid', subscriptionId: SUB })
    const before = redis.dump()
    expect(await send(invoicePayload('invoice.payment_failed', { billing_reason: 'subscription_cycle' }))).toEqual({ status: 200, body: { received: true } })
    expect(redis.dump()).toBe(before)
  })

  it('other event types keep the "unhandled event type" log', async () => {
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'customer.subscription.updated', data: { object: { id: SUB, object: 'subscription' } } })
    await send(payload)
    expect(logs).toEqual(['stripe-webhook: unhandled event type customer.subscription.updated'])
  })

  it('no log line carries an id, the email or the hosted invoice URL', async () => {
    await seed(redis)
    for (const type of ['invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required']) {
      await send(invoicePayload(type, { billing_reason: type === 'invoice.paid' ? 'subscription_create' : 'subscription_create' }))
    }
    const text = logs.join('\n')
    for (const secret of [SID, PID, SUB, INVOICE, EMAIL, HOSTED, INVITE, PROMO, 'cus_1']) expect(text).not.toContain(secret)
  })
})
