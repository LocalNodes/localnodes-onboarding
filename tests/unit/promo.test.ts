// Single-use and wave promotion codes (Phase 23, plan 23-15; Tom's decisions
// D-06 and D-09, ONB-04). Stripe is a mock, Redis is a fake: nothing here
// touches a network. A code is looked up in Stripe, refused before checkout
// when it is used, expired, unknown, bound to another invite or held by another
// open checkout, and held in Redis for the checkout's life.
//
// FakeRedis has no Lua engine, so the hold script is registered as a JavaScript
// twin (holdScriptTwin) against the real script text (HOLD_SCRIPT). The Lua
// itself runs first in the 23-22 dry run, not here.
import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { FakeRedis } from './helpers/fake-redis'
import { addInvite, emailKey, inviteKey, type InviteRecord } from '../../server/utils/invites'
import {
  checkCode,
  holdCode,
  HOLD_SCRIPT,
  HOLD_TTL_SECONDS,
  holdScriptTwin,
  PROMO_REFUSED_MESSAGE,
  PROVISIONING_HOLD_SECONDS,
  REARM_SCRIPT,
  rearmHold,
  rearmScriptTwin,
  rearmSessionHold,
  releaseHold,
  releaseSessionHold
} from '../../server/utils/promo'
import { handleCreateCheckout, type CheckoutDeps } from '../../server/utils/checkout'
import { roomyCapacity } from './helpers/capacity'
import { handleCheckCode } from '../../server/utils/check-code'
import { claimInvitedCheckout, handleStripeWebhook, type WebhookDeps } from '../../server/utils/stripe-webhook'

const INVITE_SECRET = 'test-invite-hash-secret'
const WEBHOOK_SECRET = 'whsec_test_secret'
const stripeLib = new Stripe('sk_test_not_used')
const EMAIL = 'invited.person@example.com'
const BODY = { communityName: 'Repair Collective', subdomain: 'repair' }
const PRICE = 'price_test_123'
const ORIGIN = 'https://localnodes.xyz'
const T0 = 1_700_000_000_000

interface PromoRow {
  id: string
  code: string
  active: boolean
  expires_at: number | null
  max_redemptions: number | null
  times_redeemed: number
  metadata?: Record<string, string>
}

const promoRow = (over: Partial<PromoRow> = {}): PromoRow => ({
  id: 'promo_A',
  code: 'PILOT-AAAA',
  active: true,
  expires_at: null,
  max_redemptions: 1,
  times_redeemed: 0,
  ...over
})

