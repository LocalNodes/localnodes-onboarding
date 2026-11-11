import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import Stripe from 'stripe'
import { stopProvision, STOPS_INDEX, type RetryStopDeps } from '../../server/utils/retry-stop'
import { callbackToken } from '../../server/utils/provision-handlers'
import { HELD_INDEX, TEARDOWN_INDEX, BILLING_INDEX } from '../../server/utils/billing'
import { emailKey, inviteKey } from '../../server/utils/invites'
import { INFLIGHT_KEY } from '../../server/utils/capacity'
import { provisionKeyName } from '../../server/utils/byo-key'
import { REPLY_TO, buildDeclinedMail, buildHeldMail, buildRemovedMail } from '../../server/utils/mail-copy'
import { dispatchTeardownWorkflow } from '../../server/utils/github'
import { teardownHook } from '../../server/utils/billing-wiring'
import {
  handleTeardownCheck,
  handleTeardownResult,
  reopenInvite,
  sendHeldMail,
  sweepHeld,
  sweepTeardowns
} from '../../server/utils/teardown'
import { formatHeldUntil } from '../../shared/billing-time'
import { CRON_STEPS, type SweepDeps } from '../../server/utils/cron-sweep'
import type { BillingDeps } from '../../server/utils/billing'
import { FakeRedis } from './helpers/fake-redis'

/**
 * Undo a first payment that did not happen (Phase 23, plan 23-37; Tom's billing
 * rule B-1 steps 4 and 7, his answer 2, and the D-18 note).
 *
 * Task 1 (the tracer): a declined first payment runs through stopProvision, the
 * one teardown runner: the unpaid invoice is voided and the unfinished
 * subscription cancelled first, then the code hold, the lock, the saved card,
 * the invite (reopened), one declined mail, the server room, the AI key, and
 * last a dispatch of 23-36's teardown-instance.yml. The workflow's check and
 * result routes answer it. A twice-failed build now also asks for its app to be
 * deleted.
 *
 * Fakes only: FakeRedis, a Stripe mock that throws the SDK's own error classes,
 * a mocked Resend fetch and a mocked GitHub dispatch. No network, and the
 * workflow is never dispatched for real.
 */

const CB_SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const INVITE_SECRET = 'invite-hash-secret-for-tests'
const SID = 'cs_test_teardown'
const OTHER_SID = 'cs_test_someone_else'
const PID = 'T3arD0wn00000000000000'
const PROMO = 'promo_pilot_1'
const INVITE = 'inv_0001'
const SETUP_INTENT = 'seti_1'
const PM = 'pm_1'
const SUB = 'sub_1'
const INVOICE = 'in_1'
const EMAIL = 'organizer@example.org'
const APP_UUID = 'app-uuid-half-made'

const stateKey = `provision:${SID}`
const signupKey = `signup:${PID}`
const claimKey = `invite:u:${INVITE}`
const inviteHash = inviteKey(emailKey(INVITE_SECRET, EMAIL))
const bearer = `Bearer ${callbackToken(CB_SECRET, PID)}`

type Calls = string[]

function makeStripe(calls: Calls, invoiceStatus = 'open') {
  const stripe = {
    setupIntents: { retrieve: vi.fn(async () => { calls.push('setupIntents.retrieve'); return { payment_method: PM } }) },
    paymentMethods: { detach: vi.fn(async () => { calls.push('paymentMethods.detach'); return {} }) },
    invoices: {
      retrieve: vi.fn(async () => { calls.push('invoices.retrieve'); return { id: INVOICE, status: invoiceStatus } }),
      voidInvoice: vi.fn(async () => { calls.push('invoices.voidInvoice'); return { id: INVOICE, status: 'void' } }),
      // Never: nothing here takes money.
      pay: vi.fn()
    },
    subscriptions: {
      cancel: vi.fn(async () => { calls.push('subscriptions.cancel'); return { id: SUB, status: 'canceled' } }),
      retrieve: vi.fn(async () => { calls.push('subscriptions.retrieve'); return { id: SUB, status: 'canceled' } }),
      create: vi.fn()
    },
    refunds: { create: vi.fn() }
  }
  return stripe
}

type StripeMock = ReturnType<typeof makeStripe>

async function seedDeclined(redis: FakeRedis, extra: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
  await redis.hset(stateKey, {
    status: 'declined',
    billing: 'declined',
    teardownReason: 'declined',
    subdomain: 'cascadia',
    provisionId: PID,
    attempt: 1,
    failedAttempts: 0,
    pendingSubscriptionId: SUB,
    invoiceId: INVOICE,
    appUuid: APP_UUID,
    declinedAt: '2026-11-08T12:00:00.000Z',
    ...extra
  })
  await redis.hset(signupKey, {
    subdomain: 'cascadia',
    communityName: 'Cascadia Reading Group',
    email: EMAIL,
    inviteId: INVITE,
    promoId: PROMO,
    stripeCustomerId: 'cus_1',
    setupIntentId: SETUP_INTENT,
    // 23-43 Task 3: the price frozen at checkout.
    priceId: 'price_1'
  })
  await redis.hset(inviteHash, { inviteId: INVITE, kind: 'pilot', status: 'used', usedAt: '2026-11-08T11:00:00.000Z' })
  await redis.set(claimKey, SID, { nx: true })
  await redis.zadd(`promo:holds:${PROMO}`, { score: 9_999_999_999, member: INVITE })
  await redis.set(`provision:${SID}:lock`, 'locked', { nx: true, ex: 3600 })
  await redis.zadd(INFLIGHT_KEY, { score: 9_999_999_999_999, member: PID })
  await redis.set(provisionKeyName(PID), 'sealed-key', { ex: 86400 })
  await redis.zadd(TEARDOWN_INDEX, { score: 1, member: SID })
}

