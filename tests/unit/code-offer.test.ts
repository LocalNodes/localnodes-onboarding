// What a promotion code offers, for the sign-up form's words: classifyCode (a
// read-only look at a code), the offer that POST /api/check-code adds to its
// reply, and the inviteCode that GET /api/price adds for an invited session.
// Stripe is a mock and Redis is a fake: nothing touches a network.
import { describe, it, expect, vi } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import { addInvite, emailKey, inviteKey, type InviteRecord } from '../../server/utils/invites'
import { classifyCode, holdCode, HOLD_SCRIPT, holdScriptTwin, PROMO_REFUSED_MESSAGE } from '../../server/utils/promo'
import { handleCheckCode } from '../../server/utils/check-code'
import { handlePrice, resetPriceCache, type PriceLike } from '../../server/utils/price'
import { readCodeOffer, monthsPhrase, monthsWord, normalizeCode } from '../../shared/code-offer'

const SECRET = 'test-invite-hash-secret'
const EMAIL = 'invited.person@example.com'
const T0 = 1_700_000_000_000

type Coupon = Record<string, unknown> | string | null
interface Row {
  id: string
  code: string
  active: boolean
  expires_at: number | null
  max_redemptions: number | null
  times_redeemed: number
  metadata?: Record<string, string>
  promotion?: { type: string, coupon: Coupon }
}
const row = (over: Partial<Row> = {}, coupon: Coupon = { percent_off: 100, duration: 'repeating', duration_in_months: 3 }): Row => ({
  id: 'promo_A',
  code: 'PILOT-AAAA',
  active: true,
  expires_at: null,
  max_redemptions: 1,
  times_redeemed: 0,
  promotion: { type: 'coupon', coupon },
  ...over
})

function mockStripe(rows: Row[]) {
  const list = vi.fn(async (params: { code: string }) => ({ data: rows.filter(r => r.code.toLowerCase() === params.code.toLowerCase()) }))
  return { list, stripe: { promotionCodes: { list } } }
}