/** A Stripe mock whose promotionCodes.list filters like the real one (code, active). */
function mockStripe(rows: PromoRow[]) {
  const list = vi.fn(async (params: { code?: string, active?: boolean, limit?: number }) => ({
    data: rows
      .filter(r => (params.code === undefined || r.code.toLowerCase() === params.code.toLowerCase()) && (params.active === undefined || r.active === params.active))
      .slice(0, params.limit ?? 10)
  }))
  const create = vi.fn(async (_p: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
  return { list, create, stripe: { promotionCodes: { list }, checkout: { sessions: { create } } } }
}

/** FakeRedis with the hold script registered as its JavaScript twin, against the real script text. */
function holdRedis() {
  const redis = new FakeRedis()
  const zsets = new Map<string, Map<string, number>>()
  redis.onEval(HOLD_SCRIPT, (keys, args) => {
    let z = zsets.get(keys[0]!)
    if (!z) zsets.set(keys[0]!, (z = new Map()))
    return holdScriptTwin(z, args)
  })
  redis.onEval(REARM_SCRIPT, (keys, args) => {
    let z = zsets.get(keys[0]!)
    if (!z) zsets.set(keys[0]!, (z = new Map()))
    return rearmScriptTwin(z, args)
  })
  // Release and inspection go through FakeRedis's own zset, so keep the twin's state in step.
  const zrem = redis.zrem.bind(redis)
  redis.zrem = async (key: string, ...members: string[]) => {
    const z = zsets.get(key)
    let n = 0
    for (const m of members) if (z?.delete(m)) n++
    await zrem(key, ...members)
    return n
  }
  const evals = { count: 0 }
  const evalOnce = redis.eval.bind(redis)
  redis.eval = async (script: string, keys: string[], args: unknown[]) => { evals.count++; return evalOnce(script, keys, args) }
  return {
    redis,
    evals,
    holders: (promoId: string) => [...(zsets.get(`promo:holds:${promoId}`)?.keys() ?? [])].sort(),
    /** A hold's expiry score, in seconds, or undefined when there is none. */
    scoreOf: (promoId: string, holder: string) => zsets.get(`promo:holds:${promoId}`)?.get(holder)
  }
}

async function setupInvite(redis: FakeRedis, invite: { promoCodeId?: string, promoCode?: string } = {}, email = EMAIL) {
  const { inviteId } = await addInvite(redis, INVITE_SECRET, { email, kind: 'pilot', wave: 'w1', ...invite })
  const session: InviteRecord = { inviteId, emailHmac: emailKey(INVITE_SECRET, email), email }
  const record = (await redis.hgetall<Record<string, unknown>>(inviteKey(session.emailHmac)))!
  return { inviteId, session, record }
}

describe('checkCode', () => {
  it.each([
    ['a coupon with percent_off 100', { percent_off: 100 }, true],
    ['a coupon with percent_off 50', { percent_off: 50 }, false],
    ['a coupon with amount_off', { amount_off: 500, percent_off: null }, false],
    ['an unexpanded coupon id', 'coupon_123', false],
    ['no promotion at all', undefined, false],
    ['an expanded coupon with its id (23-43 Task 3)', { id: 'coupon_full', percent_off: 100 }, true]
  ] as const)('fullDiscount for %s is %s (23-32: only a 100%-off coupon counts)', async (_label, coupon, full) => {
    const { redis } = holdRedis()
    const row = { ...promoRow(), ...(coupon === undefined ? {} : { promotion: { type: 'coupon', coupon } }) }
    const { stripe } = mockStripe([row as PromoRow])
    const r = await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, { stripe, redis, now: () => T0 })
    // couponId (23-43 Task 3, D3): the coupon's id, expanded or not; empty when unknown.
    const couponId = typeof coupon === 'string' ? coupon : coupon && 'id' in coupon ? coupon.id : ''
    expect(r).toEqual({ ok: true, promoId: 'promo_A', fullDiscount: full, couponId })
  })

  it('accepts an active single-use code and holds it for the holder', async () => {
    const { redis, holders } = holdRedis()
    const { stripe, list } = mockStripe([promoRow()])
    const r = await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, { stripe, redis, now: () => T0 })
    expect(r).toEqual({ ok: true, promoId: 'promo_A', fullDiscount: false, couponId: '' })
    expect(holders('promo_A')).toEqual(['inv_1'])
    // 23-32: the coupon is expanded so the paid-sign-up gate can tell a 100%-off code.
    expect(list).toHaveBeenCalledWith({ code: 'PILOT-AAAA', active: true, limit: 1, expand: ['data.promotion.coupon'] })
  })

  it('refuses the same code for another holder while the first hold lives', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([promoRow()])
    const deps = { stripe, redis, now: () => T0 }
    await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps)
    const r = await checkCode({ code: 'PILOT-AAAA', holder: 'inv_2', invite: null }, deps)
    expect(r).toEqual({ ok: false })
    expect(holders('promo_A')).toEqual(['inv_1'])
  })

  it('the same holder checking again is a refresh, not a second hold, and succeeds on a max 1 code', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([promoRow()])
    const deps = { stripe, redis, now: () => T0 }
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps)).ok).toBe(true)
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps)).ok).toBe(true)
    expect(holders('promo_A')).toEqual(['inv_1'])
  })

  it('refuses a code at max_redemptions, an expired code, an inactive code and an unknown code, and holds nothing', async () => {
    const cases: Array<[string, PromoRow[]]> = [
      ['used up', [promoRow({ times_redeemed: 1 })]],
      ['over-redeemed (a negative number left must not read as no limit)', [promoRow({ times_redeemed: 2 })]],
      ['expired', [promoRow({ expires_at: Math.floor(T0 / 1000) - 5 })]],
      ['inactive', [promoRow({ active: false })]],
      ['unknown', []]
    ]
    for (const [name, rows] of cases) {
      const { redis, holders, evals } = holdRedis()
      const { stripe } = mockStripe(rows)
      const r = await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, { stripe, redis, now: () => T0 })
      expect(r, name).toEqual({ ok: false })
      expect(holders('promo_A'), name).toEqual([])
      expect(evals.count, `${name}: refused before any hold is tried`).toBe(0)
    }
  })

  it('refuses a code Stripe returns as inactive even if the list filter did not drop it', async () => {
    const { redis } = holdRedis()
    const { stripe } = mockStripe([])
    stripe.promotionCodes.list = vi.fn(async () => ({ data: [promoRow({ active: false })] }))
    const r = await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, { stripe, redis, now: () => T0 })
    expect(r).toEqual({ ok: false })
  })

  it('a pilot invite bound to promo A refuses promo B', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([promoRow(), promoRow({ id: 'promo_B', code: 'PILOT-BBBB' })])
    const { record, inviteId } = await setupInvite(redis, { promoCodeId: 'promo_A', promoCode: 'PILOT-AAAA' })
    const deps = { stripe, redis, now: () => T0 }
    const wrong = await checkCode({ code: 'PILOT-BBBB', holder: inviteId, invite: record }, deps)
    expect(wrong).toEqual({ ok: false })
    expect(holders('promo_B')).toEqual([])
    const right = await checkCode({ code: 'PILOT-AAAA', holder: inviteId, invite: record }, deps)
    expect(right).toEqual({ ok: true, promoId: 'promo_A', fullDiscount: false, couponId: '' })
  })

  it('a code Stripe tags with another invite id is refused even when the invite carries no code id', async () => {
    const { redis } = holdRedis()
    const { stripe } = mockStripe([promoRow({ metadata: { invite_id: 'someone-elses-invite' } })])
    const { record, inviteId } = await setupInvite(redis)
    const r = await checkCode({ code: 'PILOT-AAAA', holder: inviteId, invite: record }, { stripe, redis, now: () => T0 })
    expect(r).toEqual({ ok: false })
  })

  it('two different holders at once for a code with one use left: exactly one wins', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([promoRow()])
    const deps = { stripe, redis, now: () => T0 }
    const results = await Promise.all([
      checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps),
      checkCode({ code: 'PILOT-AAAA', holder: 'inv_2', invite: null }, deps)
    ])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(results.filter(r => !r.ok)).toHaveLength(1)
    expect(holders('promo_A')).toHaveLength(1)
  })

  it('a hold is released by releaseHold and the code is accepted again', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([promoRow()])
    const deps = { stripe, redis, now: () => T0 }
    await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps)
    await releaseHold(redis, 'promo_A', 'inv_1')
    expect(holders('promo_A')).toEqual([])
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_2', invite: null }, deps)).ok).toBe(true)
  })

  it('holdCode scores a hold HOLD_TTL_SECONDS ahead', async () => {
    const seen: unknown[][] = []
    const redis = new FakeRedis()
    redis.onEval(HOLD_SCRIPT, (_keys, args) => { seen.push(args); return 1 })
    await holdCode(redis, 'promo_A', 'inv_1', 1, T0)
    expect(HOLD_TTL_SECONDS).toBe(1860)
    expect(seen[0]![1]).toBe(Math.floor(T0 / 1000) + 1860)
  })
})