describe('teardown (tracer): a declined first payment is undone once, the invoice voided first and the app delete asked for last', () => {
  let redis: FakeRedis
  let calls: Calls
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let teardown: ReturnType<typeof vi.fn>
  let onPaid: ReturnType<typeof vi.fn>
  let logs: string[]
  let deps: RetryStopDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    calls = []
    stripe = makeStripe(calls)
    fetchMock = vi.fn(async () => { calls.push('resend'); return { id: 'email_1' } })
    teardown = vi.fn(async () => { calls.push('teardown') })
    onPaid = vi.fn(async () => {})
    logs = []
    deps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      inviteHashSecret: INVITE_SECRET,
      teardown,
      onPaid,
      now: () => Date.parse('2026-11-08T12:05:00Z'),
      log: msg => logs.push(msg)
    }
    await seedDeclined(redis)
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  it('runs every step: void, cancel, hold, lock, card, invite, one declined mail, room, AI key, then one teardown-instance.yml dispatch; tornDown, not stopped', async () => {
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })

    expect(stripe.invoices.retrieve).toHaveBeenCalledWith(INVOICE, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1)
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledWith(INVOICE, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith(SUB, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.invoices.pay).not.toHaveBeenCalled()
    expect(stripe.refunds.create).not.toHaveBeenCalled()
    // The code hold, the lock and the card.
    expect(await redis.zrange(`promo:holds:${PROMO}`, '-inf', '+inf', { byScore: true })).toEqual([])
    expect(await redis.exists(`provision:${SID}:lock`)).toBe(0)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith(PM, {}, { timeout: 15000, maxNetworkRetries: 0 })
    // The invite is open again and its claim gone.
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'open', usedAt: '' })
    expect(await redis.exists(claimKey)).toBe(0)
    // One mail.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The room and the AI key.
    expect(await redis.zrange(INFLIGHT_KEY, '-inf', '+inf', { byScore: true })).toEqual([])
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
    // The delete, asked for once with exactly the two values.
    expect(teardown).toHaveBeenCalledTimes(1)
    // The two values, and the lease's abort signal (23-43 Task 2: a real abort under DISPATCH_TIMEOUT_MS).
    expect(teardown).toHaveBeenCalledWith({ subdomain: 'cascadia', provisionId: PID }, expect.any(AbortSignal))

    const s = await state()
    // 23-43 Task 2: tearing_down from right after the void; torn_down only when the workflow confirms.
    expect(s).toMatchObject({
      stopInvoice: true, stopHold: true, stopLock: true, stopCard: true, stopInvite: true,
      stopMail: true, stopCapacity: true, stopAiKey: true, stopApp: true, tornDown: true,
      status: 'tearing_down', teardownReason: 'declined'
    })
    expect(s?.stopped).not.toBe(true)
    expect(String(s?.teardownDispatchedAt)).toMatch(/^2026-11-08T12:05:00/)
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
    expect(await redis.zrange(STOPS_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('the declined mail: subject, approved body, "Try again" to /invite, reply-to, html, Idempotency-Key declined-mail-{provisionId}, no unsubscribe link', async () => {
    await stopProvision(SID, deps)
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string, headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Idempotency-Key']).toBe(`declined-mail-${PID}`)
    expect(opts.body).toMatchObject({ to: [EMAIL], reply_to: REPLY_TO, subject: 'Your card was declined' })
    expect(String(opts.body.text)).toContain('Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.')
    expect(String(opts.body.text)).toContain('Try again: https://localnodes.xyz/invite')
    expect(String(opts.body.html)).toContain('href="https://localnodes.xyz/invite"')
    expect(String(opts.body.html)).not.toMatch(/unsubscribe/i)
    expect(opts.body.html).toBe(buildDeclinedMail().html)
  })

  it('order: the void first, the cancel next, the invite before the mail, and the dispatch after the mail, last', async () => {
    await stopProvision(SID, deps)
    const order = calls.filter(c => c !== 'setupIntents.retrieve')
    expect(order[0]).toBe('invoices.retrieve')
    expect(order[1]).toBe('invoices.voidInvoice')
    expect(order[2]).toBe('subscriptions.cancel')
    expect(order.indexOf('resend')).toBeGreaterThan(order.indexOf('paymentMethods.detach'))
    expect(order.at(-1)).toBe('teardown')
    expect(order.indexOf('teardown')).toBeGreaterThan(order.indexOf('resend'))
  })

  it('the invite is reopened before the mail is sent, so "Try again" already works', async () => {
    let openAtMail: unknown = null
    fetchMock.mockImplementation(async () => {
      openAtMail = (await redis.hgetall<Record<string, unknown>>(inviteHash))?.status
      return { id: 'e' }
    })
    await stopProvision(SID, deps)
    expect(openAtMail).toBe('open')
  })

  it('an invoice already void (Stripe expired it): no void call, the step completes, the cancel still runs', async () => {
    stripe = makeStripe(calls, 'void')
    await stopProvision(SID, deps)
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ stopInvoice: true, tornDown: true })
  })

  it('voidInvoice says the invoice is already void: a fresh read shows void, so the step completes', async () => {
    stripe.invoices.voidInvoice.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'This invoice is already void.', type: 'invalid_request_error' } as never))
    stripe.invoices.retrieve
      .mockResolvedValueOnce({ id: INVOICE, status: 'open' })
      .mockResolvedValueOnce({ id: INVOICE, status: 'void' })
    await stopProvision(SID, deps)
    expect(await state()).toMatchObject({ stopInvoice: true, tornDown: true })
  })

  it.each(['canceled', 'incomplete_expired'])('subscriptions.cancel fails but the subscription is already %s: the step completes', async (status) => {
    stripe.subscriptions.cancel.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'No such subscription', type: 'invalid_request_error' } as never))
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: SUB, status })
    await stopProvision(SID, deps)
    expect(await state()).toMatchObject({ stopInvoice: true, tornDown: true })
  })

  it('subscriptions.cancel fails and the subscription is still incomplete: the step throws, nothing after it runs', async () => {
    stripe.subscriptions.cancel.mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: 'boom' } as never))
    stripe.subscriptions.retrieve.mockResolvedValueOnce({ id: SUB, status: 'incomplete' })
    await expect(stopProvision(SID, deps)).rejects.toThrow()
    const s = await state()
    expect(s?.stopInvoice).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
  })

  it('the invoice is paid when the void step reads it: nothing else runs, the sign-up goes back to ready and is handed to the paid path once', async () => {
    stripe = makeStripe(calls, 'paid')
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
    expect(onPaid).toHaveBeenCalledTimes(1)
    expect(onPaid).toHaveBeenCalledWith(PID)
    const s = await state()
    // 23-43 Task 2 (HIGH 8): one handBack step, billing paid with the subscription and the invoice.
    expect(s).toMatchObject({ status: 'ready', billing: 'paid', subscriptionId: SUB, invoiceId: INVOICE, teardownReason: '' })
    expect(s?.stopInvoice).toBeUndefined()
    expect(s?.tornDown).toBeUndefined()
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([])
    // Still owed to billing, so the sweep finishes the hand-over if onPaid was busy.
    expect(await redis.zrange(BILLING_INDEX, '-inf', '+inf', { byScore: true })).toEqual([SID])
    // The invite is untouched; the code hold is released, as markPaid does.
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'used' })
    expect(await redis.zrange(`promo:holds:${PROMO}`, '-inf', '+inf', { byScore: true })).toEqual([])
  })

  it('the hand-back stores the paid invoice\'s amount and currency, and a failed code hold release is logged (the hold runs out on its own)', async () => {
    stripe = makeStripe(calls, 'paid')
    stripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid', amount_paid: 4900, currency: 'usd' } as never)
    const zrem = redis.zrem.bind(redis)
    redis.zrem = (async (key: string, ...m: string[]) => {
      if (key.startsWith('promo:holds:')) throw new Error('redis down')
      return zrem(key, ...m)
    }) as typeof redis.zrem
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(await state()).toMatchObject({ status: 'ready', billing: 'paid', amountPaid: 4900, currency: 'usd' })
    expect(logs).toContain('retry-stop: code hold not released, it runs out on its own')
    expect(onPaid).toHaveBeenCalledWith(PID)
  })

  it('a completed webhook payment is never overwritten', async () => {
    // The lease runs out while the void step reads the invoice; invoice.paid takes the lock and completes the sign-up.
    stripe.invoices.retrieve.mockImplementationOnce(async () => {
      await redis.set(`provision:${SID}:lifecycle`, 'the-webhook', { px: 60000 })
      await redis.hset(stateKey, { status: 'complete', billing: 'paid', subscriptionId: SUB, activatedAt: '2026-11-08T12:04:00.000Z', teardownReason: '' })
      return { id: INVOICE, status: 'paid' }
    })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(await state()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB, activatedAt: '2026-11-08T12:04:00.000Z' })
    expect(onPaid).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
  })

  it('every Stripe mutation, the mail and the dispatch are written as an intent first, and each result clears it', async () => {
    const seen: Record<string, unknown> = {}
    const at = (label: string) => async () => { seen[label] = (await state())?.intentOp }
    stripe.invoices.voidInvoice.mockImplementationOnce(async () => { await at('void')(); return { id: INVOICE, status: 'void' } })
    stripe.subscriptions.cancel.mockImplementationOnce(async () => { await at('cancel')(); return { id: SUB, status: 'canceled' } })
    stripe.paymentMethods.detach.mockImplementationOnce(async () => { await at('detach')(); return {} })
    fetchMock.mockImplementationOnce(async () => { await at('mail')(); return { id: 'e' } })
    teardown.mockImplementationOnce(async () => { await at('dispatch')() })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(seen).toEqual({ void: 'void', cancel: 'cancel', detach: 'detach', mail: 'mail', dispatch: 'dispatch' })
    const s = await state()
    expect(s?.intentOp).toBe('')
    expect(s?.intentToken).toBe('')
  })

  it('the record is tearing_down before the card, the mail and the dispatch, and still declined while the void runs', async () => {
    const seen: Record<string, unknown> = {}
    stripe.invoices.voidInvoice.mockImplementationOnce(async () => { seen.void = (await state())?.status; return { id: INVOICE, status: 'void' } })
    teardown.mockImplementationOnce(async () => { seen.dispatch = (await state())?.status })
    await stopProvision(SID, deps)
    expect(seen).toEqual({ void: 'declined', dispatch: 'tearing_down' })
  })

  it('a failed mail still dispatches the delete', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Resend 500'))
    await expect(stopProvision(SID, deps)).rejects.toThrow('retry-stop: mail not sent')
    expect(teardown).toHaveBeenCalledTimes(1)
    const cut = await state()
    expect(cut).toMatchObject({ status: 'tearing_down', stopCapacity: true, stopAiKey: true, stopApp: true })
    expect(cut?.stopMail).toBeUndefined()
    expect(cut?.tornDown).toBeUndefined()
    expect(logs).toContain('retry-stop: mail not sent, the teardowns step retries it')
    // Still owed: the teardowns step finds it and sends the mail once more, with the same key.
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([SID])
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }])[1].headers['Idempotency-Key']).toBe(`declined-mail-${PID}`)
    expect(await state()).toMatchObject({ stopMail: true, tornDown: true })
  })

  it('the next holder reconciles a foreign dispatch intent: clears it and dispatches again (the workflow is idempotent per provision)', async () => {
    await redis.hset(stateKey, {
      status: 'tearing_down', stopInvoice: true, stopHold: true, stopLock: true, stopCard: true, stopInvite: true, stopMail: true, stopCapacity: true, stopAiKey: true,
      intentOp: 'dispatch', intentKey: `teardown:${PID}`, intentToken: 'an-old-lease', intentAt: '2026-11-08T12:00:00.000Z'
    })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['teardown'])
    expect(logs).toContain('retry-stop: reconciling an unfinished dispatch')
    expect((await state())?.intentToken).toBe('')
  })

  it('the next holder reconciles a foreign cancel intent: the subscription is read first, and a canceled one is not cancelled again', async () => {
    stripe = makeStripe(calls, 'void')
    await redis.hset(stateKey, { intentOp: 'cancel', intentKey: `cancel:${SUB}`, intentToken: 'an-old-lease', intentAt: '2026-11-08T12:00:00.000Z' })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(calls.indexOf('subscriptions.retrieve')).toBeLessThan(calls.indexOf('setupIntents.retrieve'))
    expect(await state()).toMatchObject({ stopInvoice: true, tornDown: true })
  })

  it('the next holder reconciles a foreign mail intent: the mail goes again with the same Idempotency-Key', async () => {
    await redis.hset(stateKey, {
      status: 'tearing_down', stopInvoice: true, stopHold: true, stopLock: true, stopCard: true, stopInvite: true,
      intentOp: 'mail', intentKey: `declined-mail-${PID}`, intentToken: 'an-old-lease', intentAt: '2026-11-08T12:00:00.000Z'
    })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers['Idempotency-Key']).toBe(`declined-mail-${PID}`)
    expect(logs).toContain('retry-stop: reconciling an unfinished mail')
  })

  it('the app delete gets the lease\'s abort signal, aborted at DISPATCH_TIMEOUT_MS (15 s)', async () => {
    vi.useFakeTimers()
    try {
      const seen: { signal?: AbortSignal } = {}
      teardown.mockImplementationOnce((_p: unknown, signal?: AbortSignal) => {
        seen.signal = signal
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
      })
      const run = stopProvision(SID, deps).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(seen.signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(seen.signal?.aborted).toBe(true)
      expect(await run).toBeInstanceOf(Error)
      expect((await state())?.stopApp).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the void fails because the invoice was paid at that moment: a fresh read shows paid, so the teardown stops and hands over', async () => {
    stripe.invoices.voidInvoice.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'You can only void open invoices.', type: 'invalid_request_error' } as never))
    stripe.invoices.retrieve
      .mockResolvedValueOnce({ id: INVOICE, status: 'open' })
      .mockResolvedValueOnce({ id: INVOICE, status: 'paid' })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(onPaid).toHaveBeenCalledWith(PID)
    expect(teardown).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ status: 'ready', billing: 'paid', subscriptionId: SUB, teardownReason: '' })
  })

  it('a run cut short after the mail (the dispatch throws) leaves tornDown unset; the next run dispatches once and sends no second mail', async () => {
    teardown.mockRejectedValueOnce(new Error('GitHub dispatch failed (502)'))
    await expect(stopProvision(SID, deps)).rejects.toThrow()
    const cut = await state()
    expect(cut).toMatchObject({ stopMail: true })
    expect(cut?.tornDown).toBeUndefined()
    expect(cut?.stopApp).toBeUndefined()
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(2)
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ tornDown: true, stopApp: true })
  })

  it('a torn-down sign-up run again calls nothing', async () => {
    await stopProvision(SID, deps)
    calls.length = 0
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(calls).toEqual([])
  })

  it('two runs at once give one void, one mail and one dispatch (the 23-38 stop lock)', async () => {
    const [a, b] = await Promise.all([stopProvision(SID, deps), stopProvision(SID, deps)])
    expect([a.stopped, b.stopped].sort()).toEqual([false, true])
    expect(stripe.invoices.voidInvoice).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(teardown).toHaveBeenCalledTimes(1)
  })

  it('the stop dispatch is not wired: the run throws at the last step and is not torn down', async () => {
    await expect(stopProvision(SID, { ...deps, teardown: undefined })).rejects.toThrow('retry-stop: teardown not wired')
    const s = await state()
    expect(s).toMatchObject({ stopAiKey: true })
    expect(s?.tornDown).toBeUndefined()
  })

  it('the invite secret is not wired: the invite step throws before the mail', async () => {
    await expect(stopProvision(SID, { ...deps, inviteHashSecret: undefined })).rejects.toThrow('retry-stop: invite secret not wired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a sign-up with status complete is never torn down: no Stripe, Resend or GitHub call', async () => {
    await redis.hset(stateKey, { status: 'complete' })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(calls).toEqual([])
  })

  it('a sign-up with a subscriptionId is never torn down: no Stripe, Resend or GitHub call', async () => {
    await redis.hset(stateKey, { subscriptionId: SUB })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    expect(calls).toEqual([])
  })

  it('the log lines carry fixed words; the one line with an id names the Coolify app only', async () => {
    await stopProvision(SID, deps)
    const all = logs.join('\n')
    for (const canary of [SID, PID, EMAIL, SUB, INVOICE, INVITE, PM]) expect(all).not.toContain(canary)
    expect(logs.filter(l => l.includes(APP_UUID))).toEqual([`retry-stop: torn down (declined); teardown requested for Coolify app ${APP_UUID}`])
  })
})