describe('classifyCode', () => {
  const classify = async (rows: Row[], code = 'PILOT-AAAA', invite: { inviteId?: string, promoCodeId?: string } | null = null) =>
    classifyCode({ code, invite }, { stripe: mockStripe(rows).stripe, now: () => T0 })

  it('a 100%-off repeating coupon is a pilot of that many months', async () => {
    expect(await classify([row()])).toEqual({ offer: 'pilot', months: 3 })
    expect(await classify([row({}, { percent_off: 100, duration: 'repeating', duration_in_months: 6 })])).toEqual({ offer: 'pilot', months: 6 })
  })

  it('a valid code that is not a free pilot is paid, including a one-time amount discount', async () => {
    expect(await classify([row({}, { percent_off: 50, duration: 'forever' })])).toEqual({ offer: 'paid' })
    expect(await classify([row({}, { amount_off: 4900, percent_off: null, duration: 'once' })])).toEqual({ offer: 'paid' })
  })

  it('a 100%-off once coupon is a paid discount, never a pilot', async () => {
    expect(await classify([row({}, { percent_off: 100, duration: 'once' })])).toEqual({ offer: 'paid' })
  })

  it('a refused or empty code is none', async () => {
    expect(await classify([])).toEqual({ offer: 'none' })
    expect(await classify([row()], '   ')).toEqual({ offer: 'none' })
    expect(await classify([row({ times_redeemed: 1 })])).toEqual({ offer: 'none' })
    expect(await classify([row({ active: false })])).toEqual({ offer: 'none' })
    expect(await classify([row({ expires_at: Math.floor(T0 / 1000) - 5 })])).toEqual({ offer: 'none' })
    expect(await classify([row()], 'PILOT-AAAA', { promoCodeId: 'promo_Z' })).toEqual({ offer: 'none' })
    expect(await classify([row({ metadata: { invite_id: 'inv_other' } })], 'PILOT-AAAA', { inviteId: 'inv_1' })).toEqual({ offer: 'none' })
    expect(await classify([row({}, 'coupon_id_only')])).toEqual({ offer: 'none' })
    expect(await classify([row({}, { percent_off: 100, duration: 'forever' })])).toEqual({ offer: 'none' })
  })

  it('judges expiry by the clock after Stripe replies', async () => {
    let clock = T0
    const { stripe, list } = mockStripe([row({ expires_at: Math.floor(T0 / 1000) + 10 })])
    const reply = list.getMockImplementation()!
    list.mockImplementation(async (params: { code: string }) => {
      const out = await reply(params)
      clock = T0 + 20_000
      return out
    })
    expect(await classifyCode({ code: 'PILOT-AAAA', invite: null }, { stripe, now: () => clock })).toEqual({ offer: 'none' })
  })

  it('a code bound to this invite reads by what it offers', async () => {
    expect(await classify([row({ metadata: { invite_id: 'inv_1' } })], 'PILOT-AAAA', { inviteId: 'inv_1', promoCodeId: 'promo_A' })).toEqual({ offer: 'pilot', months: 3 })
  })

  it('a Stripe error is unknown, never paid, and the error text is not kept', async () => {
    const list = vi.fn(async () => { throw new Error('stripe down for PILOT-AAAA') })
    const r = await classifyCode({ code: 'PILOT-AAAA', invite: null }, { stripe: { promotionCodes: { list } }, now: () => T0 })
    expect(r).toEqual({ offer: 'unknown' })
  })

  it('trims the code the way checkCode does, and places no hold', async () => {
    const { list, stripe } = mockStripe([row()])
    const redis = new FakeRedis()
    const evalSpy = vi.spyOn(redis, 'eval')
    expect(await classifyCode({ code: '  PILOT-AAAA ', invite: null }, { stripe, now: () => T0 })).toEqual({ offer: 'pilot', months: 3 })
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ code: 'PILOT-AAAA' }))
    expect(evalSpy).not.toHaveBeenCalled()
  })

  it('does not read live holds: a code another checkout holds still reads by what it offers', async () => {
    const { stripe } = mockStripe([row()])
    const redis = new FakeRedis()
    const zset = new Map<string, number>()
    redis.onEval(HOLD_SCRIPT, (_keys, args) => holdScriptTwin(zset, args))
    expect(await holdCode(redis, 'promo_A', 'another-invite', 1, T0)).toBe(true)
    expect(await classifyCode({ code: 'PILOT-AAAA', invite: null }, { stripe, now: () => T0 })).toEqual({ offer: 'pilot', months: 3 })
    expect(await holdCode(redis, 'promo_A', 'this-invite', 1, T0)).toBe(false)
  })
})

describe('the shared offer words', () => {
  it('reads a reply defensively: anything that is not one of the four answers is unknown', () => {
    expect(readCodeOffer({ offer: 'pilot', months: 3 })).toEqual({ offer: 'pilot', months: 3 })
    expect(readCodeOffer({ offer: 'paid' })).toEqual({ offer: 'paid' })
    expect(readCodeOffer({ offer: 'none' })).toEqual({ offer: 'none' })
    for (const bad of [null, undefined, {}, { offer: 'pilot' }, { offer: 'pilot', months: 0 }, { offer: 'pilot', months: 1.5 }, { offer: 'pilot', months: '3' }, { offer: 'free' }, 'paid', { offer: 'unknown' }]) {
      expect(readCodeOffer(bad), JSON.stringify(bad)).toEqual({ offer: 'unknown' })
    }
  })

  it('three months reads "three", any other count a numeral, and one month is singular', () => {
    expect(monthsWord(3)).toBe('three')
    expect(monthsWord(6)).toBe('6')
    expect(monthsPhrase(3)).toBe('three months')
    expect(monthsPhrase(1)).toBe('1 month')
    expect(monthsPhrase(12)).toBe('12 months')
  })

  it('a code is normalized by trimming', () => {
    expect(normalizeCode('  PILOT-AAAA\n')).toBe('PILOT-AAAA')
  })
})