describe('rearmHold (T-3: a completed setup session owns its use through the build)', () => {
  it('the provisioning window is 7800 s: the 1 hour lock, one retry hour, 10 minutes', () => {
    expect(PROVISIONING_HOLD_SECONDS).toBe(3600 + 3600 + 600)
  })

  it('sets the holder\'s score to now + 7800 s, replacing the 1860 s one', async () => {
    const { redis, scoreOf } = holdRedis()
    await holdCode(redis, 'promo_A', 'inv_1', 1, T0)
    expect(scoreOf('promo_A', 'inv_1')).toBe(T0 / 1000 + HOLD_TTL_SECONDS)
    await rearmHold(redis, 'promo_A', 'inv_1', T0)
    expect(scoreOf('promo_A', 'inv_1')).toBe(T0 / 1000 + 7800)
  })

  it('makes the hold again when it had lapsed, and does not count against what is left', async () => {
    const { redis, holders, scoreOf } = holdRedis()
    await rearmHold(redis, 'promo_A', 'inv_1', T0)
    expect(holders('promo_A')).toEqual(['inv_1'])
    expect(scoreOf('promo_A', 'inv_1')).toBe(T0 / 1000 + 7800)
  })

  it('a second holder is refused the last use while the re-armed hold lives, and accepted after 7800 s', async () => {
    const { redis } = holdRedis()
    await holdCode(redis, 'promo_A', 'inv_1', 1, T0)
    await rearmHold(redis, 'promo_A', 'inv_1', T0)
    expect(await holdCode(redis, 'promo_A', 'inv_2', 1, T0 + 1861 * 1000)).toBe(false)
    expect(await holdCode(redis, 'promo_A', 'inv_2', 1, T0 + 7799 * 1000)).toBe(false)
    expect(await holdCode(redis, 'promo_A', 'inv_2', 1, T0 + 7801 * 1000)).toBe(true)
  })

  it('takes an optional seconds argument (23-32: a 3DS hold lasts until heldUntil); 7800 s stays the default', async () => {
    const { redis, scoreOf } = holdRedis()
    const args: unknown[][] = []
    const evalReal = redis.eval.bind(redis)
    redis.eval = async (script: string, keys: string[], a: unknown[]) => {
      args.push(a)
      return evalReal(script, keys, a)
    }
    await rearmHold(redis, 'promo_A', 'inv_1', T0, 50000)
    expect(scoreOf('promo_A', 'inv_1')).toBe(T0 / 1000 + 50000)
    expect(args.at(-1)).toEqual([T0 / 1000 + 50000, 'inv_1', 50000])
    await rearmHold(redis, 'promo_A', 'inv_1', T0)
    expect(args.at(-1)).toEqual([T0 / 1000 + 7800, 'inv_1', 7800])
  })

  it('both scripts only ever lengthen the key life (a later holder must not cut a re-armed hold short)', () => {
    for (const script of [HOLD_SCRIPT, REARM_SCRIPT]) {
      expect(script).toMatch(/redis\.call\('TTL', KEYS\[1\]\)/)
      expect(script).toMatch(/if ttl < tonumber\(ARGV\[\d\]\) then redis\.call\('EXPIRE'/)
    }
  })

  it('rearmSessionHold reads promo_id and invite_id from the metadata and does nothing without both', async () => {
    const { redis, holders, scoreOf } = holdRedis()
    await rearmSessionHold(redis, { metadata: { promo_id: 'promo_A' } } as unknown as Stripe.Checkout.Session, () => T0)
    await rearmSessionHold(redis, { metadata: null } as unknown as Stripe.Checkout.Session, () => T0)
    expect(holders('promo_A')).toEqual([])
    await rearmSessionHold(redis, { metadata: { promo_id: 'promo_A', invite_id: 'inv_1' } } as unknown as Stripe.Checkout.Session, () => T0)
    expect(scoreOf('promo_A', 'inv_1')).toBe(T0 / 1000 + 7800)
  })
})

async function checkoutSetup(rows: PromoRow[], invite: { promoCodeId?: string, promoCode?: string } = {}, over: Partial<CheckoutDeps> = {}) {
  const { redis, holders } = holdRedis()
  const { stripe, create, list } = mockStripe(rows)
  const { inviteId, session, record } = await setupInvite(redis, invite)
  const logs: string[] = []
  const deps: CheckoutDeps = {
    open: false,
    session,
    stripe,
    redis,
    priceId: PRICE, paidSignupsEnabled: true,
    currency: 'usd',
    origin: ORIGIN,
    newProvisionId: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    now: () => T0,
    log: (m: string) => { logs.push(m) },
    capacity: roomyCapacity(),
    ...over
  }
  const params = () => create.mock.calls[0]![0] as Record<string, any>
  return { redis, holders, stripe, create, list, inviteId, session, record, logs, deps, params }
}

describe('create-checkout with a code', () => {
  it('check-code then create-checkout for the same invited session succeeds on a max 1 code', async () => {
    const { redis, stripe, inviteId, deps, create, holders } = await checkoutSetup([promoRow()])
    const first = await checkCode({ code: 'PILOT-AAAA', holder: inviteId, invite: null }, { stripe, redis, now: () => T0 })
    expect(first.ok).toBe(true)
    const r = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)
    expect(r.status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
    expect(holders('promo_A')).toEqual([inviteId])
  })

  it('a coded checkout is in setup mode with promo_id in metadata and the signup record, and no discounts, no card-collection setting and no allow_promotion_codes', async () => {
    const { deps, params, inviteId, redis } = await checkoutSetup([promoRow()])
    const r = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)
    expect(r).toEqual({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay_1' } })
    const p = params()
    expect(p.mode).toBe('setup')
    for (const k of ['discounts', 'payment_method_collection', 'line_items', 'subscription_data', 'allow_promotion_codes']) expect(Object.keys(p), k).not.toContain(k)
    expect(p.metadata).toMatchObject({ invited: 'true', invite_id: inviteId, promo_id: 'promo_A' })
    expect(p.setup_intent_data.metadata).toEqual(p.metadata)
    expect(JSON.stringify(p)).not.toContain('PILOT-AAAA')
    expect(JSON.stringify(p.metadata)).not.toContain('@')
    const rec = await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')
    expect(rec?.promoId).toBe('promo_A')
  })

  it('ends the Stripe session inside the hold: expires_at is 30 minutes and a little more, under the hold lifetime', async () => {
    const { deps, params } = await checkoutSetup([promoRow()])
    await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)
    const expiresAt = params().expires_at as number
    expect(Number.isInteger(expiresAt)).toBe(true)
    expect(expiresAt - Math.floor(T0 / 1000)).toBeGreaterThanOrEqual(1800)
    expect(expiresAt - Math.floor(T0 / 1000)).toBeLessThan(HOLD_TTL_SECONDS)
  })

  it('without a code the session has no expires_at and no promo_id, and the signup record no promoId', async () => {
    const { deps, params, list, holders, redis } = await checkoutSetup([promoRow()])
    await handleCreateCheckout(BODY, deps)
    const p = params()
    for (const k of ['discounts', 'payment_method_collection', 'expires_at', 'allow_promotion_codes']) expect(p).not.toHaveProperty(k)
    expect(await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')).not.toHaveProperty('promoId')
    expect(p.metadata).not.toHaveProperty('promo_id')
    expect(list).not.toHaveBeenCalled()
    expect(holders('promo_A')).toEqual([])
  })

  it('a blank code counts as no code', async () => {
    const { deps, params, list } = await checkoutSetup([promoRow()])
    await handleCreateCheckout({ ...BODY, code: '   ' }, deps)
    expect(params()).not.toHaveProperty('discounts')
    expect(list).not.toHaveBeenCalled()
  })

  it('refuses a used code with 409 and the one message; Stripe is not called, no signup record is written, nothing is logged about the code', async () => {
    const { deps, create, redis, logs, inviteId } = await checkoutSetup([promoRow({ times_redeemed: 1 })])
    const r = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)
    expect(r).toEqual({ status: 409, body: { message: PROMO_REFUSED_MESSAGE } })
    expect(PROMO_REFUSED_MESSAGE).toBe('This code has already been used. Ask whoever gave it to you for a new one.')
    expect(create).not.toHaveBeenCalled()
    expect(redis.keys().filter(k => k.startsWith('signup:'))).toEqual([])
    const all = logs.join('\n')
    expect(all).not.toContain('PILOT-AAAA')
    expect(all).not.toContain(inviteId)
    expect(all).not.toContain(EMAIL)
  })

  it('refuses a code another invite holds, and a code bound to another invite', async () => {
    const held = await checkoutSetup([promoRow({ max_redemptions: 1 })])
    await holdCode(held.redis, 'promo_A', 'another-invite', 1, T0)
    const r1 = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, held.deps)
    expect(r1.status).toBe(409)
    expect(held.create).not.toHaveBeenCalled()
    const bound = await checkoutSetup([promoRow(), promoRow({ id: 'promo_B', code: 'PILOT-BBBB' })], { promoCodeId: 'promo_B', promoCode: 'PILOT-BBBB' })
    const r2 = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, bound.deps)
    expect(r2.status).toBe(409)
    expect(bound.create).not.toHaveBeenCalled()
  })

  it('releases the hold when Stripe fails or gives no URL', async () => {
    const noUrl = await checkoutSetup([promoRow()])
    noUrl.create.mockResolvedValueOnce({ url: null })
    expect((await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, noUrl.deps)).status).toBe(500)
    expect(noUrl.holders('promo_A')).toEqual([])
    const boom = await checkoutSetup([promoRow()])
    boom.create.mockRejectedValueOnce(new Error('stripe down'))
    await expect(handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, boom.deps)).rejects.toThrow('stripe down')
    expect(boom.holders('promo_A')).toEqual([])
  })

  it('a code in the body of the open public flow (no invited session) changes nothing', async () => {
    const { deps, params, list } = await checkoutSetup([promoRow()], {}, { open: true, session: null })
    const r = await handleCreateCheckout({ ...BODY, email: 'someone@example.com', code: 'PILOT-AAAA' }, deps)
    expect(r.status).toBe(200)
    expect(params()).not.toHaveProperty('discounts')
    expect(list).not.toHaveBeenCalled()
  })
})