describe('reopenInvite: the invite goes back to open only for this sign-up', () => {
  let redis: FakeRedis
  let logs: string[]
  const log = (m: string) => logs.push(m)
  const signup = { email: EMAIL, inviteId: INVITE }

  beforeEach(async () => {
    redis = new FakeRedis()
    logs = []
    await redis.hset(inviteHash, { inviteId: INVITE, kind: 'pilot', status: 'used', usedAt: '2026-11-08T11:00:00.000Z' })
  })

  it('this sign-up\'s claim: deleted, and the invite is open with usedAt cleared', async () => {
    await redis.set(claimKey, SID, { nx: true })
    await reopenInvite(redis, INVITE_SECRET, signup, SID, log)
    expect(await redis.exists(claimKey)).toBe(0)
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'open', usedAt: '' })
  })

  it('a claim held by another checkout session is left alone, and the invite stays used', async () => {
    await redis.set(claimKey, OTHER_SID, { nx: true })
    await reopenInvite(redis, INVITE_SECRET, signup, SID, log)
    expect(await redis.get(claimKey)).toBe(OTHER_SID)
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'used' })
    expect(logs).toEqual(['teardown: invite claimed by another sign-up, left alone'])
  })

  it('an invite hash that now carries another invite id is left alone', async () => {
    await redis.hset(inviteHash, { inviteId: 'inv_other' })
    await redis.set(claimKey, SID, { nx: true })
    await reopenInvite(redis, INVITE_SECRET, signup, SID, log)
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'used', inviteId: 'inv_other' })
    expect(await redis.get(claimKey)).toBe(SID)
  })

  it('a missing invite hash: nothing to reopen, a fixed log line, no throw', async () => {
    await redis.del(inviteHash)
    await reopenInvite(redis, INVITE_SECRET, signup, SID, log)
    expect(logs).toEqual(['teardown: invite not found, nothing reopened'])
    expect(logs.join('\n')).not.toContain(EMAIL)
  })

  it('a missing invite hash in a declined teardown still sets the stopInvite flag', async () => {
    const redis2 = new FakeRedis()
    await seedDeclined(redis2)
    await redis2.del(inviteHash)
    const lines: string[] = []
    const out = await stopProvision(SID, {
      redis: redis2,
      stripe: () => makeStripe([]),
      mail: { apiKey: 'k', from: 'f', fetch: vi.fn(async () => ({})) },
      inviteHashSecret: INVITE_SECRET,
      teardown: vi.fn(async () => {}),
      log: m => lines.push(m)
    })
    expect(out).toEqual({ stopped: true })
    expect(await redis2.hgetall(stateKey)).toMatchObject({ stopInvite: true })
    expect(lines).toContain('teardown: invite not found, nothing reopened')
  })
})

