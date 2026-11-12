import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { handlePilotContinue, sealContinueToken, type PilotContinueDeps } from '../../server/utils/pilot-end'
import {
  LATE_SESSION_SECONDS,
  LATE_YES_SECONDS,
  lateKey,
  lateLockKey,
  markLateRemoval,
  recordLateContinuation,
  type LateSession
} from '../../server/utils/pilot-late'
import { handleStripeWebhook } from '../../server/utils/stripe-webhook'
import { routeInvoiceEvent, type BillingDeps } from '../../server/utils/billing'
import { buildPilotEndMail } from '../../server/utils/mail-copy'
import { FakeRedis } from './helpers/fake-redis'

/**
 * A late yes: the free pilot has already ended. The yes never charges from the
 * server; it opens a Stripe payment page that shows the total, and nothing is
 * charged unless the organizer pays there. Accepted until the site is removed.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const END = sec('2027-02-26T10:00:00Z')
const LATER = END + 5 * 86400
const ORIGIN = 'https://example.test'
const PAGE = 'https://checkout.stripe.com/c/pay/cs_test_a'

function lapsedSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'canceled',
    cancel_at: END,
    ended_at: END,
    customer: 'cus_1',
    metadata: { provision_id: 'pid', subdomain: 'willow', pilot: 'ends', pilot_ends_at: String(END) },
    items: { data: [{ price: { id: 'price_1', unit_amount: 2000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
    ...over
  }
}

function session(over: Partial<LateSession> = {}): LateSession {
  return { id: 'cs_a', status: 'open', payment_status: 'unpaid', url: PAGE, expires_at: LATER + LATE_SESSION_SECONDS, subscription: null, amount_total: 2000, currency: 'usd', metadata: { pilot_continued_from: 'sub_1' }, ...over }
}

function lateDeps(sub: Record<string, unknown>, nowSec = LATER, opts: { redis?: FakeRedis } = {}) {
  const redis = opts.redis ?? new FakeRedis()
  const sessions = new Map<string, LateSession>()
  let n = 0
  const create = vi.fn(async (params: Record<string, unknown>) => {
    n += 1
    const s = session({ id: `cs_${n}`, url: `https://checkout.stripe.com/c/pay/cs_${n}`, expires_at: Number(params.expires_at) })
    sessions.set(s.id, s)
    return s
  })
  const retrieve = vi.fn(async (id: string) => {
    const s = sessions.get(id)
    if (!s) throw Object.assign(new Error('no such session'), { statusCode: 404 })
    return s
  })
  const expire = vi.fn(async (id: string) => {
    const s = sessions.get(id)!
    if (s.status !== 'open') throw Object.assign(new Error('not open'), { statusCode: 400 })
    s.status = 'expired'
    return s
  })
  const update = vi.fn()
  const log = vi.fn()
  const deps: PilotContinueDeps = {
    stripe: { subscriptions: { retrieve: vi.fn(async () => sub), update } },
    secret: SECRET,
    now: () => nowSec * 1000,
    log,
    origin: ORIGIN,
    late: { redis, stripe: { checkout: { sessions: { create, retrieve, expire } } } }
  }
  /** Stripe-side: the organizer pays session `id` on the page. */
  const pay = (id: string) => {
    const s = sessions.get(id)!
    Object.assign(s, { status: 'complete', payment_status: 'paid', subscription: 'sub_new' })
  }
  return { deps, redis, sessions, create, retrieve, expire, update, log, pay }
}

const token = () => sealContinueToken('sub_1', END, SECRET)