// --- webhook ---------------------------------------------------------------

interface EventOpts {
  metadata?: Record<string, string>
  paymentStatus?: string
  type?: string
  sessionId?: string
}

function makeEvent(inviteId: string, o: EventOpts = {}) {
  const session = {
    id: o.sessionId ?? 'cs_test_1',
    object: 'checkout.session',
    payment_status: o.paymentStatus ?? 'no_payment_required',
    customer_email: EMAIL,
    customer_details: { email: EMAIL },
    // A setup-mode session carries no discounts: the code is applied when the subscription starts (23-32).
    customer: 'cus_test_1',
    setup_intent: 'seti_test_1',
    metadata: o.metadata ?? { invited: 'true', invite_id: inviteId, provision_id: 'AAAAAAAAAAAAAAAAAAAAAA', subdomain: 'repair', communityName: 'Repair Collective', promo_id: 'promo_A' },
  }
  const payload = JSON.stringify({ id: 'evt_test_1', object: 'event', type: o.type ?? 'checkout.session.completed', data: { object: session } })
  return { payload, sig: stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }) }
}

async function webhookSetup(open: boolean) {
  const { redis, holders, scoreOf } = holdRedis()
  const { inviteId } = await setupInvite(redis, { promoCodeId: 'promo_A', promoCode: 'PILOT-AAAA' })
  const logs: string[] = []
  const onCheckoutCompleted = vi.fn(async (_s: Stripe.Checkout.Session) => {})
  const releaseHookFn = vi.fn(async (s: Stripe.Checkout.Session) => { await releaseSessionHold(redis, s) })
  const rearmHookFn = vi.fn(async (s: Stripe.Checkout.Session) => { await rearmSessionHold(redis, s, () => T0) })
  const deps: WebhookDeps = {
    open,
    constructEvent: (body, sig) => stripeLib.webhooks.constructEvent(body, sig, WEBHOOK_SECRET),
    onCheckoutCompleted,
    isInvitedCheckout: s => claimInvitedCheckout(redis, INVITE_SECRET, s),
    releaseHold: releaseHookFn,
    rearmHold: rearmHookFn,
    log: (m: string) => { logs.push(m) }
  }
  return { redis, holders, scoreOf, inviteId, logs, deps, onCheckoutCompleted, releaseHookFn, rearmHookFn }
}