describe('a build that failed twice now also asks for its app to be deleted (Tom\'s answer 2)', () => {
  let redis: FakeRedis
  let calls: Calls
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let teardown: ReturnType<typeof vi.fn>
  let logs: string[]
  let deps: RetryStopDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    calls = []
    stripe = makeStripe(calls)
    fetchMock = vi.fn(async () => { calls.push('resend'); return { id: 'e' } })
    teardown = vi.fn(async () => { calls.push('teardown') })
    logs = []
    deps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      inviteHashSecret: INVITE_SECRET,
      teardown,
      log: m => logs.push(m)
    }
    await seedDeclined(redis)
    // A build failure: no payment was ever started.
    await redis.hset(stateKey, { status: 'failed', billing: '', teardownReason: '', pendingSubscriptionId: '', invoiceId: '', failedAttempts: 2, canRetry: false })
  })

  it('the six steps run as before, then the dispatch; no invoice, cancel or invite step; the stopped mail; stopped true', async () => {
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(stripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled()
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'used' })
    expect(await redis.get(claimKey)).toBe(SID)
    const [, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
    expect(opts.headers['Idempotency-Key']).toBe(`stop-mail-${PID}`)
    expect(opts.body.subject).toBe('We couldn\'t set up your site')
    expect(teardown).toHaveBeenCalledWith({ subdomain: 'cascadia', provisionId: PID }, expect.any(AbortSignal))
    expect(calls.at(-1)).toBe('teardown')
    const s = await redis.hgetall<Record<string, unknown>>(stateKey)
    // 23-43 Task 2: tearing_down from the start of the stop; tornDown means every step ran, stopped that it was a build failure.
    expect(s).toMatchObject({ status: 'tearing_down', stopped: true, tornDown: true, stopApp: true, teardownReason: 'build_failed' })
    expect(s?.stopInvite).toBeUndefined()
    expect(s?.stopInvoice).toBeUndefined()
  })

  it('the stop moves the record to tearing_down before its first Stripe call, and a ready sign-up with two failures is refused with nothing written (HIGH 3)', async () => {
    const seen: string[] = []
    stripe.setupIntents.retrieve.mockImplementationOnce(async () => { seen.push(String((await redis.hgetall<Record<string, unknown>>(stateKey))?.status)); return { payment_method: PM } })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(seen).toEqual(['tearing_down'])

    const other = new FakeRedis()
    await seedDeclined(other)
    await other.hset(stateKey, { status: 'ready', billing: 'charging', teardownReason: '', pendingSubscriptionId: '', invoiceId: '', failedAttempts: 2 })
    const before = other.dump()
    calls.length = 0
    expect(await stopProvision(SID, { ...deps, redis: other })).toEqual({ stopped: false })
    expect(other.dump()).toBe(before)
    expect(calls).toEqual([])
  })

  it('a build-failure stop never lowers a lifetime: a 5-day record keeps 5 days (the old expire(24 h) is gone)', async () => {
    await redis.expire(stateKey, 5 * 86400)
    await stopProvision(SID, deps)
    expect(await redis.pttl(stateKey)).toBe(5 * 86400 * 1000)
  })

  it('the D-18 line reads "retry-stop: stopped (build_failed); teardown requested for Coolify app <uuid>" and is the only line with an id', async () => {
    await stopProvision(SID, deps)
    expect(logs.filter(l => l.includes(APP_UUID))).toEqual([`retry-stop: stopped (build_failed); teardown requested for Coolify app ${APP_UUID}`])
    for (const canary of [SID, PID, EMAIL]) expect(logs.join('\n')).not.toContain(canary)
  })

  it('with no app uuid the line says none', async () => {
    await redis.hset(stateKey, { appUuid: '' })
    await stopProvision(SID, deps)
    expect(logs).toContain('retry-stop: stopped (build_failed); teardown requested for Coolify app none')
  })

  it('the source no longer leaves the app for Tom to review', () => {
    const src = readFileSync(new URL('../../server/utils/retry-stop.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('Coolify app to review')
  })
})

describe('dispatchTeardownWorkflow: teardown-instance.yml with the three inputs (23-36 contract)', () => {
  const config = { githubRepo: 'LocalNodes/os-knowledge-garden', githubToken: 'ghp_test_token' }

  it('hands the abort signal to fetch (23-43 Task 2: a real abort under the dispatch deadline)', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    const controller = new AbortController()
    await dispatchTeardownWorkflow({ subdomain: 'cascadia', provisionId: PID }, { config: { githubRepo: 'LocalNodes/os-knowledge-garden', githubToken: 'ghp_x' }, fetch: fetchSpy as unknown as typeof fetch }, controller.signal)
    expect((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal)
  })

  it('posts ref main, return_run_details and exactly subdomain, provision_id and callback_url', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workflow_run_id: 7, html_url: 'https://github.com/x/actions/runs/7' }), { status: 200 }))
    await dispatchTeardownWorkflow({ subdomain: 'cascadia', provisionId: PID }, { config, fetch: fetchMock as unknown as typeof fetch })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.github.com/repos/LocalNodes/os-knowledge-garden/actions/workflows/teardown-instance.yml/dispatches')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test_token')
    expect(JSON.parse(String(init.body))).toEqual({
      ref: 'main',
      return_run_details: true,
      inputs: { subdomain: 'cascadia', provision_id: PID, callback_url: 'https://localnodes.xyz' }
    })
  })

  it('a refusal throws with the status only, never GitHub\'s text', async () => {
    const fetchMock = vi.fn(async () => new Response(`inputs echoed: cascadia ${PID}`, { status: 422 }))
    const err = await dispatchTeardownWorkflow({ subdomain: 'cascadia', provisionId: PID }, { config, fetch: fetchMock as unknown as typeof fetch }).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('GitHub teardown dispatch failed (422)')
  })
})