describe('check-code reply', () => {
  async function setup(rows: Row[]) {
    const redis = new FakeRedis()
    const zsets = new Map<string, Map<string, number>>()
    redis.onEval(HOLD_SCRIPT, (keys, args) => {
      let z = zsets.get(keys[0]!)
      if (!z) zsets.set(keys[0]!, (z = new Map()))
      return holdScriptTwin(z, args)
    })
    const { inviteId } = await addInvite(redis, SECRET, { email: EMAIL, kind: 'pilot', wave: 'w1' })
    const session: InviteRecord = { inviteId, emailHmac: emailKey(SECRET, EMAIL), email: EMAIL }
    const { stripe, list } = mockStripe(rows)
    return { deps: { session, stripe, redis, now: () => T0, paidSignupsEnabled: true }, list, redis, inviteId, zsets }
  }

  it('a free pilot code answers ok with its offer and months, paid sign-ups open or closed', async () => {
    const { deps } = await setup([row()])
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, deps)).toEqual({ status: 200, body: { ok: true, offer: 'pilot', months: 3 } })
    const closed = await setup([row()])
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, { ...closed.deps, paidSignupsEnabled: false })).toEqual({ status: 200, body: { ok: true, offer: 'pilot', months: 3 } })
    expect([...(closed.zsets.get('promo:holds:promo_A')?.keys() ?? [])]).toEqual([closed.inviteId])
  })

  it('paid sign-ups open: a discount that is not a free pilot answers ok with offer paid and no months', async () => {
    const { deps } = await setup([row({ max_redemptions: null }, { percent_off: 50, duration: 'forever' })])
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, deps)).toEqual({ status: 200, body: { ok: true, offer: 'paid' } })
  })

  it('paid sign-ups open: a 100%-off once code answers offer paid, not a pilot', async () => {
    const { deps } = await setup([row({}, { percent_off: 100, duration: 'once' })])
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, deps)).toEqual({ status: 200, body: { ok: true, offer: 'paid' } })
  })

  it.each([
    ['100% off once', { percent_off: 100, duration: 'once' }],
    ['50% off forever', { percent_off: 50, duration: 'forever' }]
  ] as const)('paid sign-ups closed: a %s code is refused in the refused-code words, and no hold is ever taken', async (_label, coupon) => {
    const { deps, redis, zsets } = await setup([row({}, coupon)])
    const evalSpy = vi.spyOn(redis, 'eval')
    const zrem = vi.spyOn(redis, 'zrem')
    expect(await handleCheckCode({ code: 'PILOT-AAAA' }, { ...deps, paidSignupsEnabled: false })).toEqual({ status: 409, body: { ok: false, message: PROMO_REFUSED_MESSAGE } })
    expect(evalSpy).not.toHaveBeenCalled()
    expect(zrem).not.toHaveBeenCalled()
    expect(zsets.has('promo:holds:promo_A')).toBe(false)
    expect(await redis.exists('promo:holds:promo_A')).toBe(0)
  })

  it('paid sign-ups not stated: read as closed', async () => {
    const { deps } = await setup([row({}, { percent_off: 100, duration: 'once' })])
    const { paidSignupsEnabled: _gate, ...rest } = deps
    expect((await handleCheckCode({ code: 'PILOT-AAAA' }, rest as typeof deps)).status).toBe(409)
  })
})