describe('stripe webhook with a promo', () => {
  it('a completed coded setup session with no discounts on it provisions (open)', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await webhookSetup(true)
    const { payload, sig } = makeEvent(inviteId, { paymentStatus: 'no_payment_required' })
    expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
  })

  it('provisions the same with payment_status unpaid or paid: nothing branches on it', async () => {
    for (const paymentStatus of ['paid', 'unpaid', 'no_payment_required']) {
      const { inviteId, deps, onCheckoutCompleted } = await webhookSetup(true)
      const { payload, sig } = makeEvent(inviteId, { paymentStatus })
      await handleStripeWebhook(payload, sig, deps)
      expect(onCheckoutCompleted, paymentStatus).toHaveBeenCalledTimes(1)
    }
  })

  it('a completed coded session provisions with no discounts on it, open and closed (the discount check is gone)', async () => {
    for (const open of [true, false]) {
      const { inviteId, deps, onCheckoutCompleted, logs } = await webhookSetup(open)
      const { payload, sig } = makeEvent(inviteId)
      expect(JSON.parse(payload).data.object).not.toHaveProperty('discounts')
      expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
      expect(onCheckoutCompleted, String(open)).toHaveBeenCalledTimes(1)
      expect(logs.join('\n')).not.toContain(inviteId)
    }
  })

  it('closed: a coded session claims the invite and provisions', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted } = await webhookSetup(false)
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(await redis.get(`invite:u:${inviteId}`)).toBe('cs_test_1')
  })

  it('a completed session with no promo_id in its metadata provisions and re-arms nothing', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await webhookSetup(true)
    const { payload, sig } = makeEvent(inviteId, { metadata: { subdomain: 'repair' } })
    await handleStripeWebhook(payload, sig, deps)
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
  })

  it('checkout.session.expired releases the hold, open or closed, and provisions nothing', async () => {
    for (const open of [true, false]) {
      const { redis, holders, inviteId, deps, onCheckoutCompleted } = await webhookSetup(open)
      await holdCode(redis, 'promo_A', inviteId, 1, T0)
      expect(holders('promo_A')).toEqual([inviteId])
      const { payload, sig } = makeEvent(inviteId, { type: 'checkout.session.expired' })
      expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
      expect(holders('promo_A')).toEqual([])
      expect(onCheckoutCompleted).not.toHaveBeenCalled()
    }
  })

  it('an expired event with a bad signature releases nothing', async () => {
    const { redis, holders, inviteId, deps, releaseHookFn } = await webhookSetup(true)
    await holdCode(redis, 'promo_A', inviteId, 1, T0)
    const { payload } = makeEvent(inviteId, { type: 'checkout.session.expired' })
    const r = await handleStripeWebhook(payload, 't=1,v1=bad', deps)
    expect(r.status).toBe(400)
    expect(releaseHookFn).not.toHaveBeenCalled()
    expect(holders('promo_A')).toEqual([inviteId])
  })

  it('an expired event whose release fails still answers 200', async () => {
    const { inviteId, deps, logs } = await webhookSetup(true)
    deps.releaseHold = vi.fn(async () => { throw new Error('redis down') })
    const { payload, sig } = makeEvent(inviteId, { type: 'checkout.session.expired' })
    expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    expect(logs.join('\n')).not.toContain(inviteId)
  })

  it('releaseSessionHold reads promo_id and invite_id from the metadata and does nothing without them', async () => {
    const { redis, holders } = holdRedis()
    await holdCode(redis, 'promo_A', 'inv_1', 1, T0)
    await releaseSessionHold(redis, { metadata: { promo_id: 'promo_A' } } as unknown as Stripe.Checkout.Session)
    await releaseSessionHold(redis, { metadata: null } as unknown as Stripe.Checkout.Session)
    expect(holders('promo_A')).toEqual(['inv_1'])
    await releaseSessionHold(redis, { metadata: { promo_id: 'promo_A', invite_id: 'inv_1' } } as unknown as Stripe.Checkout.Session)
    expect(holders('promo_A')).toEqual([])
  })
})