describe('onDeclined runs the teardown through keepAlive (billing-wiring teardownHook)', () => {
  it('once per call, through keepAlive', async () => {
    const run = vi.fn(async () => ({ stopped: true }))
    const kept: Promise<void>[] = []
    const hook = teardownHook(run, w => { kept.push(w) }, () => {})
    await hook(SID)
    expect(kept).toHaveLength(1)
    await Promise.all(kept)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(SID)
  })

  it('a throw is logged as a fixed line, never raised', async () => {
    const lines: string[] = []
    const hook = teardownHook(async () => { throw new Error(`stripe down for ${EMAIL}`) }, undefined, m => lines.push(m))
    await expect(hook(SID)).resolves.toBeUndefined()
    expect(lines).toEqual(['teardown: not finished, the sweep resumes it'])
  })

  it('makeBillingDeps wires onDeclined with the stop runner, and the stop deps carry the teardown dispatch and the paid path', () => {
    const src = readFileSync(new URL('../../server/utils/billing-wiring.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/onDeclined: teardownHook\(/)
    expect(src).toMatch(/teardown: dispatchTeardown/)
    expect(src).toMatch(/onPaid: .*onFirstInvoicePaid\(/)
    expect(src).toMatch(/export function makeStopDeps\(/)
  })

  it.each([
    'server/api/provision-status.get.ts',
    'server/api/provision-callback.post.ts',
    'server/api/retry-provisioning.post.ts',
    'server/api/cron/sweep.post.ts'
  ])('%s builds its stop deps with makeStopDeps, so a build-failure stop from any trigger asks for the delete', (file) => {
    const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(src).toMatch(/makeStopDeps\(config/)
  })
})

describe('GET /api/teardown-check: the workflow\'s only go-ahead (23-36 contract, D-18 note)', () => {
  let redis: FakeRedis
  let reads: number
  const check = (auth: string | undefined, pid = PID) => handleTeardownCheck(auth, pid, { redis, secret: CB_SECRET })

  beforeEach(async () => {
    redis = new FakeRedis()
    await seedDeclined(redis)
    reads = 0
    const hgetall = redis.hgetall.bind(redis)
    const get = redis.get.bind(redis)
    redis.hgetall = (async (k: string) => { reads++; return hgetall(k) }) as typeof redis.hgetall
    redis.get = (async (k: string) => { reads++; return get(k) }) as typeof redis.get
  })

  it.each([
    ['no bearer', undefined],
    ['a wrong bearer', `Bearer ${callbackToken(CB_SECRET, 'Zz0000000000000000000z')}`],
    ['a bearer under another secret', `Bearer ${callbackToken('other', PID)}`]
  ])('%s: 401 before any Redis read', async (_l, auth) => {
    expect(await check(auth)).toEqual({ status: 401, body: { message: 'Unauthorized' } })
    expect(reads).toBe(0)
  })

  it('an empty configured secret: 401, nothing passes', async () => {
    expect(await handleTeardownCheck(bearer, PID, { redis, secret: '' })).toMatchObject({ status: 401 })
  })

  it('an unknown provision: 404', async () => {
    const other = 'Un0000000000000000000k'
    expect(await check(`Bearer ${callbackToken(CB_SECRET, other)}`, other)).toEqual({ status: 404, body: { teardown: false } })
  })

  it('declined, before the void step is done: 409 {teardown: false}', async () => {
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it.each(['declined', 'held_expired'])('%s with stopInvoice done, tearing_down: 200 {teardown: true}', async (reason) => {
    await redis.hset(stateKey, { status: 'tearing_down', teardownReason: reason, stopInvoice: true })
    expect(await check(bearer)).toEqual({ status: 200, body: { teardown: true } })
  })

  it('declined with stopInvoice done but not yet tearing_down: 409 (the yes is for tearing_down only)', async () => {
    await redis.hset(stateKey, { stopInvoice: true })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('a build that failed twice, tearing_down, no money moved: 200 {teardown: true}; asked again, 200 again', async () => {
    await redis.hset(stateKey, { status: 'tearing_down', billing: '', teardownReason: 'build_failed', failedAttempts: 2, invoiceId: '', pendingSubscriptionId: '' })
    expect(await check(bearer)).toEqual({ status: 200, body: { teardown: true } })
    expect(await check(bearer)).toEqual({ status: 200, body: { teardown: true } })
  })

  it('a twice-failed build still in failed (the stop has not moved it yet): 409', async () => {
    await redis.hset(stateKey, { status: 'failed', billing: '', teardownReason: '', failedAttempts: 2, invoiceId: '', pendingSubscriptionId: '' })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it.each([
    ['an invoice', { invoiceId: INVOICE, pendingSubscriptionId: '' }],
    ['a pending subscription', { invoiceId: '', pendingSubscriptionId: SUB }],
    ['one failure', { invoiceId: '', pendingSubscriptionId: '', failedAttempts: 1 }]
  ])('build_failed in tearing_down with %s: 409', async (_l, extra) => {
    await redis.hset(stateKey, { status: 'tearing_down', billing: '', teardownReason: 'build_failed', failedAttempts: 2, ...extra })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('Argon\'s fallthrough: declined, stopInvoice unset, two failures: 409', async () => {
    await redis.hset(stateKey, { status: 'declined', teardownReason: 'declined', failedAttempts: 2 })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
    await redis.hset(stateKey, { status: 'tearing_down' })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it.each([
    ['refundSucceededAt set', { refundSucceededAt: '2026-11-09T10:00:00.000Z' }, 200],
    ['refundZero true', { refundZero: true }, 200],
    ['no refund recorded', {}, 409],
    ['a refund recorded but activatedAt set', { refundSucceededAt: '2026-11-09T10:00:00.000Z', activatedAt: '2026-11-09T09:00:00.000Z' }, 409],
    // 23-43 Task 6, D2: a refund problem waits for a person, whatever else the record says.
    ['a refund recorded and a refund problem', { refundSucceededAt: '2026-11-09T10:00:00.000Z', refundProblem: 'partial' }, 409],
    ['only a refundId (pending)', { refundId: 're_1' }, 409]
  ])('activation_failed in tearing_down with %s: %s', async (_l, extra, code) => {
    await redis.hset(stateKey, { status: 'tearing_down', teardownReason: 'activation_failed', subscriptionId: SUB, billing: 'paid', ...extra })
    expect((await check(bearer)).status).toBe(code)
  })

  it('torn_down: 409 (the app is already gone)', async () => {
    await redis.hset(stateKey, { status: 'torn_down', teardownReason: 'declined', stopInvoice: true })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('every status but tearing_down answers 409, even with every other condition of every reason met', async () => {
    const { LIFECYCLE_STATES } = await import('../../server/utils/lifecycle')
    for (const status of LIFECYCLE_STATES.filter(x => x !== 'tearing_down')) {
      for (const reason of ['build_failed', 'declined', 'held_expired', 'activation_failed']) {
        await redis.hset(stateKey, { status, teardownReason: reason, stopInvoice: true, failedAttempts: 2, invoiceId: '', pendingSubscriptionId: '', billing: '', refundZero: true })
        expect((await check(bearer)).status, `${status} ${reason}`).toBe(409)
      }
    }
  })

  it('a plain failed sign-up with one failure: 409', async () => {
    await redis.hset(stateKey, { status: 'failed', teardownReason: '', failedAttempts: 1 })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('status complete, even with stopInvoice set: 409', async () => {
    await redis.hset(stateKey, { status: 'complete', stopInvoice: true })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('a subscriptionId, even declined with stopInvoice set and tearing_down: 409', async () => {
    await redis.hset(stateKey, { status: 'tearing_down', subscriptionId: SUB, stopInvoice: true })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('a subscriptionId on a twice-failed build, tearing_down: 409', async () => {
    await redis.hset(stateKey, { status: 'tearing_down', teardownReason: 'build_failed', failedAttempts: 2, invoiceId: '', pendingSubscriptionId: '', billing: '', subscriptionId: SUB })
    expect(await check(bearer)).toEqual({ status: 409, body: { teardown: false } })
  })

  it('the route is thin: the bearer header, the query id, the callback secret and no-store', () => {
    const src = readFileSync(new URL('../../server/api/teardown-check.get.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/handleTeardownCheck\(/)
    expect(src).toMatch(/getHeader\(event, 'authorization'\)/)
    expect(src).toMatch(/provisionCallbackSecret/)
    expect(src).toMatch(/'Cache-Control', 'no-store'/)
  })
})

describe('POST /api/teardown-result: the workflow reports deleted, gone, refused or failed', () => {
  let redis: FakeRedis
  let logs: string[]
  const post = (auth: string | undefined, body: unknown) => handleTeardownResult(auth, body, { redis, secret: CB_SECRET, now: () => Date.parse('2026-11-08T12:10:00Z'), log: m => logs.push(m) })

  beforeEach(async () => {
    redis = new FakeRedis()
    logs = []
    await seedDeclined(redis, { stopInvoice: true, tornDown: true })
  })

  it('no bearer or a wrong one: 401, nothing stored', async () => {
    expect(await post(undefined, { provision_id: PID, result: 'deleted' })).toEqual({ status: 401, body: { message: 'Unauthorized' } })
    expect(await post(`Bearer ${callbackToken(CB_SECRET, 'Zz0000000000000000000z')}`, { provision_id: PID, result: 'deleted' })).toMatchObject({ status: 401 })
    expect((await redis.hgetall<Record<string, unknown>>(stateKey))?.teardownApp).toBeUndefined()
  })

  it.each(['', 'DELETED', 'removed', 'deleted; rm -rf', null, 3])('a result outside the four words (%s): 400', async (result) => {
    expect(await post(bearer, { provision_id: PID, result })).toMatchObject({ status: 400 })
  })

  it.each(['deleted', 'gone', 'refused', 'failed'])('%s is stored with its time and answers 200 {ok: true}; the log line holds the word only', async (result) => {
    expect(await post(bearer, { provision_id: PID, result })).toEqual({ status: 200, body: { ok: true } })
    const s = await redis.hgetall<Record<string, unknown>>(stateKey)
    expect(s).toMatchObject({ teardownApp: result })
    expect(String(s?.teardownAppAt)).toMatch(/^2026-11-08T12:10:00/)
    expect(logs).toEqual([`teardown-result: ${result}`])
  })

  it('an unknown provision: 404', async () => {
    const other = 'Un0000000000000000000k'
    expect(await post(`Bearer ${callbackToken(CB_SECRET, other)}`, { provision_id: other, result: 'gone' })).toMatchObject({ status: 404 })
  })

  it.each(['deleted', 'gone'])('%s on a tearing_down sign-up makes it torn_down in one step and puts it in sweep:teardown', async (result) => {
    await redis.hset(stateKey, { status: 'tearing_down' })
    expect(await post(bearer, { provision_id: PID, result })).toEqual({ status: 200, body: { ok: true } })
    expect(await redis.hgetall<Record<string, unknown>>(stateKey)).toMatchObject({ status: 'torn_down', teardownApp: result })
    expect(await redis.zrange(TEARDOWN_INDEX, '-inf', '+inf', { byScore: true })).toEqual([SID])
  })

  it.each(['refused', 'failed'])('%s on a tearing_down sign-up stores the word, stays tearing_down and is flagged for a person', async (result) => {
    await redis.hset(stateKey, { status: 'tearing_down' })
    expect(await post(bearer, { provision_id: PID, result })).toEqual({ status: 200, body: { ok: true } })
    const s = await redis.hgetall<Record<string, unknown>>(stateKey)
    expect(s).toMatchObject({ status: 'tearing_down', teardownApp: result })
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([`teardown_refused_or_failed:${SID}`])
  })

  it('deleted on a sign-up not tearing_down (declined) only stores the word', async () => {
    expect(await post(bearer, { provision_id: PID, result: 'deleted' })).toEqual({ status: 200, body: { ok: true } })
    expect(await redis.hgetall<Record<string, unknown>>(stateKey)).toMatchObject({ status: 'declined', teardownApp: 'deleted' })
    expect(await redis.zrange('reconcile:flags', 0, -1)).toEqual([])
  })

  it('the route is thin: the bearer header, the body, the callback secret and no-store', () => {
    const src = readFileSync(new URL('../../server/api/teardown-result.post.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/handleTeardownResult\(/)
    expect(src).toMatch(/readBody\(event\)/)
    expect(src).toMatch(/'Cache-Control', 'no-store'/)
  })
})

describe('index names are shared with billing.ts', () => {
  it('sweep:teardown and sweep:held', () => {
    expect(TEARDOWN_INDEX).toBe('sweep:teardown')
    expect(HELD_INDEX).toBe('sweep:held')
  })
})

// --- Task 2: the 3DS hold --------------------------------------------------------

const HELD_UNTIL = Date.parse('2026-11-09T16:15:00Z')
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_secret_canary'

describe('formatHeldUntil (shared/billing-time.ts): 12-hour, lowercase am/pm, with the zone (Q-time)', () => {
  it('UTC: "November 9, 2026 at 4:15pm UTC"', () => {
    expect(formatHeldUntil(HELD_UNTIL, 'UTC')).toBe('November 9, 2026 at 4:15pm UTC')
  })

  it('America/Denver (standard time since November 1): "November 9, 2026 at 9:15am MST"', () => {
    expect(formatHeldUntil(HELD_UNTIL, 'America/Denver')).toBe('November 9, 2026 at 9:15am MST')
  })

  it('America/New_York: "November 9, 2026 at 11:15am EST"', () => {
    expect(formatHeldUntil(HELD_UNTIL, 'America/New_York')).toBe('November 9, 2026 at 11:15am EST')
  })

  it('midnight reads 12:00am, noon 12:00pm', () => {
    expect(formatHeldUntil(Date.parse('2026-11-09T00:00:00Z'), 'UTC')).toBe('November 9, 2026 at 12:00am UTC')
    expect(formatHeldUntil(Date.parse('2026-11-09T12:00:00Z'), 'UTC')).toBe('November 9, 2026 at 12:00pm UTC')
  })

  it('an invalid zone falls back to UTC', () => {
    expect(formatHeldUntil(HELD_UNTIL, 'Mars/Olympus_Mons')).toBe('November 9, 2026 at 4:15pm UTC')
  })

  it('no zone: the reader\'s own zone (the browser\'s), same shape', () => {
    expect(formatHeldUntil(HELD_UNTIL)).toMatch(/^November (8|9|10), 2026 at \d{1,2}:\d{2}(am|pm) \S+$/)
  })

  it('the file imports nothing from Node (the browser loads it)', () => {
    const src = readFileSync(new URL('../../shared/billing-time.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from 'node:|require\(/)
  })
})

async function seedHeld(redis: FakeRedis, extra: Record<string, unknown> = {}, signupExtra: Record<string, unknown> = {}) {
  await seedDeclined(redis)
  await redis.hset(stateKey, { status: 'held', billing: 'held', teardownReason: '', declinedAt: '', heldUntil: HELD_UNTIL, heldAt: '2026-11-08T17:15:00.000Z', ...extra })
  await redis.zrem(TEARDOWN_INDEX, SID)
  await redis.zadd(HELD_INDEX, { score: HELD_UNTIL, member: SID })
  await redis.hset(signupKey, { hostedInvoiceUrl: HOSTED, timeZone: 'America/Denver', ...signupExtra })
}

function heldMailBody(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const [url, opts] = fetchMock.mock.calls[call] as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
  return { url, headers: opts.headers, body: opts.body }
}

describe('the "Confirm your payment" mail (onHeld and the held step)', () => {
  let redis: FakeRedis
  let fetchMock: ReturnType<typeof vi.fn>
  let logs: string[]
  const deps = () => ({ redis, mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock }, log: (m: string) => logs.push(m) })

  beforeEach(async () => {
    redis = new FakeRedis()
    fetchMock = vi.fn(async () => ({ id: 'e' }))
    logs = []
    await seedHeld(redis)
  })

  it('one mail: subject, the approved body with the time in the stored zone, "Confirm my payment" to the hosted page, reply-to, html, held-mail-{provisionId}', async () => {
    expect(await sendHeldMail(SID, deps())).toBe('sent')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { url, headers, body } = heldMailBody(fetchMock)
    expect(url).toBe('https://api.resend.com/emails')
    expect(headers['Idempotency-Key']).toBe(`held-mail-${PID}`)
    expect(body).toMatchObject({ to: [EMAIL], reply_to: REPLY_TO, subject: 'Confirm your payment' })
    expect(String(body.text)).toContain('Your community\'s site is ready. Your bank needs you to confirm the first payment before we hand it over. Please confirm it by November 9, 2026 at 9:15am MST; after that we\'ll remove the site and you won\'t be charged.')
    expect(String(body.text)).toContain(`Confirm my payment: ${HOSTED}`)
    expect(String(body.html)).toContain(`href="${HOSTED}"`)
    expect(String(body.html)).not.toMatch(/unsubscribe/i)
    expect(await redis.hgetall<Record<string, unknown>>(stateKey)).toMatchObject({ heldMailSent: true })
  })

  it('no stored zone: the time is in UTC', async () => {
    await redis.hset(signupKey, { timeZone: '' })
    await sendHeldMail(SID, deps())
    expect(String(heldMailBody(fetchMock).body.text)).toContain('Please confirm it by November 9, 2026 at 4:15pm UTC;')
  })

  it('a stored zone that is not a zone: UTC', async () => {
    await redis.hset(signupKey, { timeZone: 'Not/AZone' })
    await sendHeldMail(SID, deps())
    expect(String(heldMailBody(fetchMock).body.text)).toContain('at 4:15pm UTC;')
  })

  it('a second call sends nothing', async () => {
    await sendHeldMail(SID, deps())
    expect(await sendHeldMail(SID, deps())).toBe('skipped')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a sign-up no longer held gets no mail', async () => {
    await redis.hset(stateKey, { status: 'ready' })
    expect(await sendHeldMail(SID, deps())).toBe('skipped')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a Resend failure leaves heldMailSent unset and is raised', async () => {
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    await expect(sendHeldMail(SID, deps())).rejects.toThrow()
    expect((await redis.hgetall<Record<string, unknown>>(stateKey))?.heldMailSent).toBeUndefined()
  })

  it('the log lines never carry the hosted URL, the address or an id', async () => {
    await sendHeldMail(SID, deps())
    const all = logs.join('\n')
    for (const canary of [HOSTED, 'invoice.stripe.com', EMAIL, SID, PID]) expect(all).not.toContain(canary)
  })

  it('makeBillingDeps wires onHeld to sendHeldMail through the teardown hook', () => {
    const src = readFileSync(new URL('../../server/utils/billing-wiring.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/onHeld: teardownHook\(sid => sendHeldMail\(/)
  })
})

describe('the QStash held step (sweepHeld) and teardowns step (sweepTeardowns)', () => {
  let redis: FakeRedis
  let calls: Calls
  let stripe: StripeMock
  let billingStripe: { invoices: { retrieve: ReturnType<typeof vi.fn>, pay: ReturnType<typeof vi.fn> }, setupIntents: { retrieve: ReturnType<typeof vi.fn> }, subscriptions: { create: ReturnType<typeof vi.fn>, list: ReturnType<typeof vi.fn> } }
  let fetchMock: ReturnType<typeof vi.fn>
  let siteFetch: ReturnType<typeof vi.fn>
  let teardown: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let deps: SweepDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    calls = []
    stripe = makeStripe(calls)
    billingStripe = {
      invoices: { retrieve: vi.fn(async () => ({ id: INVOICE, status: 'open' })), pay: vi.fn() },
      setupIntents: { retrieve: vi.fn() },
      subscriptions: { create: vi.fn(), list: vi.fn() }
    }
    fetchMock = vi.fn(async () => { calls.push('resend'); return { id: 'e' } })
    siteFetch = vi.fn(async () => ({ status: 200, json: async () => ({ activated: true }) }))
    teardown = vi.fn(async () => { calls.push('teardown') })
    logs = []
    clock = HELD_UNTIL - 60 * 60 * 1000
    const billing: BillingDeps = {
      redis,
      stripe: () => billingStripe as never,
      fetch: siteFetch,
      callbackSecret: CB_SECRET,
      now: () => clock,
      sleep: async () => {},
      log: m => logs.push(m)
    }
    deps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      inviteHashSecret: INVITE_SECRET,
      teardown,
      onPaid: async (pid: string) => { await (await import('../../server/utils/billing')).onFirstInvoicePaid(pid, billing) },
      billing,
      now: () => clock,
      log: m => logs.push(m)
    }
    await seedHeld(redis)
  })

  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)
  const members = (key: string) => redis.zrange(key, '-inf', '+inf', { byScore: true })

  it('CRON_STEPS names are, in order, stops, held, billing, refunds (23-43 Task 6), teardowns', () => {
    expect(CRON_STEPS.map(s => s.name)).toEqual(['stops', 'held', 'billing', 'refunds', 'teardowns'])
  })

  it('before heldUntil: a held member with no mail gets it; no invoice read; the member stays', async () => {
    expect(await sweepHeld(deps)).toEqual({ due: 1, mailed: 1, confirmed: 0, expired: 0, busy: 0, errors: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(billingStripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(await members(HELD_INDEX)).toEqual([SID])
  })

  it('a held mail that failed in onHeld is sent once by the next held step', async () => {
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    expect(await sweepHeld(deps)).toMatchObject({ mailed: 0, errors: 1 })
    expect(await sweepHeld(deps)).toMatchObject({ mailed: 1, errors: 0 })
    expect(await sweepHeld(deps)).toMatchObject({ mailed: 0, errors: 0 })
    expect((fetchMock.mock.calls as unknown[]).length).toBe(2)
    expect(await state()).toMatchObject({ heldMailSent: true })
  })

  it('a member whose status is not held is removed', async () => {
    await redis.hset(stateKey, { status: 'ready' })
    expect(await sweepHeld(deps)).toMatchObject({ due: 1, mailed: 0 })
    expect(await members(HELD_INDEX)).toEqual([])
  })

  it('confirmed at the last minute: past heldUntil the invoice reads paid, so the paid path runs (activated), nothing is torn down', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    billingStripe.invoices.retrieve.mockResolvedValue({ id: INVOICE, status: 'paid' })
    expect(await sweepHeld(deps)).toEqual({ due: 1, mailed: 0, confirmed: 1, expired: 0, busy: 0, errors: 0 })
    const s = await state()
    expect(s).toMatchObject({ status: 'complete', subscriptionId: SUB, billing: 'paid' })
    expect(s?.teardownReason).not.toBe('held_expired')
    expect(teardown).not.toHaveBeenCalled()
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(await members(HELD_INDEX)).toEqual([])
    expect(siteFetch).toHaveBeenCalledTimes(1)
  })

  it('time up and unpaid: under one lease the void, then tearing_down with held_expired, then the rest of the teardown (invite reopened, the dispatch)', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    expect(await sweepHeld(deps)).toEqual({ due: 1, mailed: 0, confirmed: 0, expired: 1, busy: 0, errors: 0 })
    const s = await state()
    expect(s).toMatchObject({ status: 'tearing_down', billing: 'declined', teardownReason: 'held_expired', tornDown: true, stopInvoice: true, stopInvite: true, stopApp: true })
    expect(calls[0]).toBe('invoices.retrieve')
    expect(calls[1]).toBe('invoices.voidInvoice')
    expect(calls.at(-1)).toBe('teardown')
    expect(await redis.hgetall(inviteHash)).toMatchObject({ status: 'open' })
    expect(await members(HELD_INDEX)).toEqual([])
    // Every runner step ran; the workflow's deleted brings it back for the removed mail.
    expect(await members(TEARDOWN_INDEX)).toEqual([])
  })

  it('the removed mail goes out once, keyed removed-mail-{provisionId}, only after the workflow reports deleted (P4)', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    await sweepHeld(deps)
    expect(fetchMock).not.toHaveBeenCalled()
    const route = { redis, secret: CB_SECRET, now: () => clock }
    expect(await handleTeardownResult(bearer, { provision_id: PID, result: 'deleted' }, route)).toEqual({ status: 200, body: { ok: true } })
    expect(await state()).toMatchObject({ status: 'torn_down', removedMailDue: true })
    expect(await sweepTeardowns(deps)).toEqual({ due: 1, tornDown: 0, mailed: 1, busy: 0, cleared: 0, errors: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { headers, body } = heldMailBody(fetchMock)
    expect(headers['Idempotency-Key']).toBe(`removed-mail-${PID}`)
    expect(body).toMatchObject({ to: [EMAIL], reply_to: REPLY_TO, subject: 'We\'ve removed your site' })
    expect(String(body.text)).toContain('We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.')
    expect(String(body.text)).toContain('Try again: https://localnodes.xyz/invite')
    expect(body.html).toBe(buildRemovedMail().html)
    expect(await state()).toMatchObject({ stopMail: true, removedMailDue: '' })
    expect(await members(TEARDOWN_INDEX)).toEqual([])
    expect(await sweepTeardowns(deps)).toMatchObject({ due: 0, mailed: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a refused or failed result sends no removed mail and the sign-up is flagged for a person', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    await sweepHeld(deps)
    await handleTeardownResult(bearer, { provision_id: PID, result: 'refused' }, { redis, secret: CB_SECRET, now: () => clock })
    await sweepTeardowns(deps)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ status: 'tearing_down', teardownApp: 'refused' })
    expect(await members('reconcile:flags')).toEqual([`teardown_refused_or_failed:${SID}`])
  })

  it('a removed mail that fails stays owed: counted in errors, sent on the next teardowns step', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    await sweepHeld(deps)
    await handleTeardownResult(bearer, { provision_id: PID, result: 'gone' }, { redis, secret: CB_SECRET, now: () => clock })
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    expect(await sweepTeardowns(deps)).toMatchObject({ due: 1, mailed: 0, errors: 1 })
    expect(await state()).toMatchObject({ removedMailDue: true })
    expect(await sweepTeardowns(deps)).toMatchObject({ due: 1, mailed: 1, errors: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an activation_failed teardown that carries a subscription is run by the teardowns step, not skipped (Codex 3)', async () => {
    await seedDeclined(redis, { status: 'tearing_down', teardownReason: 'activation_failed', subscriptionId: SUB, billing: 'paid', refundSucceededAt: '2026-11-09T10:00:00.000Z', stopInvoice: true, pendingSubscriptionId: '', invoiceId: '' })
    clock = Date.parse('2026-11-09T12:00:00Z')
    expect(await sweepTeardowns(deps)).toMatchObject({ due: 1, tornDown: 1, errors: 0 })
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ status: 'tearing_down', tornDown: true, stopApp: true })
  })

  it('held_expired sends no "We\'ve removed your site" mail before the workflow confirms the delete (P4)', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    await sweepHeld(deps)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await state())?.stopMail).toBeUndefined()
  })

  it('no confirm mail to an expired hold', async () => {
    clock = HELD_UNTIL
    expect(await sweepHeld(deps)).toMatchObject({ mailed: 0, expired: 1, errors: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await state())?.heldMailSent).toBeUndefined()
  })

  it('a payment confirmed at the last second never shows as expired', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    const seen: Array<Record<string, unknown>> = []
    stripe.invoices.voidInvoice.mockImplementationOnce(async () => {
      const s = (await state())!
      seen.push({ status: s.status, teardownReason: s.teardownReason })
      throw new Stripe.errors.StripeInvalidRequestError({ message: 'You can only void open invoices.' } as never)
    })
    stripe.invoices.retrieve
      .mockResolvedValueOnce({ id: INVOICE, status: 'open' })
      .mockResolvedValueOnce({ id: INVOICE, status: 'paid' })
    expect(await sweepHeld(deps)).toMatchObject({ confirmed: 1, expired: 0, errors: 0 })
    expect(seen).toEqual([{ status: 'held', teardownReason: '' }])
    const s = await state()
    expect(s?.teardownReason).not.toBe('held_expired')
    expect(s?.status).not.toBe('tearing_down')
    expect(teardown).not.toHaveBeenCalled()
  })

  it('a 3DS payment confirmed during the void hands back: ready and paid in one step, then activated', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    stripe.invoices.voidInvoice.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({ message: 'You can only void open invoices.' } as never))
    stripe.invoices.retrieve
      .mockResolvedValueOnce({ id: INVOICE, status: 'open' })
      .mockResolvedValueOnce({ id: INVOICE, status: 'paid', amount_paid: 4900, currency: 'usd' } as never)
    expect(await sweepHeld(deps)).toMatchObject({ confirmed: 1, expired: 0 })
    expect(await state()).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB, amountPaid: 4900, currency: 'usd', teardownReason: '' })
    expect((await state())?.stopInvoice).toBeUndefined()
    expect(await members(HELD_INDEX)).toEqual([])
    expect(siteFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['zero', 0],
    ['not a number', 'soon']
  ])('heldUntil %s: errors plus one, no mail, no expiry, a fixed log line, heldUntilBad and a reconcile:flags entry; the member stays', async (_l, value) => {
    if (value === undefined) {
      const { heldUntil: _gone, ...rest } = (await state())!
      await redis.del(stateKey)
      await redis.hset(stateKey, rest)
    } else {
      await redis.hset(stateKey, { heldUntil: value })
    }
    clock = HELD_UNTIL + 1
    expect(await sweepHeld(deps)).toEqual({ due: 1, mailed: 0, confirmed: 0, expired: 0, busy: 0, errors: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(stripe.invoices.voidInvoice).not.toHaveBeenCalled()
    expect(billingStripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ status: 'held', heldUntilBad: true })
    expect(logs).toContain('teardown: held sign-up has no valid deadline; flagged for a person')
    expect(await members('reconcile:flags')).toEqual([`held_until_bad:${SID}`])
    expect(await members(HELD_INDEX)).toEqual([SID])
  })

  it('a confirm mail that fails on one member counts in errors; the next member still gets its own', async () => {
    const OTHER = 'cs_test_held_other'
    await redis.hset(`provision:${OTHER}`, { status: 'held', provisionId: 'Ot0000000000000000000r', heldUntil: HELD_UNTIL + 5 })
    await redis.hset('signup:Ot0000000000000000000r', { email: 'other@example.org', hostedInvoiceUrl: HOSTED })
    await redis.zadd(HELD_INDEX, { score: HELD_UNTIL + 5, member: OTHER })
    fetchMock.mockRejectedValueOnce(new Error('resend down'))
    expect(await sweepHeld(deps)).toMatchObject({ due: 2, mailed: 1, errors: 1 })
    expect(await redis.hgetall<Record<string, unknown>>(`provision:${OTHER}`)).toMatchObject({ heldMailSent: true })
  })

  it('the invoice read in the held step is under the lifecycle lock (23-43): while another runner holds it, the member is busy and nothing changes', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    await redis.set(`provision:${SID}:lifecycle`, 'someone-else', { nx: true, ex: 120 })
    expect(await sweepHeld(deps)).toMatchObject({ busy: 1, expired: 0, confirmed: 0 })
    expect(billingStripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ status: 'held' })
    expect(await members(HELD_INDEX)).toEqual([SID])
  })

  it('an invoice read that throws counts in errors and leaves the member held', async () => {
    await redis.hset(stateKey, { heldMailSent: true })
    clock = HELD_UNTIL + 1
    billingStripe.invoices.retrieve.mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' } as never))
    expect(await sweepHeld(deps)).toMatchObject({ errors: 1, expired: 0 })
    expect(await state()).toMatchObject({ status: 'held' })
  })

  it('the held step reads sweep:held once, oldest heldUntil first, at most 50', async () => {
    for (let i = 0; i < 60; i++) await redis.zadd(HELD_INDEX, { score: HELD_UNTIL + i, member: `cs_test_gone_${String(i).padStart(2, '0')}` })
    const zrange = vi.spyOn(redis, 'zrange')
    const counts = await sweepHeld(deps)
    expect(zrange).toHaveBeenCalledTimes(1)
    expect(zrange.mock.calls[0]).toEqual([HELD_INDEX, '-inf', '+inf', { byScore: true, offset: 0, count: 50 }])
    expect(counts.due).toBe(50)
  })

  it('counts only in the logs: no id, address or URL', async () => {
    clock = HELD_UNTIL + 1
    await sweepHeld(deps)
    const all = logs.join('\n')
    for (const canary of [SID, PID, EMAIL, HOSTED, SUB, INVOICE]) expect(all).not.toContain(canary)
  })

  it('the teardowns step finishes a teardown cut short, once', async () => {
    await seedDeclined(redis)
    clock = Date.parse('2026-11-08T12:10:00Z')
    teardown.mockRejectedValueOnce(new Error('GitHub dispatch failed (502)'))
    await expect(stopProvision(SID, deps)).rejects.toThrow()
    expect(await sweepTeardowns(deps)).toEqual({ due: 1, tornDown: 1, mailed: 0, busy: 0, cleared: 0, errors: 0 })
    expect(await state()).toMatchObject({ tornDown: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await sweepTeardowns(deps)).toEqual({ due: 0, tornDown: 0, mailed: 0, busy: 0, cleared: 0, errors: 0 })
  })

  it('the teardowns step clears a member that owes nothing (gone, already torn down, paid, complete)', async () => {
    clock = Date.parse('2026-11-08T12:10:00Z')
    await redis.zadd(TEARDOWN_INDEX, { score: 1, member: 'cs_test_gone' })
    // Paid (23-43): a handed-back sign-up is ready with its subscription; a declined record never carries one.
    await redis.hset('provision:cs_test_paid', { status: 'ready', billing: 'paid', teardownReason: '', subscriptionId: SUB })
    await redis.zadd(TEARDOWN_INDEX, { score: 1, member: 'cs_test_paid' })
    expect(await sweepTeardowns(deps)).toEqual({ due: 2, tornDown: 0, mailed: 0, busy: 0, cleared: 2, errors: 0 })
    expect(calls).toEqual([])
  })

  it('the teardowns step while another runner holds the lifecycle lock (23-43): busy, the member stays', async () => {
    await seedDeclined(redis)
    clock = Date.parse('2026-11-08T12:10:00Z')
    await redis.set(`provision:${SID}:lifecycle`, 'someone-else', { nx: true, ex: 120 })
    expect(await sweepTeardowns(deps)).toEqual({ due: 1, tornDown: 0, mailed: 0, busy: 1, cleared: 0, errors: 0 })
    expect(await members(TEARDOWN_INDEX)).toEqual([SID])
  })

  it('the teardowns step reads sweep:teardown due members once, at most 50', async () => {
    const zrange = vi.spyOn(redis, 'zrange')
    await sweepTeardowns(deps)
    expect(zrange).toHaveBeenCalledTimes(1)
    expect(zrange.mock.calls[0]).toEqual([TEARDOWN_INDEX, '-inf', clock, { byScore: true, offset: 0, count: 50 }])
  })
})

describe('HIGH 3, Codex\'s reproduction: a sign-up with a payment in flight is never approved for deletion', () => {
  it('teardown-check while a payment is in flight answers 409; payment and activation finish; teardown-check still answers 409; a build-failure stop attempted meanwhile is refused; complete never sits with stopped, tornDown or teardownDispatchedAt', async () => {
    const redis = new FakeRedis()
    await seedDeclined(redis)
    // A sign-up ready with two failures recorded (the count Argon and Codex used to reach the old approval).
    await redis.hset(stateKey, { status: 'ready', billing: '', teardownReason: '', pendingSubscriptionId: '', invoiceId: '', failedAttempts: 2, siteAnsweredAt: 'x' })
    await redis.zadd(BILLING_INDEX, { score: 1, member: SID })
    const checks: unknown[] = []
    const stops: unknown[] = []
    const teardown = vi.fn(async () => {})
    const stopDeps: RetryStopDeps = {
      redis,
      stripe: () => makeStripe([]),
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: vi.fn(async () => ({ id: 'e' })) },
      inviteHashSecret: INVITE_SECRET,
      teardown,
      log: () => {}
    }
    const billingStripe = {
      setupIntents: { retrieve: vi.fn(async () => ({ id: SETUP_INTENT, status: 'succeeded', payment_method: PM })) },
      subscriptions: {
        create: vi.fn(async () => ({ id: SUB, created: 1794225600, status: 'incomplete', metadata: { provision_id: PID }, latest_invoice: { id: INVOICE, status: 'open' } })),
        list: vi.fn(async () => ({ data: [] }))
      },
      invoices: {
        retrieve: vi.fn(async () => ({ id: INVOICE, status: 'open' })),
        pay: vi.fn(async () => {
          checks.push(await handleTeardownCheck(bearer, PID, { redis, secret: CB_SECRET }))
          stops.push(await stopProvision(SID, stopDeps))
          return { id: INVOICE, status: 'paid', amount_paid: 4900, currency: 'usd' }
        })
      }
    }
    const billing: BillingDeps = {
      redis,
      stripe: () => billingStripe as never,
      fetch: vi.fn(async () => ({ status: 200, json: async () => ({ activated: true }) })),
      callbackSecret: CB_SECRET,
      sleep: async () => {},
      log: () => {}
    }
    const { chargeAtReady } = await import('../../server/utils/billing')
    expect(await chargeAtReady(SID, billing)).toBe('activated')
    expect(checks).toEqual([{ status: 409, body: { teardown: false } }])
    expect(stops).toEqual([{ stopped: false }])
    expect(await handleTeardownCheck(bearer, PID, { redis, secret: CB_SECRET })).toEqual({ status: 409, body: { teardown: false } })
    expect(await stopProvision(SID, stopDeps)).toEqual({ stopped: false })
    const s = (await redis.hgetall<Record<string, unknown>>(stateKey))!
    expect(s).toMatchObject({ status: 'complete', billing: 'paid', subscriptionId: SUB })
    expect(s.stopped).toBeUndefined()
    expect(s.tornDown).toBeUndefined()
    expect(s.teardownDispatchedAt).toBeUndefined()
    expect(teardown).not.toHaveBeenCalled()
  })
})
