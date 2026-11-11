// Stripe webhook while the launch is closed, for invited sign-ups (Phase 23,
// plan 23-07, D-03, D-04). Real Stripe signing, offline; Redis is a fake. The
// closed-flag webhook acts only when the session metadata says invited AND the
// server re-check passes: the invite exists and is open, the paying email
// hashes to the invite's key, and the one-site-per-invite claim (SET NX) wins.
import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { FakeRedis } from './helpers/fake-redis'
import { addInvite, emailKey } from '../../server/utils/invites'
import { handleStripeWebhook, claimInvitedCheckout, recordSetupInRedis, type WebhookDeps } from '../../server/utils/stripe-webhook'
import { SIGNUP_TTL_SECONDS } from '../../server/utils/checkout'
import { triggerProvisioning } from '../../server/utils/provisioning'

const SECRET = 'whsec_test_secret'
const INVITE_SECRET = 'test-invite-hash-secret'
const stripe = new Stripe('sk_test_not_used')
const EMAIL = 'invited.person@example.com'
const OTHER = 'someone.else@example.org'
const PROVISION = 'AAAAAAAAAAAAAAAAAAAAAA'

interface EventOpts {
  email?: string | null
  customerEmail?: string | null
  metadata?: Record<string, string>
  paymentStatus?: string
  type?: string
  sessionId?: string
  /** Stripe's customer id on a setup session; null leaves it off. */
  customer?: string | null
  /** The saved card's SetupIntent id; null leaves it off. */
  setupIntent?: string | null
}

function makeEvent(inviteId: string, o: EventOpts = {}) {
  const session = {
    id: o.sessionId ?? 'cs_test_1',
    object: 'checkout.session',
    payment_status: o.paymentStatus ?? 'paid',
    customer_email: o.customerEmail === undefined ? EMAIL : o.customerEmail,
    customer_details: o.email === undefined ? { email: EMAIL } : (o.email === null ? null : { email: o.email }),
    metadata: o.metadata ?? { invited: 'true', invite_id: inviteId, provision_id: PROVISION, subdomain: 'repair', communityName: 'Repair Collective' },
    customer: o.customer === undefined ? 'cus_test_1' : o.customer,
    setup_intent: o.setupIntent === undefined ? 'seti_test_1' : o.setupIntent
  }
  const payload = JSON.stringify({ id: 'evt_test_1', object: 'event', type: o.type ?? 'checkout.session.completed', data: { object: session } })
  return { payload, sig: stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }) }
}

async function setup(over: { open?: boolean, isInvitedCheckout?: WebhookDeps['isInvitedCheckout'] | null, recordSetup?: WebhookDeps['recordSetup'] | null } = {}) {
  const redis = new FakeRedis()
  const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'pilot', wave: 'w1' })
  // The sign-up record create-checkout wrote, with a short life so a refresh shows.
  await redis.hset(`signup:${PROVISION}`, { subdomain: 'repair', communityName: 'Repair Collective' })
  await redis.expire(`signup:${PROVISION}`, 100)
  const logs: string[] = []
  // The real provisioning trigger sits behind the handler: its SET NX lock is what
  // makes a delivery that is claimed twice (a retry) start one workflow run, so the
  // tests count `dispatch` (workflow runs) as well as handler calls.
  const dispatch = vi.fn(async (_p: { subdomain: string, provisionId: string, attempt: number }) => ({ runId: 1, runUrl: 'https://example.test/run/1' }))
  const onCheckoutCompleted = vi.fn(async (s: Stripe.Checkout.Session) => {
    await triggerProvisioning({ id: s.id, metadata: s.metadata as { subdomain: string, provision_id?: string } }, { redis, dispatchProvisioningWorkflow: dispatch })
  })
  const deps: WebhookDeps = {
    open: over.open ?? false,
    constructEvent: (body, sig) => stripe.webhooks.constructEvent(body, sig, SECRET),
    onCheckoutCompleted,
    log: (m: string) => { logs.push(m) }
  }
  if (over.recordSetup !== null) deps.recordSetup = over.recordSetup ?? (s => recordSetupInRedis(redis, s))
  if (over.isInvitedCheckout !== null) {
    deps.isInvitedCheckout = over.isInvitedCheckout ?? (s => claimInvitedCheckout(redis, INVITE_SECRET, s))
  }
  const noLeak = () => {
    const all = logs.join('\n')
    expect(all).not.toContain(EMAIL)
    expect(all).not.toContain(OTHER)
    expect(all).not.toContain(inviteId)
    expect(all).not.toContain(PROVISION)
  }
  return { redis, inviteId, logs, deps, onCheckoutCompleted, dispatch, noLeak }
}