describe('the tracer: code check, hold, setup-mode checkout, completed event, provisioning; the same code again is refused', () => {
  it('a pilot code works once end to end and is refused on the second try, before checkout and before any build', async () => {
    const { redis, holders } = holdRedis()
    const rows = [promoRow()]
    const { stripe, create } = mockStripe(rows)
    const { inviteId, session, record } = await setupInvite(redis, { promoCodeId: 'promo_A', promoCode: 'PILOT-AAAA' })
    const dispatched = vi.fn(async (_s: Stripe.Checkout.Session) => {})

    // 1. the form checks the code
    const checked = await checkCode({ code: 'PILOT-AAAA', holder: inviteId, invite: record }, { stripe, redis, now: () => T0 })
    expect(checked).toEqual({ ok: true, promoId: 'promo_A', fullDiscount: false, couponId: '' })

    // 2. create-checkout re-checks and sends the discount
    const deps: CheckoutDeps = { open: false, session, stripe, redis, priceId: PRICE, paidSignupsEnabled: true, currency: 'usd', origin: ORIGIN, now: () => T0, newProvisionId: () => 'AAAAAAAAAAAAAAAAAAAAAA', capacity: roomyCapacity() }
    expect((await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)).status).toBe(200)
    const sent = create.mock.calls[0]![0] as Record<string, any>
    expect(sent.mode).toBe('setup')
    expect(sent.metadata.promo_id).toBe('promo_A')

    // 3. Stripe completes the setup session (no discount on it); the webhook provisions
    const { payload, sig } = makeEvent(inviteId, { metadata: sent.metadata })
    const webhookDeps: WebhookDeps = {
      open: false,
      constructEvent: (b, s) => stripeLib.webhooks.constructEvent(b, s, WEBHOOK_SECRET),
      onCheckoutCompleted: dispatched,
      isInvitedCheckout: s => claimInvitedCheckout(redis, INVITE_SECRET, s),
      releaseHold: s => releaseSessionHold(redis, s),
      rearmHold: s => rearmSessionHold(redis, s, () => T0),
      log: () => {}
    }
    await handleStripeWebhook(payload, sig, webhookDeps)
    expect(dispatched).toHaveBeenCalledTimes(1)
    // The build is under way: the code stays held, so a second holder cannot take the use.
    expect(holders('promo_A')).toEqual([inviteId])
    // 23-32 starts the subscription later and Stripe then counts the redemption.
    rows[0]!.times_redeemed = 1
    rows[0]!.active = false

    // 4. the same code again, from a second invited person: refused by Stripe's counter,
    // before checkout and before any build. (The first invite is itself used now.)
    const second = await setupInvite(redis, {}, 'second.person@example.org')
    create.mockClear()
    const again = await handleCreateCheckout({ ...BODY, subdomain: 'repair-two', code: 'PILOT-AAAA' }, { ...deps, session: second.session })
    expect(again).toEqual({ status: 409, body: { message: PROMO_REFUSED_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
    expect(dispatched).toHaveBeenCalledTimes(1)
    expect(holders('promo_A')).not.toContain(second.inviteId)
  })
})

// --- POST /api/check-code ----------------------------------------------------

describe('check-code', () => {
  async function codeSetup(rows: PromoRow[] = [promoRow()], invite: { promoCodeId?: string, promoCode?: string } = {}) {
    const { redis, holders } = holdRedis()
    const { stripe, list } = mockStripe(rows)
    const { inviteId, session } = await setupInvite(redis, invite)
    const logs: string[] = []
    const deps = { session: session as InviteRecord | null, stripe, redis, now: () => T0, log: (m: string) => { logs.push(m) } }
    return { redis, holders, list, inviteId, session, logs, deps }
  }

  it('answers 404 without an invited session and asks Stripe nothing', async () => {
    const { deps, list } = await codeSetup()
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, { ...deps, session: null })).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, { ...deps, session: { ...deps.session!, email: '' } })).toMatchObject({ status: 404 })
    expect(list).not.toHaveBeenCalled()
  })

  it('answers 404 when the session names an invite that is gone or is another invite', async () => {
    const gone = await codeSetup()
    await gone.redis.del(inviteKey(gone.session.emailHmac))
    expect((await handleCheckCode({ code: 'PILOT-AAAA' }, gone.deps)).status).toBe(404)
    const other = await codeSetup()
    expect((await handleCheckCode({ code: 'PILOT-AAAA' }, { ...other.deps, session: { ...other.session, inviteId: 'another-invite' } })).status).toBe(404)
    expect(other.list).not.toHaveBeenCalled()
  })

  it('answers 400 for a body without a usable code and asks Stripe nothing', async () => {
    const { deps, list } = await codeSetup()
    for (const bad of [{}, { code: '' }, { code: '   ' }, { code: 5 }, { code: 'x'.repeat(65) }, null, 'text']) {
      expect((await handleCheckCode(bad, deps)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(list).not.toHaveBeenCalled()
  })

  it('accepts a good code with ok true and nothing else, and holds it for the invite', async () => {
    const { deps, holders, inviteId } = await codeSetup()
    const r = await handleCheckCode({ code: ' PILOT-AAAA ' }, deps)
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(holders('promo_A')).toEqual([inviteId])
  })

  it('every refusal is a 409 with the one message', async () => {
    const cases: Array<[string, PromoRow[], { promoCodeId?: string }]> = [
      ['used', [promoRow({ times_redeemed: 1 })], {}],
      ['expired', [promoRow({ expires_at: Math.floor(T0 / 1000) - 5 })], {}],
      ['unknown', [], {}],
      ['bound elsewhere', [promoRow()], { promoCodeId: 'promo_Z' }]
    ]
    for (const [name, rows, invite] of cases) {
      const { deps, holders } = await codeSetup(rows, invite)
      expect(await handleCheckCode({ code: 'PILOT-AAAA' }, deps), name).toEqual({ status: 409, body: { ok: false, message: PROMO_REFUSED_MESSAGE } })
      expect(holders('promo_A'), name).toEqual([])
    }
  })

  it('a code another invite holds is refused', async () => {
    const { deps, redis } = await codeSetup()
    await holdCode(redis, 'promo_A', 'another-invite', 1, T0)
    expect((await handleCheckCode({ code: 'PILOT-AAAA' }, deps)).status).toBe(409)
  })

  it('a Stripe or Redis failure is a 503 that does not call the code used, and logs no code, invite id or address', async () => {
    const { deps, inviteId, list, logs } = await codeSetup()
    list.mockRejectedValueOnce(new Error('stripe down for PILOT-AAAA'))
    const r = await handleCheckCode({ code: 'PILOT-AAAA' }, deps)
    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).not.toContain('PILOT-AAAA')
    expect(JSON.stringify(r.body)).not.toContain(PROMO_REFUSED_MESSAGE)
    const all = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    for (const secret of ['PILOT-AAAA', inviteId, EMAIL]) expect(all).not.toContain(secret)
  })

  it('no refusal log holds the code, the invite id or the address', async () => {
    const { deps, inviteId, logs } = await codeSetup([promoRow({ times_redeemed: 1 })])
    await handleCheckCode({ code: 'PILOT-AAAA' }, deps)
    await handleCheckCode({ code: 'PILOT-AAAA' }, { ...deps, session: null })
    const all = logs.join('\n')
    for (const secret of ['PILOT-AAAA', inviteId, EMAIL]) expect(all).not.toContain(secret)
  })
})

