// The sign-up details the checkout accepts (Phase 23, plan 23-07). The schema
// and the page-type cleaner are the real ones from shared/signup.ts, not a copy:
// the first version of this file tested a pasted copy of the route's schema.
// What the checkout handler does with a valid body is in checkout.test.ts.
import { describe, it, expect, vi } from 'vitest'
import * as v from 'valibot'
import { signupBodySchema, topicTypeLabelSchema, cleanTopicTypes } from '../../shared/signup'

const valid = { communityName: 'Cascadia Bioregion', subdomain: 'cascadia' }

describe('signupBodySchema', () => {
  it('accepts a name and a subdomain', () => {
    const r = v.safeParse(signupBodySchema, valid)
    expect(r.success).toBe(true)
    if (r.success) expect(r.output).toEqual(valid)
  })

  it('accepts confirmed page types', () => {
    const r = v.safeParse(signupBodySchema, { ...valid, topicTypes: ['Meeting Notes', 'Field Guide'] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.output.topicTypes).toEqual(['Meeting Notes', 'Field Guide'])
  })

  it('has no email field: an email in the body is dropped, never carried', () => {
    const r = v.safeParse(signupBodySchema, { ...valid, email: 'someone@example.com' })
    expect(r.success).toBe(true)
    if (r.success) expect(JSON.stringify(r.output)).not.toContain('someone@example.com')
  })

  it.each([
    ['a name under 3 characters', { ...valid, communityName: 'ab' }],
    ['a name over 50 characters', { ...valid, communityName: 'A'.repeat(51) }],
    ['a subdomain under 3 characters', { ...valid, subdomain: 'ab' }],
    ['a subdomain over 63 characters', { ...valid, subdomain: 'a'.repeat(64) }],
    ['a subdomain that is not a DNS label', { ...valid, subdomain: 'Not_A-Label' }],
    ['a subdomain that starts with a hyphen', { ...valid, subdomain: '-cascadia' }],
    ['more than 12 page types', { ...valid, topicTypes: Array.from({ length: 13 }, (_, i) => `Type ${i}`) }],
    ['a page type with a character outside the allowed set', { ...valid, topicTypes: ['Notes <b>'] }],
    ['a page type of one character', { ...valid, topicTypes: ['A'] }],
    ['a page type over 40 characters', { ...valid, topicTypes: ['A'.repeat(41)] }],
    ['page types that are not a list', { ...valid, topicTypes: 'Notes' }]
  ])('rejects %s', (_label, body) => {
    expect(v.safeParse(signupBodySchema, body).success).toBe(false)
  })
})

describe('topicTypeLabelSchema', () => {
  it.each(['Notes', 'Q&A', 'How-to', 'Elders\' Stories', 'Maps/Atlas', 'Zone 4', 'Café Notes'])('accepts %s', (label) => {
    expect(v.safeParse(topicTypeLabelSchema, label).success).toBe(true)
  })

  it.each(['A', '', 'Notes!', 'Notes_two', '<script>', 'Notes\nTwo', 'x'.repeat(41)])('rejects %j', (label) => {
    expect(v.safeParse(topicTypeLabelSchema, label).success).toBe(false)
  })
})

describe('cleanTopicTypes', () => {
  it('trims, collapses spaces and keeps order', () => {
    expect(cleanTopicTypes(['  Meeting   Notes ', 'Field  Guide'])).toEqual(['Meeting Notes', 'Field Guide'])
  })

  it('drops invalid labels', () => {
    expect(cleanTopicTypes(['Good One', 'bad!', 'x', '<b>', 'Another'])).toEqual(['Good One', 'Another'])
  })

  it('drops case-insensitive duplicates, keeping the first spelling', () => {
    expect(cleanTopicTypes(['Field Guide', 'field guide', 'FIELD  GUIDE', 'Maps'])).toEqual(['Field Guide', 'Maps'])
  })

  it.each(['Blog', 'Content', 'Dialog', 'News', 'Reference'])('drops the default type %s, in any case', (name) => {
    expect(cleanTopicTypes([name, name.toLowerCase(), name.toUpperCase(), 'Keep Me'])).toEqual(['Keep Me'])
  })

  it('returns an empty list for an empty or missing list', () => {
    expect(cleanTopicTypes([])).toEqual([])
    expect(cleanTopicTypes(undefined)).toEqual([])
  })

  it('ignores entries that are not strings', () => {
    expect(cleanTopicTypes(['Maps', 7, null, { a: 1 }] as unknown as string[])).toEqual(['Maps'])
  })
})

// --- 23-32 Task 3: the paid-sign-up gate (B-2, Phase 23 part) and the time zone -----
//
// Until pause and removal (B-2) exist, a sign-up that is not 100% off is
// refused at checkout, before any hold, record, waiting-list write or Stripe
// session, unless runtimeConfig paidSignupsEnabled is true (orchestrator,
// 23-RULINGS-1108.md afternoon, answer 1). Tested off, unset and on. The
// refusal is the 23-UI-SPEC section 3 row "Paid sign-ups not open yet", word for
// word (Q-B2, answered 2026-11-08).
//
// The browser's IANA time zone is kept on signup:{provisionId} (orchestrator,
// 2026-11-08: "Time zone capture"); 23-37 formats the 3DS and "Payment not
// confirmed" mails with it, falling back to UTC.

import { FakeRedis } from './helpers/fake-redis'
import { roomyCapacity } from './helpers/capacity'
import { addInvite, emailKey, type InviteRecord } from '../../server/utils/invites'
import {
  handleCreateCheckout,
  isPaidSignupsEnabled,
  keptTimeZone,
  PAID_SIGNUPS_CLOSED_MESSAGE,
  type CheckoutDeps
} from '../../server/utils/checkout'
import { HOLD_SCRIPT } from '../../server/utils/promo'

const GATE_SECRET = 'test-invite-hash-secret'
const GATE_EMAIL = 'invited.person@example.com'
const GATE_BODY = { communityName: 'Repair Collective', subdomain: 'repair' }
const PROVISION = 'AAAAAAAAAAAAAAAAAAAAAA'

type Coupon = string | { percent_off?: number | null, amount_off?: number | null } | null

async function gateSetup(opts: { gate: boolean, coupon?: Coupon, open?: boolean, invited?: boolean } ) {
  const redis = new FakeRedis()
  // The hold always succeeds here; checkout.test.ts and promo.test.ts test the hold itself.
  redis.onEval(HOLD_SCRIPT, async (keys, args) => {
    await redis.zadd(keys[0]!, { score: Number(args[1]), member: String(args[2]) })
    return 1
  })
  const { inviteId } = await addInvite(redis, GATE_SECRET, { email: GATE_EMAIL, kind: 'pilot', wave: 'w1' })
  const session: InviteRecord = { inviteId, emailHmac: emailKey(GATE_SECRET, GATE_EMAIL), email: GATE_EMAIL }
  const create = vi.fn(async (_p: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
  const list = vi.fn(async (_p: unknown) => ({
    data: [{ id: 'promo_A', code: 'PILOT-AAAA', active: true, expires_at: null, max_redemptions: 1, times_redeemed: 0, promotion: { type: 'coupon', coupon: opts.coupon ?? null } }]
  }))
  const capacity = roomyCapacity()
  const logs: string[] = []
  const invited = opts.invited ?? true
  const deps: CheckoutDeps = {
    open: opts.open ?? false,
    session: invited ? session : null,
    stripe: { checkout: { sessions: { create } }, promotionCodes: { list } },
    redis: invited ? redis : undefined,
    priceId: 'price_test_123',
    currency: 'usd',
    origin: 'https://localnodes.xyz',
    newProvisionId: () => PROVISION,
    log: m => { logs.push(m) },
    capacity,
    paidSignupsEnabled: opts.gate
  }
  return { redis, inviteId, create, list, capacity, logs, deps }
}

describe('the paid-sign-up gate (23-32, B-2 Phase 23 part)', () => {
  it('the refusal is the 23-UI-SPEC section 3 row "Paid sign-ups not open yet", word for word', () => {
    expect(PAID_SIGNUPS_CLOSED_MESSAGE).toBe('We\'re not taking paid sign-ups yet. If you have a code, enter it above.')
  })

  it.each([
    [true, true], ['true', true],
    [false, false], [undefined, false], [null, false], ['', false], ['false', false], ['1', false], [1, false], ['yes', false], ['on', false], ['TRUE ', false]
  ] as const)('isPaidSignupsEnabled(%j) is %s', (value, open) => {
    expect(isPaidSignupsEnabled(value)).toBe(open)
  })

  it.each([
    ['off', false],
    ['unset (the default config)', isPaidSignupsEnabled(undefined)]
  ] as const)('gate %s, invited, no code: 409 with the message; no waiting list, hold, record or Stripe call', async (_label, gate) => {
    const { redis, create, list, capacity, logs, deps } = await gateSetup({ gate })
    const before = redis.dump()
    const r = await handleCreateCheckout(GATE_BODY, deps)
    expect(r).toEqual({ status: 409, body: { message: PAID_SIGNUPS_CLOSED_MESSAGE } })
    expect(redis.dump()).toBe(before)
    expect(capacity.hasRoom).not.toHaveBeenCalled()
    expect(capacity.waitlist).not.toHaveBeenCalled()
    expect(capacity.addInflight).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
    expect(logs).toEqual(['create-checkout: refused, paid sign-ups not open'])
  })

  it('gate off, invited, a code whose coupon is percent_off 100: the checkout goes ahead as today', async () => {
    const { create, deps } = await gateSetup({ gate: false, coupon: { percent_off: 100 } })
    const r = await handleCreateCheckout({ ...GATE_BODY, code: 'PILOT-AAAA' }, deps)
    expect(r).toEqual({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay_1' } })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['percent_off 50', { percent_off: 50 }],
    ['amount_off', { amount_off: 500, percent_off: null }],
    ['an unexpanded coupon id', 'coupon_123'],
    ['no coupon at all', null]
  ] as const)('gate off, invited, a code whose coupon is %s: 409 with the same message, and the hold is released', async (_label, coupon) => {
    const { redis, inviteId, create, capacity, deps } = await gateSetup({ gate: false, coupon })
    const r = await handleCreateCheckout({ ...GATE_BODY, code: 'PILOT-AAAA' }, deps)
    expect(r).toEqual({ status: 409, body: { message: PAID_SIGNUPS_CLOSED_MESSAGE } })
    expect(await redis.zrangebyscore('promo:holds:promo_A', '-inf', '+inf')).not.toContain(inviteId)
    expect(await redis.exists(`signup:${PROVISION}`)).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(capacity.addInflight).not.toHaveBeenCalled()
  })

  it('gate off, launch open, the public branch: 409 with the same message before the room check', async () => {
    const { create, capacity, deps } = await gateSetup({ gate: false, open: true, invited: false })
    const r = await handleCreateCheckout({ ...GATE_BODY, email: 'buyer@example.com' }, deps)
    expect(r).toEqual({ status: 409, body: { message: PAID_SIGNUPS_CLOSED_MESSAGE } })
    expect(capacity.hasRoom).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('gate off, the public branch is refused even with no currency configured (the gate is checked first)', async () => {
    const { deps } = await gateSetup({ gate: false, open: true, invited: false })
    const r = await handleCreateCheckout({ ...GATE_BODY, email: 'buyer@example.com' }, { ...deps, currency: '' })
    expect(r.status).toBe(409)
  })

  it.each([
    ['no code', {}, undefined],
    ['a 50% code', { code: 'PILOT-AAAA' }, { percent_off: 50 }],
    ['an unexpanded coupon', { code: 'PILOT-AAAA' }, 'coupon_123']
  ] as const)('gate on, invited, %s: the checkout goes ahead as today', async (_label, extra, coupon) => {
    const { create, deps } = await gateSetup({ gate: true, coupon })
    expect((await handleCreateCheckout({ ...GATE_BODY, ...extra }, deps)).status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('gate on, the public branch goes ahead as today', async () => {
    const { create, deps } = await gateSetup({ gate: true, open: true, invited: false })
    expect((await handleCreateCheckout({ ...GATE_BODY, email: 'buyer@example.com' }, deps)).status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('CheckoutDeps.paidSignupsEnabled is required, and the route reads it through isPaidSignupsEnabled', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../server/utils/checkout.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/^\s+paidSignupsEnabled: boolean$/m)
    const route = readFileSync(new URL('../../server/api/create-checkout.post.ts', import.meta.url), 'utf8')
    expect(route).toMatch(/paidSignupsEnabled: isPaidSignupsEnabled\(config\.paidSignupsEnabled\)/)
  })
})

describe('the browser time zone is kept on the sign-up record (orchestrator, 2026-11-08)', () => {
  it.each(['America/Denver', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+7'])('keeps %s', (zone) => {
    expect(keptTimeZone(zone)).toBe(zone)
  })

  it.each([
    ['not a zone', 'Mars/Olympus_Mons'],
    ['an offset', '+05:00'],
    ['markup', '<script>'],
    ['too long', `America/${'x'.repeat(80)}`],
    ['a number', 7],
    ['empty', ''],
    ['missing', undefined]
  ] as const)('drops %s', (_label, zone) => {
    expect(keptTimeZone(zone)).toBeUndefined()
  })

  it('an invited checkout stores timeZone on signup:{provisionId}', async () => {
    const { redis, deps } = await gateSetup({ gate: true })
    await handleCreateCheckout({ ...GATE_BODY, timeZone: 'America/Denver' }, deps)
    expect((await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`))?.timeZone).toBe('America/Denver')
  })

  it('an invalid or missing zone is dropped, never refused', async () => {
    for (const timeZone of ['Not/AZone', undefined]) {
      const { redis, deps } = await gateSetup({ gate: true })
      const r = await handleCreateCheckout({ ...GATE_BODY, ...(timeZone === undefined ? {} : { timeZone }) }, deps)
      expect(r.status).toBe(200)
      expect(await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`)).not.toHaveProperty('timeZone')
    }
  })
})

// --- 23-37: the owner binding of the "Confirm my payment" button ---------------
// Checkout already gets sessionHash, the sha256 of the ln_invite cookie that
// made it (23-18). It is kept on signup:{provisionId} as ownerSessionHash, so
// the status read and POST /api/confirm-payment can tell the browser that made
// this sign-up from any other (Tom's answer 3).
describe('the owner session hash is kept on the sign-up record (23-37)', () => {
  const HASH = 'a'.repeat(64)

  it('an invited checkout with a session hash stores ownerSessionHash on signup:{provisionId}', async () => {
    const { redis, deps } = await gateSetup({ gate: true })
    const r = await handleCreateCheckout(GATE_BODY, { ...deps, sessionHash: HASH })
    expect(r.status).toBe(200)
    expect((await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`))?.ownerSessionHash).toBe(HASH)
  })

  it('without a session hash nothing is stored', async () => {
    const { redis, deps } = await gateSetup({ gate: true })
    await handleCreateCheckout(GATE_BODY, { ...deps, sessionHash: null })
    expect(await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`)).not.toHaveProperty('ownerSessionHash')
  })
})

// --- 23-43 Task 3 (D3): the price and the coupon are frozen on the sign-up at checkout ---------
//
// The subscription is started later, at ready (23-32), with the values written here, never with
// the runtime price of that later moment: a price change after checkout changes nothing for this
// sign-up (billing.test.ts, m45).

describe('frozen parameters (23-43 Task 3, D3)', () => {
  it('writes priceId (the price in force at checkout) and couponId (the code\'s coupon, expanded) on signup:{provisionId}, beside promoId', async () => {
    const { redis, deps } = await gateSetup({ gate: false, coupon: { id: 'coupon_full', percent_off: 100 } as unknown as Coupon })
    const r = await handleCreateCheckout({ ...GATE_BODY, code: 'PILOT-AAAA' }, deps)
    expect(r.status).toBe(200)
    expect(await redis.hgetall(`signup:${PROVISION}`)).toMatchObject({ promoId: 'promo_A', priceId: 'price_test_123', couponId: 'coupon_full' })
  })

  it('an unexpanded coupon id is frozen as it is', async () => {
    const { redis, deps } = await gateSetup({ gate: true, coupon: 'coupon_123' })
    await handleCreateCheckout({ ...GATE_BODY, code: 'PILOT-AAAA' }, deps)
    expect(await redis.hgetall(`signup:${PROVISION}`)).toMatchObject({ priceId: 'price_test_123', couponId: 'coupon_123' })
  })

  it('no code: priceId is frozen, and no couponId or promoId is written', async () => {
    const { redis, deps } = await gateSetup({ gate: true })
    await handleCreateCheckout(GATE_BODY, deps)
    const signup = (await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`))!
    expect(signup.priceId).toBe('price_test_123')
    expect(signup).not.toHaveProperty('couponId')
    expect(signup).not.toHaveProperty('promoId')
  })
})