describe('GET /api/price for an invited session with a code', () => {
  const monthly: PriceLike = { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }
  async function setup(rows: Row[], invite: { promoCodeId?: string, promoCode?: string } = { promoCode: 'PILOT-AAAA' }) {
    resetPriceCache()
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, SECRET, { email: EMAIL, kind: 'pilot', wave: 'w1', ...invite })
    // A session in today's format: the code text, the invite id and the address hash; no code id.
    const session: InviteRecord = { inviteId, emailHmac: emailKey(SECRET, EMAIL), email: EMAIL, ...(invite.promoCode ? { promoCode: invite.promoCode } : {}) }
    const { stripe: promoStripe, list } = mockStripe(rows)
    const deps = {
      open: false,
      session: session as InviteRecord | null,
      stripe: { prices: { retrieve: async () => monthly }, ...promoStripe },
      redis,
      priceId: 'price_a',
      currency: 'usd',
      paidSignupsEnabled: true,
      now: () => T0
    }
    return { deps, list, redis, session }
  }

  it('adds the offer of the invite\'s code to the price line', async () => {
    const { deps } = await setup([row({ metadata: {} })])
    expect(await handlePrice(deps)).toEqual({ status: 200, body: { line: '$49 a month', invited: true, inviteCode: { code: 'PILOT-AAAA', offer: 'pilot', months: 3 } } })
  })

  it('reads the code id from the invite hash, so a code bound to another code reads none', async () => {
    const { deps } = await setup([row()], { promoCode: 'PILOT-AAAA', promoCodeId: 'promo_Z' })
    expect((await handlePrice(deps)).body).toMatchObject({ inviteCode: { code: 'PILOT-AAAA', offer: 'none' } })
    const ok = await setup([row()], { promoCode: 'PILOT-AAAA', promoCodeId: 'promo_A' })
    expect((await handlePrice(ok.deps)).body).toMatchObject({ inviteCode: { offer: 'pilot', months: 3 } })
  })

  it.each([
    ['monthly', { unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }],
    ['weekly', { unit_amount: 1200, currency: 'usd', recurring: { interval: 'week', interval_count: 1 } }]
  ] as const)('a 100%%-off once code on a %s price reads paid with paid sign-ups open, none with them closed', async (_label, price) => {
    const { deps } = await setup([row({ metadata: {} }, { percent_off: 100, duration: 'once' })])
    const withPrice = { ...deps, stripe: { ...deps.stripe, prices: { retrieve: async () => price as PriceLike } } }
    expect((await handlePrice(withPrice)).body).toMatchObject({ inviteCode: { code: 'PILOT-AAAA', offer: 'paid' } })
    resetPriceCache()
    expect((await handlePrice({ ...withPrice, paidSignupsEnabled: false })).body).toMatchObject({ inviteCode: { code: 'PILOT-AAAA', offer: 'none' } })
  })

  it('paid sign-ups closed: a pilot code still reads as the pilot', async () => {
    const { deps } = await setup([row({ metadata: {} })])
    expect((await handlePrice({ ...deps, paidSignupsEnabled: false })).body).toMatchObject({ inviteCode: { offer: 'pilot', months: 3 } })
  })

  it('a discount that is not a free pilot reads paid', async () => {
    const { deps } = await setup([row({ max_redemptions: null }, { percent_off: 20, duration: 'forever' })])
    expect((await handlePrice(deps)).body).toMatchObject({ inviteCode: { offer: 'paid' } })
  })

  it('a Stripe error on the code reads unknown and the price line still comes', async () => {
    const { deps, list } = await setup([row()])
    list.mockRejectedValueOnce(new Error('down'))
    expect(await handlePrice(deps)).toEqual({ status: 200, body: { line: '$49 a month', invited: true, inviteCode: { code: 'PILOT-AAAA', offer: 'unknown' } } })
  })

  it('an unreadable invite hash reads unknown, not paid', async () => {
    const { deps, redis } = await setup([row()])
    vi.spyOn(redis, 'hgetall').mockRejectedValueOnce(new Error('redis down'))
    expect((await handlePrice(deps)).body).toMatchObject({ inviteCode: { offer: 'unknown' } })
  })

  it('a session without a code, an uninvited visitor, or a launch-open visitor gets the line alone and Stripe is not asked about codes', async () => {
    const none = await setup([row()], {})
    expect(await handlePrice(none.deps)).toEqual({ status: 200, body: { line: '$49 a month', invited: true } })
    const open = await setup([row()])
    expect(await handlePrice({ ...open.deps, open: true, session: null })).toEqual({ status: 200, body: { line: '$49 a month' } })
    expect(none.list).not.toHaveBeenCalled()
    expect(open.list).not.toHaveBeenCalled()
  })

  it('with the launch open an invited session still gets its code read, and the reply says the session is live', async () => {
    const { deps } = await setup([row({ metadata: {} })])
    expect(await handlePrice({ ...deps, open: true })).toEqual({ status: 200, body: { line: '$49 a month', invited: true, inviteCode: { code: 'PILOT-AAAA', offer: 'pilot', months: 3 } } })
  })

  it('the hash of another invite makes the code none', async () => {
    const { deps, redis, session } = await setup([row()])
    await redis.hset(inviteKey(session.emailHmac), { inviteId: 'someone-else' })
    expect((await handlePrice(deps)).body).toMatchObject({ inviteCode: { offer: 'none' } })
  })
})