// --- Task 2: wave codes, expiry release, the never-dispatched proof -----------

describe('wave codes (D-09)', () => {
  const wave = (over: Partial<PromoRow> = {}) => promoRow({ id: 'promo_W', code: 'WAVE-ONE', max_redemptions: 5, times_redeemed: 3, ...over })

  it('a code with max 5, 3 redeemed and one live hold takes one more checkout and refuses the next', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([wave()])
    const deps = { stripe, redis, now: () => T0 }
    expect((await checkCode({ code: 'WAVE-ONE', holder: 'inv_1', invite: null }, deps)).ok).toBe(true)
    expect((await checkCode({ code: 'WAVE-ONE', holder: 'inv_2', invite: null }, deps)).ok).toBe(true)
    expect(await checkCode({ code: 'WAVE-ONE', holder: 'inv_3', invite: null }, deps)).toEqual({ ok: false })
    expect(holders('promo_W')).toEqual(['inv_1', 'inv_2'])
  })

  it('a code with no max_redemptions takes any number of checkouts', async () => {
    const { redis, holders } = holdRedis()
    const { stripe } = mockStripe([wave({ max_redemptions: null, times_redeemed: 40 })])
    const deps = { stripe, redis, now: () => T0 }
    for (let i = 0; i < 25; i++) expect((await checkCode({ code: 'WAVE-ONE', holder: `inv_${i}`, invite: null }, deps)).ok).toBe(true)
    expect(holders('promo_W')).toHaveLength(25)
  })

  it('one wave code works for every invite in the wave up to its own limit, each checking out and completing in turn; the held builds keep the sixth out', async () => {
    const { redis, holders } = holdRedis()
    const rows = [wave({ times_redeemed: 0 })]
    const { stripe, create } = mockStripe(rows)
    const dispatched = vi.fn(async (_s: Stripe.Checkout.Session) => {})
    const webhookDeps: WebhookDeps = {
      open: false,
      constructEvent: (b, s) => stripeLib.webhooks.constructEvent(b, s, WEBHOOK_SECRET),
      onCheckoutCompleted: dispatched,
      isInvitedCheckout: s => claimInvitedCheckout(redis, INVITE_SECRET, s),
      rearmHold: s => rearmSessionHold(redis, s, () => T0),
      log: () => {}
    }
    const inviteIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const email = `member.${i}@example.org`
      const { session } = await setupInvite(redis, {}, email)
      inviteIds.push(session.inviteId)
      const deps: CheckoutDeps = { open: false, session, stripe, redis, priceId: PRICE, paidSignupsEnabled: true, currency: 'usd', origin: ORIGIN, now: () => T0, newProvisionId: () => `P${i}`.padEnd(22, 'x'), capacity: roomyCapacity() }
      const r = await handleCreateCheckout({ communityName: `Community ${i}`, subdomain: `site-${i}`, code: 'WAVE-ONE' }, deps)
      expect(r.status, `invite ${i}`).toBe(200)
      const sent = create.mock.calls[i]![0] as Record<string, any>
      const session2 = {
        id: `cs_${i}`, object: 'checkout.session', payment_status: 'no_payment_required', customer_email: email, customer_details: { email },
        customer: `cus_${i}`, setup_intent: `seti_${i}`, metadata: sent.metadata
      }
      const payload = JSON.stringify({ id: `evt_${i}`, object: 'event', type: 'checkout.session.completed', data: { object: session2 } })
      await handleStripeWebhook(payload, stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }), webhookDeps)
      // No redemption yet: Stripe counts it when 23-32 starts the subscription. The holds are what count now.
    }
    expect(dispatched).toHaveBeenCalledTimes(5)
    expect(holders('promo_W')).toEqual([...inviteIds].sort())
    // The sixth is over the limit: five builds hold the five uses left.
    const sixth = await setupInvite(redis, {}, 'member.5@example.org')
    const deps: CheckoutDeps = { open: false, session: sixth.session, stripe, redis, priceId: PRICE, paidSignupsEnabled: true, currency: 'usd', origin: ORIGIN, now: () => T0, capacity: roomyCapacity() }
    expect((await handleCreateCheckout({ communityName: 'Community 5', subdomain: 'site-5', code: 'WAVE-ONE' }, deps)).status).toBe(409)
  })
})