describe('stripe webhook, closed, invited checkout', () => {
  it('a signed completed event with invited metadata and a passing re-check provisions once; the same event again starts no second run', async () => {
    const { inviteId, deps, onCheckoutCompleted, dispatch, noLeak } = await setup()
    const { payload, sig } = makeEvent(inviteId)
    const first = await handleStripeWebhook(payload, sig, deps)
    expect(first).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(onCheckoutCompleted.mock.calls[0]![0].id).toBe('cs_test_1')
    expect(dispatch).toHaveBeenCalledTimes(1)
    // The claim is re-entrant for the same session (a retry must be able to finish),
    // so the second delivery passes it again; the provisioning lock stops the second run.
    const second = await handleStripeWebhook(payload, sig, deps)
    expect(second).toEqual({ status: 200, body: { received: true } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    noLeak()
  })

  it('claims the invite: invite:u:{id} holds the session id with no expiry, and the invite is marked used', async () => {
    const { redis, inviteId, deps } = await setup()
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(await redis.get(`invite:u:${inviteId}`)).toBe('cs_test_1')
    expect(await redis.ttl(`invite:u:${inviteId}`)).toBe(-1)
    const invite = await redis.hgetall<Record<string, unknown>>(`invite:e:${emailKey(INVITE_SECRET, EMAIL)}`)
    expect(invite?.status).toBe('used')
  })

  it('an email whose hash is not the invite\'s does nothing, and logs only the event type', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted, logs, noLeak } = await setup()
    const { payload, sig } = makeEvent(inviteId, { email: OTHER, customerEmail: OTHER })
    const r = await handleStripeWebhook(payload, sig, deps)
    expect(r).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(logs).toEqual(['stripe-webhook: launch closed, ignored checkout.session.completed'])
    expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
    noLeak()
  })

  it('a pilot with no payment (100% off) provisions: the payment status is never consulted', async () => {
    for (const status of ['no_payment_required', 'paid', 'unpaid']) {
      const { inviteId, deps, onCheckoutCompleted } = await setup()
      const { payload, sig } = makeEvent(inviteId, { paymentStatus: status })
      await handleStripeWebhook(payload, sig, deps)
      expect(onCheckoutCompleted, status).toHaveBeenCalledTimes(1)
    }
  })

  it('reads the paying email from customer_details first, then from customer_email', async () => {
    const a = await setup()
    const ev1 = makeEvent(a.inviteId, { email: EMAIL, customerEmail: null })
    await handleStripeWebhook(ev1.payload, ev1.sig, a.deps)
    expect(a.onCheckoutCompleted).toHaveBeenCalledTimes(1)
    const b = await setup()
    const ev2 = makeEvent(b.inviteId, { email: null, customerEmail: EMAIL })
    await handleStripeWebhook(ev2.payload, ev2.sig, b.deps)
    expect(b.onCheckoutCompleted).toHaveBeenCalledTimes(1)
    const c = await setup()
    const ev3 = makeEvent(c.inviteId, { email: null, customerEmail: null })
    await handleStripeWebhook(ev3.payload, ev3.sig, c.deps)
    expect(c.onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('prefers the email Stripe recorded for the payer (customer_details) over customer_email', async () => {
    const a = await setup()
    const ev1 = makeEvent(a.inviteId, { email: EMAIL, customerEmail: OTHER })
    await handleStripeWebhook(ev1.payload, ev1.sig, a.deps)
    expect(a.onCheckoutCompleted).toHaveBeenCalledTimes(1)
    const b = await setup()
    const ev2 = makeEvent(b.inviteId, { email: OTHER, customerEmail: EMAIL })
    await handleStripeWebhook(ev2.payload, ev2.sig, b.deps)
    expect(b.onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('metadata that does not say invited is ignored, even if the re-check would pass', async () => {
    const isInvitedCheckout = vi.fn(async () => 'claimed' as const)
    const { inviteId, deps, onCheckoutCompleted, logs } = await setup({ isInvitedCheckout })
    for (const metadata of [
      { invite_id: inviteId, subdomain: 'repair', communityName: 'Repair Collective' },
      { invited: 'false', invite_id: inviteId },
      { invited: 'yes', invite_id: inviteId },
      {}
    ]) {
      const { payload, sig } = makeEvent(inviteId, { metadata })
      const r = await handleStripeWebhook(payload, sig, deps)
      expect(r).toEqual({ status: 200, body: { received: true } })
    }
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(isInvitedCheckout).not.toHaveBeenCalled()
    expect(logs).toHaveLength(4)
  })

  it('invited metadata without an isInvitedCheckout dep is ignored', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await setup({ isInvitedCheckout: null })
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('a re-check that throws is an infrastructure error: 503 so Stripe retries, nothing dispatched, type-only log', async () => {
    const { inviteId, deps, onCheckoutCompleted, logs, noLeak } = await setup({ isInvitedCheckout: async () => { throw new Error(`redis down for ${EMAIL}`) } })
    const { payload, sig } = makeEvent(inviteId)
    const r = await handleStripeWebhook(payload, sig, deps)
    expect(r).toEqual({ status: 503, body: { error: 'Temporarily unavailable' } })
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(logs).toEqual(['stripe-webhook: infrastructure error during the invited re-check, Stripe will retry'])
    noLeak()
  })

  it('only checkout.session.completed can provision while closed', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await setup()
    for (const type of ['checkout.session.expired', 'invoice.paid', 'customer.subscription.created']) {
      const { payload, sig } = makeEvent(inviteId, { type })
      expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    }
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('a forged signature gets 400 and nothing happens', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted } = await setup()
    const { payload } = makeEvent(inviteId)
    const r = await handleStripeWebhook(payload, 't=1,v1=deadbeef', deps)
    expect(r.status).toBe(400)
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
  })
})

describe('stripe webhook, setup session (T-3, 23-31)', () => {
  it('stores the customer and the saved card on signup:{provisionId} before provisioning starts, and refreshes its life', async () => {
    const { redis, inviteId, deps, noLeak } = await setup()
    let seenAtDispatch: Record<string, unknown> | null = null
    const dispatch = vi.fn(async (_s: Stripe.Checkout.Session) => { seenAtDispatch = await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`) })
    deps.onCheckoutCompleted = dispatch
    const { payload, sig } = makeEvent(inviteId)
    expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(seenAtDispatch).toMatchObject({ stripeCustomerId: 'cus_test_1', setupIntentId: 'seti_test_1', subdomain: 'repair' })
    expect(await redis.ttl(`signup:${PROVISION}`)).toBe(SIGNUP_TTL_SECONDS)
    noLeak()
  })

  it('a completed session with no customer or no setup_intent provisions nothing, claims nothing, answers 200 and logs the message only', async () => {
    for (const o of [{ customer: null }, { setupIntent: null }, { customer: null, setupIntent: null }]) {
      const { redis, inviteId, deps, onCheckoutCompleted, logs, noLeak } = await setup()
      const { payload, sig } = makeEvent(inviteId, o)
      expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
      expect(onCheckoutCompleted).not.toHaveBeenCalled()
      expect(logs).toEqual(['stripe-webhook: setup session without a customer or saved card, nothing provisioned'])
      expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
      expect(await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`)).not.toHaveProperty('stripeCustomerId')
      noLeak()
    }
  })

  it('an expanded customer object is not a string id, so it counts as missing', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await setup()
    const { payload } = makeEvent(inviteId)
    const tampered = payload.replace('"cus_test_1"', '{"id":"cus_test_1"}')
    const sig = stripe.webhooks.generateTestHeaderString({ payload: tampered, secret: SECRET })
    await handleStripeWebhook(tampered, sig, deps)
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('a sign-up record that is gone (expired) provisions nothing and logs without ids', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted, logs, noLeak } = await setup()
    await redis.del(`signup:${PROVISION}`)
    const { payload, sig } = makeEvent(inviteId)
    expect(await handleStripeWebhook(payload, sig, deps)).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(logs).toEqual(['stripe-webhook: no sign-up record for the setup session, nothing provisioned'])
    expect(await redis.hgetall(`signup:${PROVISION}`)).toBeNull()
    noLeak()
  })

  it('with the launch open, a session that has a provision id is recorded too, then provisioned', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted } = await setup({ open: true })
    const { payload, sig } = makeEvent(inviteId)
    await handleStripeWebhook(payload, sig, deps)
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(await redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`)).toMatchObject({ stripeCustomerId: 'cus_test_1', setupIntentId: 'seti_test_1' })
  })

  it('with the launch open, a session with no provision id is not recorded (the old public flow) and still provisions', async () => {
    const recordSetup = vi.fn(async () => true)
    const { inviteId, deps } = await setup({ open: true, recordSetup })
    // No provision id: the real trigger would refuse it, so the handler is a plain mock here.
    const onCheckoutCompleted = vi.fn(async (_s: Stripe.Checkout.Session) => {})
    deps.onCheckoutCompleted = onCheckoutCompleted
    const { payload, sig } = makeEvent(inviteId, { metadata: { subdomain: 'repair', communityName: 'Repair Collective' } })
    await handleStripeWebhook(payload, sig, deps)
    expect(recordSetup).not.toHaveBeenCalled()
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
  })
})

describe('stripe webhook, closed, replays and mismatches', () => {
  it('an event whose invite_id names another invite does nothing, and claims nothing', async () => {
    const { redis, inviteId, deps, onCheckoutCompleted, noLeak } = await setup()
    const { inviteId: otherId } = await addInvite(redis, INVITE_SECRET, { email: OTHER, kind: 'wave', wave: 'w2' })
    const { payload, sig } = makeEvent(inviteId, { metadata: { invited: 'true', invite_id: otherId, provision_id: PROVISION } })
    const r = await handleStripeWebhook(payload, sig, deps)
    expect(r).toEqual({ status: 200, body: { received: true } })
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
    expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
    expect(await redis.get(`invite:u:${otherId}`)).toBeNull()
    noLeak()
  })

  it('a replay after the invite was used does nothing, even from a different session id', async () => {
    const { inviteId, deps, onCheckoutCompleted } = await setup()
    const a = makeEvent(inviteId, { sessionId: 'cs_test_first' })
    await handleStripeWebhook(a.payload, a.sig, deps)
    const b = makeEvent(inviteId, { sessionId: 'cs_test_second' })
    await handleStripeWebhook(b.payload, b.sig, deps)
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(onCheckoutCompleted.mock.calls[0]![0].id).toBe('cs_test_first')
  })

  it('a forged event gets 400 and does not consult the re-check', async () => {
    const isInvitedCheckout = vi.fn(async () => 'claimed' as const)
    const { inviteId, deps, onCheckoutCompleted } = await setup({ isInvitedCheckout })
    const { payload } = makeEvent(inviteId)
    expect((await handleStripeWebhook(payload, 't=1,v1=deadbeef', deps)).status).toBe(400)
    expect((await handleStripeWebhook(payload.replace('repair', 'other'), makeEvent(inviteId).sig, deps)).status).toBe(400)
    expect(isInvitedCheckout).not.toHaveBeenCalled()
    expect(onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('with the launch open the re-check is not consulted and every completed checkout provisions, as before', async () => {
    const isInvitedCheckout = vi.fn(async () => 'refused' as const)
    const { inviteId, deps } = await setup({ open: true, isInvitedCheckout })
    const onCheckoutCompleted = vi.fn(async (_s: Stripe.Checkout.Session) => {})
    deps.onCheckoutCompleted = onCheckoutCompleted
    const { payload, sig } = makeEvent(inviteId, { metadata: { subdomain: 'repair', communityName: 'Repair Collective' } })
    expect((await handleStripeWebhook(payload, sig, deps)).status).toBe(200)
    expect(onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect(isInvitedCheckout).not.toHaveBeenCalled()
  })
})

describe('claimInvitedCheckout', () => {
  const sessionFor = (inviteId: string, over: Record<string, unknown> = {}) => ({
    id: 'cs_test_1',
    customer_email: EMAIL,
    customer_details: { email: EMAIL },
    metadata: { invited: 'true', invite_id: inviteId },
    ...over
  }) as unknown as Stripe.Checkout.Session

  it('two deliveries at the same moment: exactly one wins the claim (SET NX)', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    const results = await Promise.all([
      claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { id: 'cs_a' })),
      claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { id: 'cs_b' }))
    ])
    expect([...results].sort()).toEqual(['claimed', 'refused'])
  })

  it('a claim already held by another session blocks, even with the invite still open', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    await redis.set(`invite:u:${inviteId}`, 'cs_other', { nx: true })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('refused')
    expect(await redis.get(`invite:u:${inviteId}`)).toBe('cs_other')
  })

  it('an invite that is not open (used) blocks', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    await redis.hset(`invite:e:${emailKey(INVITE_SECRET, EMAIL)}`, { status: 'used' })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('refused')
    expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
  })

  it('an address that is not on the invite list blocks', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    const s = sessionFor(inviteId, { customer_email: OTHER, customer_details: { email: OTHER } })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, s)).toBe('refused')
  })

  it('a missing invite id or a missing email blocks; an empty secret is a configuration error that throws (503, Stripe retries), never a claim', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { metadata: { invited: 'true' } }))).toBe('refused')
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { customer_email: null, customer_details: null }))).toBe('refused')
    await expect(claimInvitedCheckout(redis, '', sessionFor(inviteId))).rejects.toThrow('not configured')
    expect(await redis.get(`invite:u:${inviteId}`)).toBeNull()
  })

  it('a claim already held by the same session is its own: the same session claims again, before and after the invite was marked used', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('claimed')
    // The first call marked the invite used; a retried event must still finish.
    expect((await redis.hgetall<Record<string, unknown>>(`invite:e:${emailKey(INVITE_SECRET, EMAIL)}`))?.status).toBe('used')
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('claimed')
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { id: 'cs_other' }))).toBe('refused')
  })

  it('a claim held by this session while the invite still reads open (the mark failed) is its own too', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    await redis.set(`invite:u:${inviteId}`, 'cs_test_1', { nx: true })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('claimed')
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId, { id: 'cs_other' }))).toBe('refused')
  })

  it('an invite with any status but open or used is refused, even with the claim key naming this session', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    await redis.hset(`invite:e:${emailKey(INVITE_SECRET, EMAIL)}`, { status: 'revoked' })
    await redis.set(`invite:u:${inviteId}`, 'cs_test_1', { nx: true })
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('refused')
  })

  it('a Redis error is thrown, not read as a refusal: on the invite read, on the claim, and on the claim re-read', async () => {
    const boom = () => { throw new Error(`redis down for ${EMAIL}`) }
    const read = new FakeRedis()
    const { inviteId } = await addInvite(read, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    read.hgetall = async () => boom()
    await expect(claimInvitedCheckout(read, INVITE_SECRET, sessionFor(inviteId))).rejects.toThrow('redis down')
    const claim = new FakeRedis()
    const b = await addInvite(claim, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    claim.set = async () => boom()
    await expect(claimInvitedCheckout(claim, INVITE_SECRET, sessionFor(b.inviteId))).rejects.toThrow('redis down')
    const reread = new FakeRedis()
    const c = await addInvite(reread, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    await reread.set(`invite:u:${c.inviteId}`, 'cs_other', { nx: true })
    reread.get = async () => boom()
    await expect(claimInvitedCheckout(reread, INVITE_SECRET, sessionFor(c.inviteId))).rejects.toThrow('redis down')
  })

  it('a failure to mark the invite used does not undo the claim', async () => {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: EMAIL, kind: 'wave', wave: 'w2' })
    const hset = redis.hset.bind(redis)
    let failed = false
    redis.hset = async (key: string, fields: Record<string, unknown>) => {
      if (fields.status === 'used') { failed = true; throw new Error('redis down') }
      return hset(key, fields)
    }
    expect(await claimInvitedCheckout(redis, INVITE_SECRET, sessionFor(inviteId))).toBe('claimed')
    expect(failed).toBe(true)
    expect(await redis.get(`invite:u:${inviteId}`)).toBe('cs_test_1')
  })
})

describe('stripe webhook, Redis down at an invited checkout (ruling: Stripe retries; T-23-82)', () => {
  const OK = { status: 200, body: { received: true } }
  const BUSY = { status: 503, body: { error: 'Temporarily unavailable' } }
  const INFRA_LOG = 'stripe-webhook: infrastructure error during the invited re-check, Stripe will retry'

  it('a real refusal answers 200 and provisions nothing: not invited, payer hash with no invite, invite not open, invite id mismatch, claimed by another session', async () => {
    const cases: Array<[string, (c: Awaited<ReturnType<typeof setup>>) => Promise<{ payload: string, sig: string }>]> = [
      ['metadata not invited', async c => makeEvent(c.inviteId, { metadata: { invite_id: c.inviteId, subdomain: 'repair' } })],
      ['payer hash with no invite', async c => makeEvent(c.inviteId, { email: OTHER, customerEmail: OTHER })],
      ['invite not open', async (c) => { await c.redis.hset(`invite:e:${emailKey(INVITE_SECRET, EMAIL)}`, { status: 'used' }); return makeEvent(c.inviteId) }],
      ['invite id mismatch', async c => makeEvent(c.inviteId, { metadata: { invited: 'true', invite_id: 'some-other-invite', provision_id: PROVISION } })],
      ['claimed by another session', async (c) => { await c.redis.set(`invite:u:${c.inviteId}`, 'cs_other', { nx: true }); return makeEvent(c.inviteId) }]
    ]
    for (const [name, build] of cases) {
      const c = await setup()
      const { payload, sig } = await build(c)
      expect(await handleStripeWebhook(payload, sig, c.deps), name).toEqual(OK)
      expect(c.onCheckoutCompleted, name).not.toHaveBeenCalled()
      expect(c.dispatch, name).not.toHaveBeenCalled()
      c.noLeak()
    }
  })

  it('Redis throwing on the invite read answers 503 and dispatches nothing', async () => {
    const c = await setup()
    c.redis.hgetall = async () => { throw new Error(`redis down for ${EMAIL}`) }
    const { payload, sig } = makeEvent(c.inviteId)
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(BUSY)
    expect(c.onCheckoutCompleted).not.toHaveBeenCalled()
    expect(c.dispatch).not.toHaveBeenCalled()
    expect(c.logs).toEqual([INFRA_LOG])
    c.noLeak()
  })

  it('Redis throwing on the claim SET answers 503 and dispatches nothing', async () => {
    const c = await setup()
    c.redis.set = async () => { throw new Error('redis down') }
    const { payload, sig } = makeEvent(c.inviteId)
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(BUSY)
    expect(c.onCheckoutCompleted).not.toHaveBeenCalled()
    expect(c.logs).toEqual([INFRA_LOG])
    c.noLeak()
  })

  it('recordSetup throwing answers 503 and dispatches nothing', async () => {
    const c = await setup({ recordSetup: async () => { throw new Error(`redis down for ${EMAIL}`) } })
    const { payload, sig } = makeEvent(c.inviteId)
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(BUSY)
    expect(c.onCheckoutCompleted).not.toHaveBeenCalled()
    expect(c.dispatch).not.toHaveBeenCalled()
    expect(c.logs).toEqual([INFRA_LOG])
    c.noLeak()
  })

  it('after a 503 because recordSetup failed (claim already held), the same event with Redis working provisions exactly once', async () => {
    const c = await setup()
    const working = c.deps.recordSetup!
    c.deps.recordSetup = vi.fn(async () => { throw new Error('redis down') })
    const { payload, sig } = makeEvent(c.inviteId)
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(BUSY)
    // The claim and the used mark landed before recordSetup failed.
    expect(await c.redis.get(`invite:u:${c.inviteId}`)).toBe('cs_test_1')
    c.deps.recordSetup = working
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(OK)
    expect(c.dispatch).toHaveBeenCalledTimes(1)
    expect(await c.redis.hgetall<Record<string, unknown>>(`signup:${PROVISION}`)).toMatchObject({ stripeCustomerId: 'cus_test_1' })
    // And a third delivery starts nothing more.
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(OK)
    expect(c.dispatch).toHaveBeenCalledTimes(1)
  })

  it('after a 503 on the claim SET, the same event with Redis working provisions exactly once', async () => {
    const c = await setup()
    const set = c.redis.set.bind(c.redis)
    let down = true
    c.redis.set = (async (...args: Parameters<typeof set>) => {
      if (down && String(args[0]).startsWith('invite:u:')) throw new Error('redis down')
      return set(...args)
    }) as typeof c.redis.set
    const { payload, sig } = makeEvent(c.inviteId)
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(BUSY)
    down = false
    expect(await handleStripeWebhook(payload, sig, c.deps)).toEqual(OK)
    expect(c.dispatch).toHaveBeenCalledTimes(1)
  })

  it('two deliveries of the same event at the same moment dispatch exactly one workflow run', async () => {
    const c = await setup()
    const { payload, sig } = makeEvent(c.inviteId)
    const results = await Promise.all([handleStripeWebhook(payload, sig, c.deps), handleStripeWebhook(payload, sig, c.deps)])
    expect(results).toEqual([OK, OK])
    expect(c.dispatch).toHaveBeenCalledTimes(1)
  })

  it('two different sessions for one invite: only the first provisions, the second is a refusal answered 200', async () => {
    const c = await setup()
    const a = makeEvent(c.inviteId, { sessionId: 'cs_test_a' })
    const b = makeEvent(c.inviteId, { sessionId: 'cs_test_b' })
    const results = await Promise.all([handleStripeWebhook(a.payload, a.sig, c.deps), handleStripeWebhook(b.payload, b.sig, c.deps)])
    expect(results).toEqual([OK, OK])
    expect(c.dispatch).toHaveBeenCalledTimes(1)
  })

  it('logs stay type-only in every branch, 503 included', async () => {
    const c = await setup({ recordSetup: async () => { throw new Error(`redis down for ${EMAIL} ${PROVISION}`) } })
    const { payload, sig } = makeEvent(c.inviteId)
    await handleStripeWebhook(payload, sig, c.deps)
    const d = await setup()
    const refused = makeEvent(d.inviteId, { email: OTHER, customerEmail: OTHER })
    await handleStripeWebhook(refused.payload, refused.sig, d.deps)
    for (const x of [c, d]) {
      expect(x.logs.length).toBeGreaterThan(0)
      x.noLeak()
    }
  })
})
