// Create-checkout for invited people (Phase 23, plan 23-07, D-02, D-03, D-04,
// D-20). Redis is a fake and Stripe is a mock: nothing here touches a network.
import { describe, it, expect, vi } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import { addInvite, emailKey, inviteKey, getInvitedSession, createInvitedSession, SESSION_TTL_SECONDS, type InviteRecord } from '../../server/utils/invites'
import { handleCreateCheckout, INVITE_USED_MESSAGE, type CheckoutDeps } from '../../server/utils/checkout'
import { roomyCapacity } from './helpers/capacity'
import { checkoutMarkerKey } from '../../server/utils/checkout-marker'

const SECRET = 'test-invite-hash-secret'
const INVITED = 'invited.person@example.com'
const OTHER = 'someone.else@example.org'
const BODY = { communityName: 'Repair Collective', subdomain: 'repair' }
const PRICE = 'price_test_123'
const ORIGIN = 'https://localnodes.xyz'

async function setup(over: Partial<CheckoutDeps> = {}) {
  const redis = new FakeRedis()
  const { inviteId } = await addInvite(redis, SECRET, { email: INVITED, kind: 'pilot', wave: 'w1' })
  const session: InviteRecord = { inviteId, emailHmac: emailKey(SECRET, INVITED), email: INVITED }
  const logs: string[] = []
  const create = vi.fn(async (_params: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
  const deps: CheckoutDeps = {
    open: false,
    session,
    stripe: { checkout: { sessions: { create } } },
    redis,
    priceId: PRICE, paidSignupsEnabled: true,
    currency: 'usd',
    origin: ORIGIN,
    newProvisionId: () => 'AAAAAAAAAAAAAAAAAAAAAA',
    log: (m: string) => { logs.push(m) },
    capacity: roomyCapacity(),
    ...over
  }
  const params = () => create.mock.calls[0]![0] as Record<string, any>
  return { redis, session, inviteId, logs, create, deps, params }
}

describe('create-checkout, launch closed', () => {
  it('without an invited session it answers 404, never calls Stripe and writes nothing', async () => {
    const { redis, create, deps, logs } = await setup({ session: null })
    const before = redis.keys()
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
    expect(redis.keys()).toEqual(before)
    expect(logs.join('\n')).not.toContain(INVITED)
  })

  it('with an invited session and a different email in the body, Stripe gets the invited email', async () => {
    const { create, deps, params } = await setup()
    const r = await handleCreateCheckout({ ...BODY, email: OTHER }, deps)
    expect(r).toEqual({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay_1' } })
    expect(create).toHaveBeenCalledTimes(1)
    expect(params().customer_email).toBe(INVITED)
    expect(JSON.stringify(params())).not.toContain(OTHER)
  })

  it('the Stripe session carries invited, invite id and a 22-character provision id, and no email in metadata', async () => {
    const { deps, inviteId, params } = await setup({ newProvisionId: undefined })
    await handleCreateCheckout(BODY, deps)
    const p = params()
    expect(p.mode).toBe('setup')
    const expected = { invited: 'true', invite_id: inviteId, subdomain: 'repair', communityName: 'Repair Collective' }
    expect(p.metadata).toMatchObject(expected)
    expect(p.metadata.provision_id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(p.setup_intent_data.metadata).toEqual(p.metadata)
    expect(JSON.stringify(p.metadata)).not.toContain(INVITED)
    expect(JSON.stringify(p.metadata)).not.toContain('@')
    expect(Object.keys(p.metadata).sort()).toEqual(['communityName', 'invite_id', 'invited', 'provision_id', 'subdomain'])
  })

  it('uses the success page with the session id, and the cancel page', async () => {
    const { deps, params } = await setup()
    await handleCreateCheckout(BODY, deps)
    expect(params().success_url).toBe(`${ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`)
    expect(params().cancel_url).toBe(`${ORIGIN}/cancel`)
  })

  it('stores signup:{provisionId} with the confirmed page types, the Gemini platform choice and a two-day life', async () => {
    const { redis, deps, inviteId } = await setup()
    await handleCreateCheckout({ ...BODY, topicTypes: ['  Field   Guide ', 'field guide', 'Blog', 'Maps'] }, deps)
    const rec = await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')
    expect(rec).toMatchObject({
      subdomain: 'repair',
      communityName: 'Repair Collective',
      email: INVITED,
      inviteId,
      topicTypes: ['Field Guide', 'Maps'],
      aiProvider: 'gemini',
      aiKeySource: 'platform'
    })
    expect(await redis.ttl('signup:AAAAAAAAAAAAAAAAAAAAAA')).toBe(172800)
  })

  it('stores an empty page type list when the organizer confirmed none', async () => {
    const { redis, deps } = await setup()
    await handleCreateCheckout(BODY, deps)
    const rec = await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')
    expect(rec?.topicTypes).toEqual([])
  })

  it('creates no page type the organizer did not confirm: only the cleaned list is stored', async () => {
    const { redis, deps } = await setup()
    await handleCreateCheckout({ ...BODY, topicTypes: ['News', 'Dialog'] }, deps)
    const rec = await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')
    expect(rec?.topicTypes).toEqual([])
  })

  it('each checkout gets its own record under its own provision id', async () => {
    const ids = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB']
    const { redis, deps } = await setup({ newProvisionId: () => ids.shift()! })
    await handleCreateCheckout(BODY, deps)
    await handleCreateCheckout({ ...BODY, subdomain: 'repair-two' }, deps)
    expect(redis.keys().filter(k => k.startsWith('signup:')).sort()).toEqual(['signup:AAAAAAAAAAAAAAAAAAAAAA', 'signup:BBBBBBBBBBBBBBBBBBBBBB'])
  })

  it('answers 500 when Stripe gives back no URL', async () => {
    const { deps } = await setup()
    ;(deps.stripe.checkout.sessions.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ url: null })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(500)
  })

  it('answers 400 for a bad body and does not call Stripe', async () => {
    const { create, deps } = await setup()
    for (const bad of [{}, { communityName: 'ab', subdomain: 'repair' }, { ...BODY, subdomain: 'Bad_Name' }, null, 'text']) {
      expect((await handleCreateCheckout(bad, deps)).status).toBe(400)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('treats a session record without an email as no session', async () => {
    const { session, create, deps } = await setup()
    const broken = { ...session, email: '' }
    const r = await handleCreateCheckout(BODY, { ...deps, session: broken })
    expect(r.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
  })
})

// T-3 (23-31): checkout only saves the card. Nothing is charged until the site is live.
describe('create-checkout, setup mode (nothing is charged at checkout)', () => {
  const FORBIDDEN = ['line_items', 'subscription_data', 'discounts', 'payment_method_collection']

  it('an invited checkout calls Stripe once with mode setup, the configured currency, a customer, and the invited email', async () => {
    const { create, deps, params, inviteId } = await setup()
    await handleCreateCheckout(BODY, deps)
    expect(create).toHaveBeenCalledTimes(1)
    const p = params()
    expect(p.mode).toBe('setup')
    expect(p.currency).toBe('usd')
    expect(p.customer_creation).toBe('always')
    expect(p.customer_email).toBe(INVITED)
    expect(p.success_url).toBe(`${ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`)
    expect(p.cancel_url).toBe(`${ORIGIN}/cancel`)
    expect(p.metadata).toEqual({ invited: 'true', invite_id: inviteId, provision_id: 'AAAAAAAAAAAAAAAAAAAAAA', subdomain: 'repair', communityName: 'Repair Collective' })
  })

  it('the params carry no line_items, subscription_data, discounts or payment_method_collection key, for a plain invited checkout', async () => {
    const { deps, params } = await setup()
    await handleCreateCheckout(BODY, deps)
    for (const k of FORBIDDEN) expect(Object.keys(params()), k).not.toContain(k)
  })

  it('the same holds for the public branch while the launch is open', async () => {
    const { deps, params } = await setup({ open: true, session: null, redis: undefined })
    await handleCreateCheckout({ ...BODY, email: 'buyer@example.com' }, deps)
    for (const k of FORBIDDEN) expect(Object.keys(params()), k).not.toContain(k)
    expect(params().mode).toBe('setup')
  })

  it('the public branch sends currency, customer_creation always, the form email, its old metadata and setup_intent_data.metadata', async () => {
    const { deps, params } = await setup({ open: true, session: null, redis: undefined, currency: 'eur' })
    await handleCreateCheckout({ ...BODY, email: 'buyer@example.com' }, deps)
    const p = params()
    expect(p).toMatchObject({ mode: 'setup', currency: 'eur', customer_creation: 'always', customer_email: 'buyer@example.com' })
    expect(p.metadata).toEqual({ communityName: 'Repair Collective', subdomain: 'repair', email: 'buyer@example.com' })
    expect(p.setup_intent_data.metadata).toEqual(p.metadata)
  })

  // Stripe Checkout takes only description, metadata and on_behalf_of in setup_intent_data
  // (stripe-node 20.4.0 SetupIntentData, Stripe's Checkout create reference). A SetupIntent's
  // usage already defaults to off_session, so sending usage would only earn an unknown-parameter 400.
  // 23-22 Task 1 reads the usage off the first test-mode SetupIntent.
  it('setup_intent_data carries metadata and nothing else, on both branches (usage is not a Checkout parameter)', async () => {
    const invited = await setup()
    await handleCreateCheckout(BODY, invited.deps)
    expect(Object.keys(invited.params().setup_intent_data)).toEqual(['metadata'])
    const open = await setup({ open: true, session: null, redis: undefined })
    await handleCreateCheckout({ ...BODY, email: 'buyer@example.com' }, open.deps)
    expect(Object.keys(open.params().setup_intent_data)).toEqual(['metadata'])
  })

  it('currency comes from the server setting, never from the request body', async () => {
    const { deps, params } = await setup({ currency: 'gbp' })
    await handleCreateCheckout({ ...BODY, currency: 'jpy' }, deps)
    expect(params().currency).toBe('gbp')
  })

  it('an empty configured currency answers 500, never calls Stripe, and writes and holds nothing', async () => {
    for (const currency of ['', '   ']) {
      const { redis, create, deps } = await setup({ currency })
      const before = redis.keys()
      const r = await handleCreateCheckout(BODY, deps)
      expect(r).toEqual({ status: 500, body: { message: 'Failed to create checkout session' } })
      expect(create).not.toHaveBeenCalled()
      expect(redis.keys()).toEqual(before)
    }
    const open = await setup({ open: true, session: null, redis: undefined, currency: '' })
    expect((await handleCreateCheckout({ ...BODY, email: 'buyer@example.com' }, open.deps)).status).toBe(500)
    expect(open.create).not.toHaveBeenCalled()
  })

  it('a plain invited checkout stores no promoId on the signup record', async () => {
    const { redis, deps } = await setup()
    await handleCreateCheckout(BODY, deps)
    const rec = await redis.hgetall<Record<string, unknown>>('signup:AAAAAAAAAAAAAAAAAAAAAA')
    expect(rec).not.toHaveProperty('promoId')
  })
})

describe('create-checkout, the community description (23-33, T-2)', () => {
  const REC = 'signup:AAAAAAAAAAAAAAAAAAAAAA'
  const DESC = 'A reading group that meets online every second Sunday.'

  it('stores the cleaned description on signup:{provisionId}', async () => {
    const { redis, deps } = await setup()
    const r = await handleCreateCheckout({ ...BODY, description: `  A reading group\u0000 that meets   online\u202e every second Sunday.  ` }, deps)
    expect(r.status).toBe(200)
    const rec = await redis.hgetall<Record<string, unknown>>(REC)
    expect(rec?.description).toBe('A reading group that meets online every second Sunday.')
  })

  it('stores a plain description unchanged', async () => {
    const { redis, deps } = await setup()
    await handleCreateCheckout({ ...BODY, description: DESC }, deps)
    expect((await redis.hgetall<Record<string, unknown>>(REC))?.description).toBe(DESC)
  })

  it('never puts the description in Stripe params, metadata or setup_intent_data', async () => {
    const { deps, params } = await setup()
    await handleCreateCheckout({ ...BODY, description: DESC }, deps)
    expect(JSON.stringify(params())).not.toContain('reading group')
  })

  it('never logs the description', async () => {
    const { deps, logs } = await setup()
    await handleCreateCheckout({ ...BODY, description: DESC }, deps)
    expect(logs.join('\n')).not.toContain('reading group')
  })

  it('stores none for a description under 10 characters after cleaning, and still creates the checkout', async () => {
    const { redis, deps, create } = await setup()
    const r = await handleCreateCheckout({ ...BODY, description: '   short \u0000\u0000  ' }, deps)
    expect(r.status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await redis.hgetall<Record<string, unknown>>(REC)).not.toHaveProperty('description')
  })

  it('stores none for a description over 400 characters, and still creates the checkout', async () => {
    const { redis, deps, create } = await setup()
    const r = await handleCreateCheckout({ ...BODY, description: 'a'.repeat(401) }, deps)
    expect(r.status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
    expect(await redis.hgetall<Record<string, unknown>>(REC)).not.toHaveProperty('description')
  })

  it('accepts exactly 10 and exactly 400 characters', async () => {
    const a = await setup()
    await handleCreateCheckout({ ...BODY, description: 'abcdefghij' }, a.deps)
    expect((await a.redis.hgetall<Record<string, unknown>>(REC))?.description).toBe('abcdefghij')
    const b = await setup()
    await handleCreateCheckout({ ...BODY, description: 'b'.repeat(400) }, b.deps)
    expect((await b.redis.hgetall<Record<string, unknown>>(REC))?.description).toBe('b'.repeat(400))
  })

  it('stores none for a description that is not text, and does not refuse the checkout', async () => {
    const { redis, deps } = await setup()
    const r = await handleCreateCheckout({ ...BODY, description: { text: DESC } }, deps)
    expect(r.status).toBe(200)
    expect(await redis.hgetall<Record<string, unknown>>(REC)).not.toHaveProperty('description')
  })

  it('stores no description key when none is sent', async () => {
    const { redis, deps } = await setup()
    await handleCreateCheckout(BODY, deps)
    expect(await redis.hgetall<Record<string, unknown>>(REC)).not.toHaveProperty('description')
  })
})

describe('create-checkout, source', () => {
  it('never reads an email from the request body', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../server/utils/checkout.ts', import.meta.url), 'utf8')
    expect(src).not.toContain('body.email')
  })

  it('has no pilot card-collection setting left', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../server/utils/checkout.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/pilotPaymentMethodCollection|PAYMENT_METHOD_COLLECTION/)
  })
})

describe('create-checkout, refusals and replays (closed)', () => {
  it('a session record that has expired is refused like no session', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, SECRET, { email: INVITED, kind: 'pilot', wave: 'w1' })
    const sid = await createInvitedSession(redis, { inviteId, emailHmac: emailKey(SECRET, INVITED), email: INVITED })
    redis.advance(SESSION_TTL_SECONDS + 1)
    const session = await getInvitedSession(redis, sid)
    expect(session).toBeNull()
    const { create, deps, logs } = await setup({ session })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(404)
    expect(create).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toContain(INVITED)
  })

  it('an invite with status used is refused with the used message, and Stripe is not called', async () => {
    const { redis, session, create, deps, logs } = await setup()
    await redis.hset(inviteKey(session.emailHmac), { status: 'used' })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r).toEqual({ status: 409, body: { message: 'This invite has already been used to set up a site.' } })
    expect(INVITE_USED_MESSAGE).toBe('This invite has already been used to set up a site.')
    expect(create).not.toHaveBeenCalled()
    expect(redis.keys().filter(k => k.startsWith('signup:'))).toEqual([])
    expect(logs.join('\n')).not.toContain(INVITED)
  })

  it('an invite already claimed by a paid session is refused even if its status still reads open', async () => {
    const { redis, inviteId, create, deps } = await setup()
    await redis.set(`invite:u:${inviteId}`, 'cs_test_earlier', { nx: true })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(409)
    expect(create).not.toHaveBeenCalled()
  })

  it('a session whose invite is gone, or is another invite, is refused like no session', async () => {
    const gone = await setup()
    await gone.redis.del(inviteKey(gone.session.emailHmac))
    expect((await handleCreateCheckout(BODY, gone.deps)).status).toBe(404)
    expect(gone.create).not.toHaveBeenCalled()
    const other = await setup()
    const r = await handleCreateCheckout(BODY, { ...other.deps, session: { ...other.session, inviteId: 'some-other-invite-id' } })
    expect(r.status).toBe(404)
    expect(other.create).not.toHaveBeenCalled()
  })

  it('refusal logs never hold the email or a provision id', async () => {
    const used = await setup()
    await used.redis.hset(inviteKey(used.session.emailHmac), { status: 'used' })
    await handleCreateCheckout(BODY, used.deps)
    const none = await setup({ session: null })
    await handleCreateCheckout(BODY, none.deps)
    for (const logs of [used.logs, none.logs]) {
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.join('\n')).not.toContain(INVITED)
      expect(logs.join('\n')).not.toContain('AAAAAAAAAAAAAAAAAAAAAA')
    }
  })

  it('a successful invited checkout logs nothing with the email either', async () => {
    const { deps, logs } = await setup()
    await handleCreateCheckout(BODY, deps)
    expect(logs.join('\n')).not.toContain(INVITED)
  })
})

describe('create-checkout, launch open (unchanged)', () => {
  const OPEN_BODY = { ...BODY, email: 'buyer@example.com' }

  it('with no session it takes the email from the form, as before, without touching Redis', async () => {
    const { create, deps, params } = await setup({ open: true, session: null, redis: undefined })
    const r = await handleCreateCheckout(OPEN_BODY, deps)
    expect(r).toEqual({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay_1' } })
    expect(create).toHaveBeenCalledTimes(1)
    const metadata = { communityName: 'Repair Collective', subdomain: 'repair', email: 'buyer@example.com' }
    expect(params()).toEqual({
      mode: 'setup',
      currency: 'usd',
      customer_creation: 'always',
      customer_email: 'buyer@example.com',
      metadata,
      setup_intent_data: { metadata },
      success_url: `${ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ORIGIN}/cancel`
    })
  })

  it('with no session it still needs a valid email', async () => {
    const { create, deps } = await setup({ open: true, session: null, redis: undefined })
    for (const email of [undefined, '', 'not-an-email', 7]) {
      expect((await handleCreateCheckout({ ...BODY, email }, deps)).status).toBe(400)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('with an invited session the session email wins over the form, even while open', async () => {
    const { deps, params } = await setup({ open: true })
    await handleCreateCheckout({ ...BODY, email: 'buyer@example.com' }, deps)
    expect(params().customer_email).toBe(INVITED)
    expect(params().metadata.invited).toBe('true')
  })
})

// 23-20 follow-up (2026-11-08): checkout marks each Stripe session it creates,
// so /success can tell a session still waiting for its webhook from an id that
// is not ours (provision-status.test.ts).
describe('create-checkout marks the Stripe session it creates', () => {
  const withId = (url: string | null) => vi.fn(async (_params: unknown) => ({ id: 'cs_test_marked', url }))

  it('an invited checkout that gets a session writes checkout:{sessionId} for a day', async () => {
    const create = withId('https://checkout.stripe.com/c/pay_1')
    const { redis, deps } = await setup({ stripe: { checkout: { sessions: { create } } } })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(200)
    expect(await redis.exists(checkoutMarkerKey('cs_test_marked'))).toBe(1)
    expect(await redis.ttl(checkoutMarkerKey('cs_test_marked'))).toBe(86400)
    expect(JSON.stringify(await redis.hgetall(checkoutMarkerKey('cs_test_marked')))).not.toContain(INVITED)
  })

  it('a session with no URL, or a Stripe error, leaves no marker', async () => {
    const a = await setup({ stripe: { checkout: { sessions: { create: withId(null) } } } })
    expect((await handleCreateCheckout(BODY, a.deps)).status).toBe(500)
    expect(await a.redis.exists(checkoutMarkerKey('cs_test_marked'))).toBe(0)
    const failing = vi.fn(async (_params: unknown): Promise<{ id: string, url: string | null }> => { throw new Error('stripe down') })
    const b = await setup({ stripe: { checkout: { sessions: { create: failing } } } })
    await expect(handleCreateCheckout(BODY, b.deps)).rejects.toThrow()
    expect(b.redis.keys().filter(k => k.startsWith('checkout:'))).toEqual([])
  })

  it('a marker that cannot be written is logged with a fixed line and the checkout still goes ahead', async () => {
    const create = withId('https://checkout.stripe.com/c/pay_1')
    const { redis, deps, logs } = await setup({ stripe: { checkout: { sessions: { create } } } })
    const hset = redis.hset.bind(redis)
    redis.hset = async (key: string, fields: Record<string, unknown>) => {
      if (key.startsWith('checkout:')) throw new Error('upstash down')
      return hset(key, fields)
    }
    expect((await handleCreateCheckout(BODY, deps)).status).toBe(200)
    expect(logs).toContain('create-checkout: session not marked')
  })
})