describe('holds do not leak', () => {
  it('checkout.session.expired for a held session releases it and the code is accepted again', async () => {
    const { stripe, create } = mockStripe([promoRow()])
    const { redis, holders } = holdRedis()
    const a = await setupInvite(redis, {}, 'first.person@example.org')
    const b = await setupInvite(redis, {}, 'second.person@example.org')
    const mk = (session: InviteRecord): CheckoutDeps => ({ open: false, session, stripe, redis, priceId: PRICE, paidSignupsEnabled: true, currency: 'usd', origin: ORIGIN, now: () => T0, capacity: roomyCapacity() })
    expect((await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, mk(a.session))).status).toBe(200)
    expect((await handleCreateCheckout({ ...BODY, subdomain: 'repair-two', code: 'PILOT-AAAA' }, mk(b.session))).status).toBe(409)
    const sent = create.mock.calls[0]![0] as Record<string, any>
    const session = { id: 'cs_1', object: 'checkout.session', metadata: sent.metadata, discounts: [{ promotion_code: 'promo_A' }] }
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'checkout.session.expired', data: { object: session } })
    const sig = stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
    const r = await handleStripeWebhook(payload, sig, {
      open: false,
      constructEvent: (body, s) => stripeLib.webhooks.constructEvent(body, s, WEBHOOK_SECRET),
      onCheckoutCompleted: async () => { throw new Error('must not provision') },
      releaseHold: s => releaseSessionHold(redis, s),
      log: () => {}
    })
    expect(r.status).toBe(200)
    expect(holders('promo_A')).toEqual([])
    expect((await handleCreateCheckout({ ...BODY, subdomain: 'repair-two', code: 'PILOT-AAAA' }, mk(b.session))).status).toBe(200)
  })

  it('a hold older than 1860 seconds no longer counts, and one younger still does', async () => {
    const { redis } = holdRedis()
    const { stripe } = mockStripe([promoRow()])
    let clock = T0
    const deps = { stripe, redis, now: () => clock }
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_1', invite: null }, deps)).ok).toBe(true)
    clock = T0 + 1859 * 1000
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_2', invite: null }, deps)).ok).toBe(false)
    clock = T0 + 1861 * 1000
    expect((await checkCode({ code: 'PILOT-AAAA', holder: 'inv_2', invite: null }, deps)).ok).toBe(true)
  })

  it('a completed session keeps its hold, re-armed to now + 7800 s, instead of releasing it (closed)', async () => {
    const { inviteId, deps, redis, holders, scoreOf, releaseHookFn, rearmHookFn } = await webhookSetup(false)
    await holdCode(redis, 'promo_A', inviteId, 1, T0)
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(holders('promo_A')).toEqual([inviteId])
    expect(scoreOf('promo_A', inviteId)).toBe(T0 / 1000 + 7800)
    expect(rearmHookFn).toHaveBeenCalledTimes(1)
    expect(releaseHookFn).not.toHaveBeenCalled()
  })

  it('an open-launch completed coded session re-arms its hold too', async () => {
    const ok = await webhookSetup(true)
    await holdCode(ok.redis, 'promo_A', ok.inviteId, 1, T0)
    const good = makeEvent(ok.inviteId)
    await handleStripeWebhook(good.payload, good.sig, ok.deps)
    expect(ok.holders('promo_A')).toEqual([ok.inviteId])
    expect(ok.scoreOf('promo_A', ok.inviteId)).toBe(T0 / 1000 + 7800)
    expect(ok.releaseHookFn).not.toHaveBeenCalled()
  })

  it('a refused invited event (invite claimed by another session) re-arms nothing', async () => {
    const { redis, holders, inviteId, deps, rearmHookFn } = await webhookSetup(false)
    await holdCode(redis, 'promo_A', inviteId, 1, T0)
    await redis.set(`invite:u:${inviteId}`, 'cs_other', { nx: true })
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(rearmHookFn).not.toHaveBeenCalled()
    expect(holders('promo_A')).toEqual([inviteId])
  })

  it('a re-arm that fails after provisioning still answers 200 and has provisioned once, and logs no ids', async () => {
    const { inviteId, deps, onCheckoutCompleted, logs } = await webhookSetup(true)
    deps.rearmHold = vi.fn(async () => { throw new Error('redis down') })
    const { payload, sig } = makeEvent(inviteId)
    expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(logs).toEqual(['stripe-webhook: could not re-arm a code hold'])
    expect(logs.join('\n')).not.toContain(inviteId)
  })

  it('an expired session still releases the hold even after a re-arm (expired is a different event)', async () => {
    const { redis, holders, inviteId, deps } = await webhookSetup(false)
    await rearmHold(redis, 'promo_A', inviteId, T0)
    expect(holders('promo_A')).toEqual([inviteId])
    const { payload, sig } = makeEvent(inviteId, { type: 'checkout.session.expired' })
    await handleStripeWebhook(payload, sig, deps)
    expect(holders('promo_A')).toEqual([])
  })
})

describe('a refused code never reaches Stripe checkout or provisioning', () => {
  const cases: Array<[string, PromoRow[], { promoCodeId?: string }, ((r: FakeRedis) => Promise<unknown>)?]> = [
    ['used', [promoRow({ times_redeemed: 1 })], {}],
    ['expired', [promoRow({ expires_at: Math.floor(T0 / 1000) - 60 })], {}],
    ['unknown', [], {}],
    ['inactive', [promoRow({ active: false })], {}],
    ['bound to another invite', [promoRow()], { promoCodeId: 'promo_Z' }],
    ['held by another open checkout', [promoRow()], {}, r => holdCode(r, 'promo_A', 'another-invite', 1, T0)]
  ]
  for (const [name, rows, invite, prep] of cases) {
    it(`${name}: Stripe's session create and the provisioning dispatch are never called, and nothing is stored`, async () => {
      const s = await checkoutSetup(rows, invite)
      if (prep) await prep(s.redis)
      const dispatch = vi.fn(async () => {})
      const before = s.redis.keys()
      const r = await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, s.deps)
      expect(r).toEqual({ status: 409, body: { message: PROMO_REFUSED_MESSAGE } })
      expect(s.create).not.toHaveBeenCalled()
      expect(dispatch).not.toHaveBeenCalled()
      expect(s.redis.keys()).toEqual(before)
      const viaRoute = await handleCheckCode({ code: 'PILOT-AAAA' }, { session: s.session, stripe: s.stripe, redis: s.redis, now: () => T0 })
      expect(viaRoute.status).toBe(409)
      expect(s.create).not.toHaveBeenCalled()
    })
  }
})
