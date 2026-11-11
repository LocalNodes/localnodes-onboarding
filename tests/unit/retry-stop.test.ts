import { describe, it, expect, beforeEach, vi } from 'vitest'
import { callbackToken, handleProvisionCallback, handleProvisionStatus } from '../../server/utils/provision-handlers'
import { handleRetryRequest, retryProvisioning, stopProvision, type RetryStopDeps } from '../../server/utils/retry-stop'
import { triggerProvisioning } from '../../server/utils/provisioning'
import { REPLY_TO, STOPPED_MAIL, STOPPED_SENTENCE } from '../../server/utils/mail-copy'
import { FakeRedis } from './helpers/fake-redis'

/**
 * Failure, free retry and stop (Phase 23, plan 23-14; ONB-02, D-15, D-16 as
 * superseded by T-3, D-17).
 *
 * A failed build frees the lock and offers one free retry on the same Stripe
 * session (no new checkout). A second failure stops the sign-up: the code hold
 * and the lock are released, the saved card is detached, the record is marked
 * stopped and one "you weren't charged" mail goes out. Nothing is charged, so
 * nothing is refunded or cancelled. Fakes only: FakeRedis, a Stripe mock whose
 * every money method is a spy that must stay unused, and a mocked Resend fetch.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CONFIG = { provisionCallbackSecret: SECRET }
const SID = 'cs_test_retry_stop'
const PID = 'A1b2C3d4E5f6G7h8I9j0Kl'
const PROMO = 'promo_pilot_1'
const INVITE = 'inv_0001'
const SETUP_INTENT = 'seti_123'
const PAYMENT_METHOD = 'pm_saved_card'
const EMAIL = 'organizer@example.org'
const RUN = { runId: 42, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/42' }

const stateKey = `provision:${SID}`
const lockKey = `provision:${SID}:lock`
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

async function seed(redis: FakeRedis) {
  // What 23-11 (trigger), 23-07 (checkout) and 23-31 (webhook) leave behind.
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
  // The code hold the webhook re-armed for the build (23-31): one member, the invite.
  await redis.zadd(`promo:holds:${PROMO}`, { score: Math.floor(Date.now() / 1000) + 7800, member: INVITE })
}

describe('retry-stop (tracer): failed, free retry on the same session, failed again, stopped once', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let dispatch: ReturnType<typeof vi.fn>
  let deps: RetryStopDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue({ id: 'email_1' })
    dispatch = vi.fn().mockResolvedValue(RUN)
    deps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      // The app delete (23-37): a mocked dispatch, never GitHub.
      teardown: vi.fn().mockResolvedValue(undefined),
      dispatch,
      log: () => {}
    }
    await seed(redis)
  })

  const failed = (attempt: number, extra: Record<string, unknown> = {}) =>
    handleProvisionCallback(bearer, { provision_id: PID, attempt, status: 'failed', reason: 'deploy_timeout', source: 'workflow', ...extra }, CONFIG, redis, deps)

  it('a failed workflow callback for attempt 1 counts one failure, sets failed and canRetry, and frees the lock', async () => {
    expect(await failed(1)).toEqual({ updated: true })
    const state = await redis.hgetall<Record<string, unknown>>(stateKey)
    expect(state).toMatchObject({ status: 'failed', reason: 'deploy_timeout', failedAttempts: 1, canRetry: true })
    expect(await redis.exists(lockKey)).toBe(0)
    expect(await handleProvisionStatus(SID, redis)).toMatchObject({ status: 'failed', canRetry: true })
  })

  it('retryProvisioning re-dispatches attempt 2 with the same provision id and never creates a checkout', async () => {
    await failed(1)
    const seen: unknown[] = []
    dispatch.mockImplementation(async () => {
      seen.push((await redis.hgetall<Record<string, unknown>>(stateKey))?.status)
      return RUN
    })
    const outcome = await retryProvisioning(SID, deps)
    expect(outcome.status).toBe(200)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ subdomain: 'cascadia', provisionId: PID, attempt: 2 })
    expect(seen).toEqual(['triggered'])
    expect(await redis.hgetall(stateKey)).toMatchObject({ attempt: 2, status: 'provisioning', canRetry: false })
    expect(await redis.exists(lockKey)).toBe(1)
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
  })

  it('a failed callback for attempt 2 stops once: hold and lock released, card detached once, stopped, one mail', async () => {
    await failed(1)
    await retryProvisioning(SID, deps)
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(1)

    await failed(2)

    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
    expect(await redis.exists(lockKey)).toBe(0)
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledWith(SETUP_INTENT, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith(PAYMENT_METHOD, {}, { timeout: 15000, maxNetworkRetries: 0 })
    expect(stripe.setupIntents.retrieve.mock.invocationCallOrder[0]!).toBeLessThan(stripe.paymentMethods.detach.mock.invocationCallOrder[0]!)

    const state = await redis.hgetall<Record<string, unknown>>(stateKey)
    // 23-43 Task 2: tearing_down inside; the page still sees failed and stopped.
    expect(state).toMatchObject({ status: 'tearing_down', teardownReason: 'build_failed', failedAttempts: 2, stopped: true, canRetry: false })
    expect(await handleProvisionStatus(SID, redis)).toMatchObject({ status: 'failed', canRetry: false, stopped: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    expect(opts.headers['Idempotency-Key']).toBe(`stop-mail-${PID}`)
    expect(opts.headers.Authorization).toBe('Bearer re_test_key')
    expect(opts.headers).not.toHaveProperty('List-Unsubscribe')
    expect(opts.body.to).toEqual([EMAIL])
    expect(opts.body.subject).toBe('We couldn\'t set up your site')
    expect(opts.body.text).toContain('We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.')
    expect(opts.body.text).toContain('Sent by LocalNodes · Home base for communities that run things together.')
    expect(opts.body.text).not.toMatch(/unsubscribe/i)
    expect(opts.body.reply_to).toBe('hello@localnodes.xyz')
    expect(opts.body.html).toBe(STOPPED_MAIL.html)
    expect(String(opts.body.html)).not.toMatch(/unsubscribe/i)
    expect(opts.body).not.toHaveProperty('headers')
  })

  it('the stopped mail copy is word for word the 23-UI-SPEC section 12 "Stopped (T-3)" row, with reply-to hello@localnodes.xyz', () => {
    expect(REPLY_TO).toBe('hello@localnodes.xyz')
    expect(STOPPED_SENTENCE).toBe('We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.')
    expect(STOPPED_MAIL.subject).toBe('We couldn\'t set up your site')
    expect(STOPPED_MAIL.text).toBe([
      'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.',
      '',
      'Sent by LocalNodes · Home base for communities that run things together.'
    ].join('\n'))
  })

  it('no refund, invoice, invoice-payment, subscription, checkout or payment-intent method is called anywhere in the flow', async () => {
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2)
    await stopProvision(SID, deps)
    expect(moneyCalls(stripe)).toBe(0)
  })
})

describe('retry-stop: replays, races, third tries, provisional site failures and dispatch failures', () => {
  let redis: FakeRedis
  let stripe: StripeMock
  let fetchMock: ReturnType<typeof vi.fn>
  let dispatch: ReturnType<typeof vi.fn>
  let logs: string[]
  let clock: number
  let deps: RetryStopDeps

  beforeEach(async () => {
    redis = new FakeRedis()
    stripe = makeStripe()
    fetchMock = vi.fn().mockResolvedValue({ id: 'email_1' })
    dispatch = vi.fn().mockResolvedValue(RUN)
    logs = []
    clock = Date.parse('2026-11-08T10:30:00Z')
    deps = {
      redis,
      // The app delete (23-37): a mocked dispatch, never GitHub.
      teardown: vi.fn().mockResolvedValue(undefined),
      stripe: () => stripe,
      mail: { apiKey: 're_test_key', from: 'LocalNodes <hello@localnodes.xyz>', fetch: fetchMock },
      dispatch,
      now: () => clock,
      log: msg => logs.push(msg)
    }
    await seed(redis)
  })

  const callback = (attempt: number, status: string, extra: Record<string, unknown> = {}) =>
    handleProvisionCallback(bearer, { provision_id: PID, attempt, status, ...extra }, CONFIG, redis, deps)
  const failed = (attempt: number, source = 'workflow') =>
    callback(attempt, 'failed', { reason: 'deploy_timeout', source })
  const state = () => redis.hgetall<Record<string, unknown>>(stateKey)

  async function twoFailures() {
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2)
  }

  it('the same failed callback delivered twice counts once', async () => {
    await failed(1)
    expect(await failed(1)).toEqual({ updated: false })
    expect(await state()).toMatchObject({ failedAttempts: 1, canRetry: true })
  })

  it('the same failed callback delivered twice at once counts once', async () => {
    await Promise.all([failed(1), failed(1)])
    expect(await state()).toMatchObject({ failedAttempts: 1, canRetry: true })
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
  })

  it('two retryProvisioning calls in the same tick dispatch once', async () => {
    await failed(1)
    const [a, b] = await Promise.all([retryProvisioning(SID, deps), retryProvisioning(SID, deps)])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const refused = a.status === 409 ? a : b
    expect(refused.body).toEqual({ message: 'Setup is already running.' })
    expect(await state()).toMatchObject({ attempt: 2 })
  })

  it('a third try after two failures is refused with the stopped sentence and dispatches nothing', async () => {
    await twoFailures()
    dispatch.mockClear()
    const outcome = await retryProvisioning(SID, deps)
    expect(outcome).toEqual({ status: 409, body: { message: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.' } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a retry while a build is still running is refused and dispatches nothing', async () => {
    const outcome = await retryProvisioning(SID, deps)
    expect(outcome).toEqual({ status: 409, body: { message: 'Setup is already running.' } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('a stop whose mail throws still runs the steps after it; the next run sends the mail and detaches nothing again', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('Resend 500'), { statusCode: 500 }))
    await twoFailures()
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 23-43 Task 2: a failed mail never blocks the dispatch.
    expect(deps.teardown).toHaveBeenCalledTimes(1)
    expect((await state())?.stopped).toBeUndefined()
    expect(await handleProvisionStatus(SID, redis)).toMatchObject({ status: 'failed', canRetry: false, stopped: false })

    await stopProvision(SID, deps)
    expect(stripe.setupIntents.retrieve).toHaveBeenCalledTimes(1)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].headers['Idempotency-Key']).toBe(`stop-mail-${PID}`)
    expect(await state()).toMatchObject({ stopped: true, canRetry: false })
  })

  it('a replayed failed callback for attempt 2 finishes a stop that was cut short', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Resend down'))
    await twoFailures()
    await failed(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(await state()).toMatchObject({ stopped: true, failedAttempts: 2 })
  })

  it('a second full stop run makes no Stripe or Resend call', async () => {
    await twoFailures()
    stripe.setupIntents.retrieve.mockClear()
    stripe.paymentMethods.detach.mockClear()
    fetchMock.mockClear()
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    await failed(2)
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a card that is already detached counts as done', async () => {
    stripe.paymentMethods.detach.mockRejectedValueOnce(Object.assign(new Error('The payment method you provided is not attached to a customer so detachment is impossible.'), { type: 'StripeInvalidRequestError', code: undefined }))
    await twoFailures()
    expect(await state()).toMatchObject({ stopped: true, stopCard: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a card Stripe no longer knows counts as done', async () => {
    stripe.paymentMethods.detach.mockRejectedValueOnce(Object.assign(new Error('No such PaymentMethod: \'pm_saved_card\''), { code: 'resource_missing' }))
    await twoFailures()
    expect(await state()).toMatchObject({ stopped: true })
  })

  it('any other Stripe error leaves the card step undone and the sign-up not yet stopped', async () => {
    stripe.paymentMethods.detach.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 'rate_limit' }))
    await twoFailures()
    expect((await state())?.stopCard).toBeUndefined()
    expect((await state())?.stopped).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a provision with a subscriptionId is never stopped, whatever its failure count', async () => {
    await redis.hset(stateKey, { subscriptionId: 'sub_123', failedAttempts: 5 })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: false })
    await failed(1)
    await redis.hset(stateKey, { attempt: 2, failedAttempts: 1 })
    await failed(2)
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(1)
    expect((await state())?.stopped).toBeUndefined()
  })

  it('a site failed followed within 10 minutes by ready for the same attempt ends ready and counts no failure (23-32: only a ready wins)', async () => {
    await failed(1, 'site')
    expect(await state()).toMatchObject({ status: 'failed', failedAttempts: 0, canRetry: false })
    expect(await redis.exists(lockKey)).toBe(1)
    clock += 9 * 60 * 1000
    expect(await callback(1, 'ready', { site_url: 'https://cascadia.localnodes.xyz', source: 'site' })).toEqual({ updated: true })
    expect(await state()).toMatchObject({ status: 'ready', failedAttempts: 0 })
    expect(await handleProvisionStatus(SID, redis, { now: () => clock })).toMatchObject({ status: 'ready', reason: null, canRetry: false })
  })

  it('a site failed becomes final on the first status read after 10 minutes: one failure, lock freed, retry offered', async () => {
    await failed(1, 'site')
    clock += 10 * 60 * 1000 + 1
    expect(await handleProvisionStatus(SID, redis, { now: () => clock })).toMatchObject({ status: 'failed', reason: 'deploy_timeout', canRetry: true })
    expect(await state()).toMatchObject({ failedAttempts: 1 })
    expect(await redis.exists(lockKey)).toBe(0)
    // A ready after the window is too late: the failure stands.
    expect(await callback(1, 'ready', { site_url: 'https://cascadia.localnodes.xyz', source: 'site' })).toEqual({ updated: false })
    expect(await state()).toMatchObject({ status: 'failed' })
  })

  it('a site-only failure on attempt 2 stops the sign-up on the first status read after the window, when the read has the stop wiring', async () => {
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2, 'site')
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled()
    clock += 10 * 60 * 1000 + 1
    const reply = await handleProvisionStatus(SID, redis, { now: () => clock, stripe: () => stripe, mail: deps.mail, teardown: deps.teardown, log: deps.log })
    expect(reply).toMatchObject({ status: 'failed', canRetry: false, stopped: true })
    expect(await state()).toMatchObject({ failedAttempts: 2, stopped: true })
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await redis.zcard(`promo:holds:${PROMO}`)).toBe(0)
  })

  it('a status read without the stop wiring counts the second failure but calls no Stripe or Resend', async () => {
    await failed(1)
    await retryProvisioning(SID, deps)
    await failed(2, 'site')
    clock += 10 * 60 * 1000 + 1
    expect(await handleProvisionStatus(SID, redis, { now: () => clock })).toMatchObject({ status: 'failed', canRetry: false, stopped: false })
    expect(await state()).toMatchObject({ failedAttempts: 2 })
    expect(stripe.setupIntents.retrieve).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a site failed then the workflow failed for the same attempt counts once, and the workflow makes it final at once', async () => {
    await failed(1, 'site')
    await failed(1, 'workflow')
    expect(await state()).toMatchObject({ status: 'failed', failedAttempts: 1, canRetry: true })
    clock += 11 * 60 * 1000
    await handleProvisionStatus(SID, redis, { now: () => clock })
    expect(await state()).toMatchObject({ failedAttempts: 1 })
  })

  it('a dispatch that throws on the first run frees the lock, marks failed with reason unknown, counts one failure and offers the retry', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await redis.del(lockKey, stateKey)
    dispatch.mockRejectedValueOnce(new Error('GitHub dispatch failed (502)'))
    const result = await triggerProvisioning({ id: SID, metadata: { subdomain: 'cascadia', provision_id: PID } }, { redis, dispatchProvisioningWorkflow: dispatch })
    expect(result.alreadyProcessing).toBe(false)
    expect(await redis.exists(lockKey)).toBe(0)
    expect(await state()).toMatchObject({ status: 'failed', reason: 'unknown', failedAttempts: 1, canRetry: true, attempt: 1 })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith('dispatch failed', { sessionId: SID })
    errors.mockRestore()
  })

  it('a Stripe redelivery after a failed dispatch does not dispatch again: only the retry route may', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await redis.del(lockKey, stateKey)
    dispatch.mockRejectedValueOnce(new Error('GitHub dispatch failed (502)'))
    const session = { id: SID, metadata: { subdomain: 'cascadia', provision_id: PID } }
    await triggerProvisioning(session, { redis, dispatchProvisioningWorkflow: dispatch })
    dispatch.mockClear()
    expect(await triggerProvisioning(session, { redis, dispatchProvisioningWorkflow: dispatch })).toEqual({ alreadyProcessing: true })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ status: 'failed', failedAttempts: 1, attempt: 1, canRetry: true })
    expect(await redis.exists(lockKey)).toBe(0)
    errors.mockRestore()
  })

  it('a retry whose dispatch throws counts the second failure and stops', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await failed(1)
    dispatch.mockRejectedValueOnce(new Error('GitHub dispatch failed (502)'))
    const outcome = await retryProvisioning(SID, deps)
    expect(outcome).toEqual({ status: 409, body: { message: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.' } })
    expect(await state()).toMatchObject({ status: 'tearing_down', teardownReason: 'build_failed', reason: 'unknown', failedAttempts: 2, stopped: true, canRetry: false })
    expect(await redis.exists(lockKey)).toBe(0)
    expect(stripe.paymentMethods.detach).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledWith('dispatch failed', { sessionId: SID })
    errors.mockRestore()
  })

  it('the retry route is gated: closed and not invited is a 404; a bad body is a 400; open passes', async () => {
    await failed(1)
    expect(await handleRetryRequest({ session_id: SID }, { ...deps, open: false, invited: false })).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(await handleRetryRequest({ session_id: 'not a session' }, { ...deps, open: false, invited: true })).toMatchObject({ status: 400 })
    expect(await handleRetryRequest({}, { ...deps, open: true, invited: false })).toMatchObject({ status: 400 })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await handleRetryRequest({ session_id: SID }, { ...deps, open: false, invited: true })).toEqual({ status: 200, body: { ok: true } })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('logs carry type names and codes only, never the email', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    fetchMock.mockRejectedValueOnce(new Error(`Resend refused ${EMAIL}`))
    await twoFailures()
    await stopProvision(SID, deps)
    const all = [...logs, ...spies.flatMap(s => s.mock.calls.map(c => JSON.stringify(c)))].join('\n')
    expect(all).not.toContain(EMAIL)
    expect(all).not.toContain('Cascadia Reading Group')
    spies.forEach(s => s.mockRestore())
  })
})