describe('a pilot past its free end', () => {
  it('GET answers lapsed with the end date and the price, and opens nothing', async () => {
    const { deps, create, update } = lateDeps(lapsedSub())
    expect(await handlePilotContinue('GET', token(), deps)).toEqual({ status: 200, body: { state: 'lapsed', date: 'February 26, 2027', price: '$20 a month' } })
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('lapsed then yes: POST opens one Stripe payment page and charges nothing itself', async () => {
    const { deps, create, update, redis } = lateDeps(lapsedSub())
    const t = token()
    const out = await handlePilotContinue('POST', t, deps)
    expect(out).toMatchObject({ status: 200, body: { state: 'checkout', url: 'https://checkout.stripe.com/c/pay/cs_1', price: '$20 a month' } })
    // The pilot subscription is never touched: the only way to pay is the page.
    expect(update).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    const [params] = create.mock.calls[0]!
    expect(params).toEqual({
      mode: 'subscription',
      customer: 'cus_1',
      line_items: [{ price: 'price_1', quantity: 1 }],
      payment_method_types: ['card'],
      expires_at: LATER + LATE_SESSION_SECONDS,
      success_url: `${ORIGIN}/pilot/continue?t=${t}&paid=1`,
      cancel_url: `${ORIGIN}/pilot/continue?t=${t}&back=1`,
      metadata: { pilot_continued_from: 'sub_1' },
      subscription_data: { metadata: { pilot: 'continued', pilot_continued_from: 'sub_1', pilot_continued_at: String(LATER), provision_id: 'pid', subdomain: 'willow' } }
    })
    // No discount: the free months are over, and the page shows the full total.
    expect(params).not.toHaveProperty('discounts')
    expect(JSON.parse(redis.raw(lateKey('sub_1'))!)).toMatchObject({ state: 'open', sessionId: 'cs_1' })
    expect(redis.raw(lateLockKey('sub_1'))).toBeUndefined()
  })

  it('lapsed then yes twice: the second yes reuses the open page, never a second one', async () => {
    const { deps, create } = lateDeps(lapsedSub())
    const a = await handlePilotContinue('POST', token(), deps)
    const b = await handlePilotContinue('POST', token(), deps)
    expect(create).toHaveBeenCalledTimes(1)
    expect(b).toEqual(a)
  })

  it('a page close to running out is expired before a new one is opened', async () => {
    const { deps, create, expire, sessions } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    sessions.get('cs_1')!.expires_at = LATER + 60
    const out = await handlePilotContinue('POST', token(), deps)
    expect(expire).toHaveBeenCalledWith('cs_1')
    expect(create).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ body: { state: 'checkout', url: 'https://checkout.stripe.com/c/pay/cs_2' } })
  })

  it('lapsed, page abandoned: no charge, and the page reads lapsed again', async () => {
    const { deps, sessions, update } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    sessions.get('cs_1')!.status = 'expired'
    expect(await handlePilotContinue('GET', token(), deps)).toMatchObject({ status: 200, body: { state: 'lapsed' } })
    expect(update).not.toHaveBeenCalled()
  })

  it('paid on the page: the read records it and shows what was charged and when', async () => {
    const { deps, pay, redis } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    pay('cs_1')
    expect(await handlePilotContinue('GET', token(), deps)).toEqual({
      status: 200,
      body: { state: 'continued', date: 'February 26, 2027', price: '$20 a month', charged: '$20', chargedOn: 'March 3, 2027' }
    })
    expect(JSON.parse(redis.raw(lateKey('sub_1'))!)).toMatchObject({ state: 'continued', newSubscriptionId: 'sub_new', amountPaid: 2000 })
  })

  it('a yes after paying answers continued and opens no new page', async () => {
    const { deps, pay, create } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    pay('cs_1')
    expect(await handlePilotContinue('POST', token(), deps)).toMatchObject({ body: { state: 'continued', charged: '$20' } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('paid in the moment the old page was being expired: recorded, no second page', async () => {
    const { deps, sessions, create, expire, pay } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    sessions.get('cs_1')!.expires_at = LATER + 60
    expire.mockImplementationOnce(async (id: string) => {
      pay(id)
      throw new Error('not open')
    })
    expect(await handlePilotContinue('POST', token(), deps)).toMatchObject({ body: { state: 'continued' } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('complete but not yet paid answers confirming', async () => {
    const { deps, sessions } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    Object.assign(sessions.get('cs_1')!, { status: 'complete', payment_status: 'unpaid' })
    expect(await handlePilotContinue('GET', token(), deps)).toMatchObject({ status: 200, body: { state: 'confirming' } })
  })

  it('site already removed (the removal mark), or past the removal date: ended, no page', async () => {
    const marked = lateDeps(lapsedSub())
    await marked.redis.set(lateKey('sub_1'), JSON.stringify({ state: 'removing', at: LATER }))
    expect(await handlePilotContinue('POST', token(), marked.deps)).toMatchObject({ status: 200, body: { state: 'ended' } })
    expect(marked.create).not.toHaveBeenCalled()

    const late = lateDeps(lapsedSub(), END + LATE_YES_SECONDS)
    expect(await handlePilotContinue('POST', token(), late.deps)).toMatchObject({ status: 200, body: { state: 'ended' } })
    expect(late.create).not.toHaveBeenCalled()
  })

  it('the page never outlives the removal date, and too short a page is not opened', async () => {
    const close = lateDeps(lapsedSub(), END + LATE_YES_SECONDS - 3600)
    await handlePilotContinue('POST', token(), close.deps)
    expect(close.create.mock.calls[0]![0].expires_at).toBe(END + LATE_YES_SECONDS)

    const tooClose = lateDeps(lapsedSub(), END + LATE_YES_SECONDS - 600)
    expect(await handlePilotContinue('POST', token(), tooClose.deps)).toMatchObject({ body: { state: 'ended' } })
    expect(tooClose.create).not.toHaveBeenCalled()
  })

  it('past the end but not yet ended by Stripe: try again shortly (503), nothing opened', async () => {
    const { deps, create } = lateDeps(lapsedSub({ status: 'active' }))
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('a canceled subscription that ended at another time is refused', async () => {
    const { deps } = lateDeps(lapsedSub({ cancel_at: END + 99, ended_at: END + 99 }))
    expect(await handlePilotContinue('GET', token(), deps)).toEqual({ status: 400, body: { state: 'invalid' } })
  })

  it('a canceled subscription that was never a pilot is refused', async () => {
    const { deps } = lateDeps(lapsedSub({ metadata: { provision_id: 'pid' } }))
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 400, body: { state: 'invalid' } })
  })

  it('no price: no page is opened', async () => {
    const { deps, create } = lateDeps(lapsedSub({ items: { data: [{ price: { id: 'price_1', unit_amount: null, currency: 'usd', recurring: null } }] } }))
    expect(await handlePilotContinue('POST', token(), deps)).toMatchObject({ body: { state: 'lapsed', price: '' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('Redis down: 503 and no page', async () => {
    const { deps, redis, create } = lateDeps(lapsedSub())
    vi.spyOn(redis, 'set').mockRejectedValue(new Error('down'))
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('down'))
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(await handlePilotContinue('GET', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('a page whose record could not be written is expired at once', async () => {
    const { deps, redis, expire } = lateDeps(lapsedSub())
    const real = redis.set.bind(redis)
    vi.spyOn(redis, 'set').mockImplementation(async (key, value, opts) => {
      if (key === lateKey('sub_1')) throw new Error('down')
      return real(key, value, opts)
    })
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(expire).toHaveBeenCalledWith('cs_1')
  })

  it('a yes while another is in flight (lock held) is a 503, not a second page', async () => {
    const { deps, redis, create } = lateDeps(lapsedSub())
    await redis.set(lateLockKey('sub_1'), '1', { nx: true, ex: 60 })
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('a payment page off Stripe\'s checkout host is never handed out', async () => {
    const { deps, create, expire } = lateDeps(lapsedSub())
    create.mockResolvedValueOnce(session({ id: 'cs_x', url: 'https://evil.example/pay' }))
    expect(await handlePilotContinue('POST', token(), deps)).toEqual({ status: 503, body: { state: 'unavailable' } })
    expect(expire).toHaveBeenCalledWith('cs_x')
  })

  it('without the late wiring an ended pilot still answers ended', async () => {
    const { deps } = lateDeps(lapsedSub())
    delete deps.late
    expect(await handlePilotContinue('POST', token(), deps)).toMatchObject({ body: { state: 'ended' } })
  })

  it('logs carry fixed words only', async () => {
    const { deps, log, pay } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    pay('cs_1')
    await handlePilotContinue('GET', token(), deps)
    for (const [msg] of log.mock.calls) expect(String(msg)).not.toMatch(/sub_|cs_|cus_|http/)
  })
})

describe('recordLateContinuation', () => {
  const paid = (over: Partial<LateSession> = {}) => session({ status: 'complete', payment_status: 'paid', subscription: 'sub_new', ...over })

  it('ignores a session that is not paid', async () => {
    const redis = new FakeRedis()
    expect(await recordLateContinuation(redis, 'sub_1', session(), LATER, vi.fn())).toBeNull()
    expect(redis.raw(lateKey('sub_1'))).toBeUndefined()
  })

  it('is idempotent for the same session', async () => {
    const redis = new FakeRedis()
    await recordLateContinuation(redis, 'sub_1', paid(), LATER, vi.fn())
    const first = redis.raw(lateKey('sub_1'))
    await recordLateContinuation(redis, 'sub_1', paid(), LATER + 50, vi.fn())
    expect(redis.raw(lateKey('sub_1'))).toBe(first)
  })

  it('a second paid session is flagged for a person, the first kept', async () => {
    const redis = new FakeRedis()
    const log = vi.fn()
    await recordLateContinuation(redis, 'sub_1', paid(), LATER, log)
    await recordLateContinuation(redis, 'sub_1', paid({ id: 'cs_b', subscription: 'sub_other' }), LATER, log)
    expect(JSON.parse(redis.raw(lateKey('sub_1'))!)).toMatchObject({ state: 'continued', sessionId: 'cs_a', newSubscriptionId: 'sub_new', duplicate: 'cs_b' })
    expect(log).toHaveBeenCalledWith('pilot-late: a second paid session for one pilot, refund one by hand')
  })
})

describe('markLateRemoval (before a person removes a lapsed site)', () => {
  it('expires an open page, then marks the site; the link then answers ended', async () => {
    const { deps, redis, expire, sessions, create } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    expect(await markLateRemoval('sub_1', LATER, { ...deps.late!, log: vi.fn() })).toBe('marked')
    expect(expire).toHaveBeenCalledWith('cs_1')
    expect(sessions.get('cs_1')!.status).toBe('expired')
    expect(JSON.parse(redis.raw(lateKey('sub_1'))!)).toMatchObject({ state: 'removing' })
    expect(await handlePilotContinue('POST', token(), deps)).toMatchObject({ body: { state: 'ended' } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('refuses when the page was paid: that site stays', async () => {
    const { deps, pay, redis } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    pay('cs_1')
    expect(await markLateRemoval('sub_1', LATER, { ...deps.late!, log: vi.fn() })).toBe('continued')
    expect(JSON.parse(redis.raw(lateKey('sub_1'))!)).toMatchObject({ state: 'continued' })
  })

  it('refuses while a yes is in flight', async () => {
    const { deps, redis } = lateDeps(lapsedSub())
    await redis.set(lateLockKey('sub_1'), '1', { nx: true, ex: 60 })
    expect(await markLateRemoval('sub_1', LATER, { ...deps.late!, log: vi.fn() })).toBe('busy')
  })

  it('marks a pilot that never said yes', async () => {
    const { deps } = lateDeps(lapsedSub())
    expect(await markLateRemoval('sub_1', LATER, { ...deps.late!, log: vi.fn() })).toBe('marked')
  })
})

describe('the webhook and a late yes\'s payment page', () => {
  const send = (type: string, object: Record<string, unknown>, extra: { open?: boolean, onLateCompleted?: (s: Stripe.Checkout.Session) => Promise<void> } = {}) => {
    const deps = {
      open: extra.open ?? false,
      constructEvent: (body: string) => JSON.parse(body) as Stripe.Event,
      onCheckoutCompleted: vi.fn(async () => {}),
      isInvitedCheckout: vi.fn(async () => 'claimed' as const),
      recordSetup: vi.fn(async () => true),
      releaseHold: vi.fn(async () => {}),
      releaseCapacity: vi.fn(async () => {}),
      onLateCompleted: extra.onLateCompleted ?? vi.fn(async () => {}),
      log: vi.fn()
    }
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object } })
    return { deps, out: handleStripeWebhook(payload, 'sig', deps) }
  }
  const late = { id: 'cs_a', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', metadata: { pilot_continued_from: 'sub_1', invited: 'true', provision_id: 'pid' } }

  it.each([false, true])('a paid page is recorded and nothing is provisioned (launch open: %s)', async (open) => {
    const { deps, out } = send('checkout.session.completed', late, { open })
    expect(await out).toMatchObject({ status: 200 })
    expect(deps.onLateCompleted).toHaveBeenCalledTimes(1)
    expect(deps.onCheckoutCompleted).not.toHaveBeenCalled()
    expect(deps.isInvitedCheckout).not.toHaveBeenCalled()
    expect(deps.recordSetup).not.toHaveBeenCalled()
  })

  it('a recording failure answers 503 so Stripe retries', async () => {
    const { out } = send('checkout.session.completed', late, { onLateCompleted: async () => { throw new Error('down') } })
    expect((await out).status).toBe(503)
  })

  it('an expired page releases nothing that belongs to a sign-up', async () => {
    const { deps, out } = send('checkout.session.expired', { ...late, status: 'expired' })
    expect(await out).toMatchObject({ status: 200 })
    expect(deps.releaseHold).not.toHaveBeenCalled()
    expect(deps.releaseCapacity).not.toHaveBeenCalled()
    expect(deps.onLateCompleted).not.toHaveBeenCalled()
  })

  it('a sign-up session is untouched by the late path', async () => {
    const { deps, out } = send('checkout.session.completed', { id: 'cs_s', object: 'checkout.session', mode: 'setup', customer: 'cus_1', setup_intent: 'seti_1', metadata: { provision_id: 'pid', invited: 'true' } })
    await out
    expect(deps.onLateCompleted).not.toHaveBeenCalled()
    expect(deps.onCheckoutCompleted).toHaveBeenCalledTimes(1)
  })

  it('the paid page\'s first invoice starts nothing; its renewals still go to the card mail', async () => {
    const onRenewalProblem = vi.fn(async () => {})
    const billing = { redis: new FakeRedis(), stripe: () => { throw new Error('no Stripe call expected') }, fetch: vi.fn(), callbackSecret: 's', log: vi.fn() } as unknown as BillingDeps
    const invoice = (reason: string) => ({ id: 'in_1', billing_reason: reason, parent: { subscription_details: { subscription: 'sub_new', metadata: { provision_id: 'p_0123456789abcdef0123', pilot: 'continued', pilot_continued_from: 'sub_1' } } } })
    expect(await routeInvoiceEvent({ type: 'invoice.paid', data: { object: invoice('subscription_create') } }, { ...billing, onRenewalProblem })).toBe('ignored')
    expect(await routeInvoiceEvent({ type: 'invoice.payment_failed', created: LATER, data: { object: invoice('subscription_cycle') } }, { ...billing, onRenewalProblem })).toBe('mailed')
  })
})

describe('the end mail', () => {
  it('says the button still works after the end, through a Stripe page that shows the total', () => {
    const mail = buildPilotEndMail({ date: 'February 26, 2027', price: '$20 a month', link: 'https://localnodes.xyz/pilot/continue?t=x' } as Parameters<typeof buildPilotEndMail>[0])
    expect(mail.text).toContain('If you change your mind after February 26, 2027, the same button still works until we remove the site. It then takes you to a secure Stripe payment page that shows the total, and nothing is charged until you confirm there.')
  })
})

describe('scripts/pilot-removal.mjs', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) } }
  }
  const load = async () => (await import('../../scripts/pilot-removal.mjs')).main as (argv: string[], env: object, io: object, deps?: object) => Promise<number>

  it('marks a lapsed pilot and closes its open payment page', async () => {
    const { deps, redis, sessions } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    const o = io()
    const code = await (await load())(['sub_1aaaaaaaa'], {}, o.io, { ...deps.late, markLateRemoval: async (id: string, now: number, d: Parameters<typeof markLateRemoval>[2]) => markLateRemoval('sub_1', now, d), now: () => LATER * 1000, redis })
    expect(code).toBe(0)
    expect(sessions.get('cs_1')!.status).toBe('expired')
    expect(o.out.join(' ')).toContain('You can remove the site.')
  })

  it('refuses when the organizer paid (exit 3), and refuses a malformed id', async () => {
    const { deps, pay } = lateDeps(lapsedSub())
    await handlePilotContinue('POST', token(), deps)
    pay('cs_1')
    const o = io()
    const main = await load()
    expect(await main(['sub_1aaaaaaaa'], {}, o.io, { ...deps.late, markLateRemoval: async (_id: string, now: number, d: Parameters<typeof markLateRemoval>[2]) => markLateRemoval('sub_1', now, d), now: () => LATER * 1000 })).toBe(3)
    expect(o.err.join(' ')).toContain('Do not remove this site')
    expect(await main(['not-an-id'], {}, io().io, {})).toBe(1)
  })
})
