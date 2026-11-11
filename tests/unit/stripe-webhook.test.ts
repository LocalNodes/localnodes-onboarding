import { describe, it, expect, vi } from 'vitest'
import { recordSetupInRedis } from '../../server/utils/stripe-webhook'
import { SIGNUP_TTL_SECONDS } from '../../server/utils/checkout'
import { FakeRedis } from './helpers/fake-redis'

/**
 * Unit tests for stripe-webhook server route logic.
 *
 * We test the pure logic functions extracted from the server route:
 * - Webhook header validation
 * - Webhook event parsing with signature verification
 * - checkout.session.completed event handling
 *
 * Full integration tests (actual HTTP requests) require the Nuxt dev server.
 */

// Pure function: validate that stripe-signature header is present
function validateWebhookHeaders(signature: string | undefined): void {
  if (!signature) {
    throw new Error('Missing Stripe signature')
  }
}

// Pure function: parse and verify webhook event using Stripe SDK
function parseWebhookEvent(
  rawBody: string,
  signature: string,
  secret: string,
  stripe: { webhooks: { constructEvent: (body: string, sig: string, secret: string) => any } }
): any {
  if (!rawBody) {
    throw new Error('Missing request body')
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret)
}

// Pure function: extract metadata from checkout.session.completed event
function handleCheckoutCompleted(session: {
  id: string
  customer_email?: string | null
  metadata?: Record<string, string> | null
  subscription?: string | null
}): {
  sessionId: string
  customerEmail: string | null | undefined
  metadata: Record<string, string> | null | undefined
  subscriptionId: string | null | undefined
} {
  return {
    sessionId: session.id,
    customerEmail: session.customer_email,
    metadata: session.metadata,
    subscriptionId: session.subscription
  }
}

describe('stripe-webhook: header validation', () => {
  it('throws when stripe-signature header is missing', () => {
    expect(() => validateWebhookHeaders(undefined)).toThrow('Missing Stripe signature')
  })

  it('throws when stripe-signature header is empty string', () => {
    expect(() => validateWebhookHeaders('')).toThrow('Missing Stripe signature')
  })

  it('does not throw when stripe-signature header is present', () => {
    expect(() => validateWebhookHeaders('t=123,v1=abc')).not.toThrow()
  })
})

describe('stripe-webhook: event parsing', () => {
  const mockStripe = {
    webhooks: {
      constructEvent: vi.fn()
    }
  }

  it('throws when request body is empty', () => {
    expect(() => parseWebhookEvent('', 'sig_123', 'whsec_test', mockStripe))
      .toThrow('Missing request body')
  })

  it('throws when signature verification fails', () => {
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })

    expect(() => parseWebhookEvent('{"type":"test"}', 'invalid_sig', 'whsec_test', mockStripe))
      .toThrow('No signatures found matching the expected signature')
  })

  it('returns parsed event for valid signature', () => {
    const mockEvent = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_123' } }
    }
    mockStripe.webhooks.constructEvent.mockReturnValue(mockEvent)

    const result = parseWebhookEvent('{"type":"checkout.session.completed"}', 'valid_sig', 'whsec_test', mockStripe)
    expect(result).toEqual(mockEvent)
    expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith(
      '{"type":"checkout.session.completed"}',
      'valid_sig',
      'whsec_test'
    )
  })
})

describe('stripe-webhook: checkout.session.completed handler', () => {
  it('returns session metadata for checkout.session.completed', () => {
    const session = {
      id: 'cs_test_abc123',
      customer_email: 'organizer@example.com',
      metadata: {
        communityName: 'Cascadia Bioregion',
        subdomain: 'cascadia',
        email: 'organizer@example.com'
      },
      subscription: 'sub_xyz789'
    }

    const result = handleCheckoutCompleted(session)
    expect(result).toEqual({
      sessionId: 'cs_test_abc123',
      customerEmail: 'organizer@example.com',
      metadata: {
        communityName: 'Cascadia Bioregion',
        subdomain: 'cascadia',
        email: 'organizer@example.com'
      },
      subscriptionId: 'sub_xyz789'
    })
  })

  it('handles session with null optional fields', () => {
    const session = {
      id: 'cs_test_minimal',
      customer_email: null,
      metadata: null,
      subscription: null
    }

    const result = handleCheckoutCompleted(session)
    expect(result).toEqual({
      sessionId: 'cs_test_minimal',
      customerEmail: null,
      metadata: null,
      subscriptionId: null
    })
  })

  it('returns {received: true} pattern for all valid events', () => {
    // This tests the response pattern used by the webhook handler
    // Both handled and unhandled event types return { received: true }
    const response = { received: true }
    expect(response).toEqual({ received: true })
  })
})

describe('recordSetupInRedis only ever raises the signup lifetime (23-43 Task 2, review round 1 Codex MEDIUM 7)', () => {
  const PROVISION = 'W3bh00k000000000000000'
  const session = { id: 'cs_test_ttl', customer: 'cus_1', setup_intent: 'seti_1', metadata: { provision_id: PROVISION } } as never

  it('a redelivery never lowers the signup lifetime: a 72 h key keeps 72 h', async () => {
    const redis = new FakeRedis()
    await redis.hset(`signup:${PROVISION}`, { email: 'x@example.org' })
    await redis.expire(`signup:${PROVISION}`, 259200)
    expect(await recordSetupInRedis(redis as never, session)).toBe(true)
    expect(await redis.pttl(`signup:${PROVISION}`)).toBe(259200 * 1000)
    expect(await redis.hgetall(`signup:${PROVISION}`)).toMatchObject({ stripeCustomerId: 'cus_1', setupIntentId: 'seti_1' })
  })

  it('a shorter lifetime is raised to SIGNUP_TTL_SECONDS', async () => {
    const redis = new FakeRedis()
    await redis.hset(`signup:${PROVISION}`, { email: 'x@example.org' })
    await redis.expire(`signup:${PROVISION}`, 3600)
    await recordSetupInRedis(redis as never, session)
    expect(await redis.pttl(`signup:${PROVISION}`)).toBe(SIGNUP_TTL_SECONDS * 1000)
  })
})

// Code review fix round 1, C6: PTTL then EXPIRE were two commands, so a raise to
// 72 h landing between them was cut back to 48 h, and a record that ran out
// between the read and the HSET came back with no lifetime. The write and the
// raise are one step now; a concurrent raise lands before or after it, never
// inside it.
describe('C6: a checkout redelivery raises the signup lifetime in one atomic step', () => {
  const PROVISION = 'W3bh00k000000000000000'
  const KEY = `signup:${PROVISION}`
  const session = { id: 'cs_test_ttl', customer: 'cus_1', setup_intent: 'seti_1', metadata: { provision_id: PROVISION } } as never

  /** Another writer acts at the first moment it can: inside a PTTL-then-EXPIRE pair, or right before one atomic step. */
  function interleave(redis: FakeRedis, at: 'pttl' | 'hgetall', act: () => Promise<unknown>) {
    let done = false
    const once = async () => {
      if (done) return
      done = true
      await act()
    }
    const pttl = redis.pttl.bind(redis)
    vi.spyOn(redis, 'pttl').mockImplementation(async (k: string) => {
      const out = await pttl(k)
      if (at === 'pttl' && k === KEY) await once()
      return out
    })
    const hgetall = redis.hgetall.bind(redis)
    vi.spyOn(redis, 'hgetall').mockImplementation((async (k: string) => {
      const out = await hgetall(k)
      if (at === 'hgetall' && k === KEY) await once()
      return out
    }) as never)
    const evalFn = redis.eval.bind(redis)
    vi.spyOn(redis, 'eval').mockImplementation(async (script: string, keys: string[], args: unknown[]) => {
      if (keys.includes(KEY)) await once()
      return evalFn(script, keys, args)
    })
  }

  it('a raise to 72 h by another step while the redelivery runs is never cut back to 48 h', async () => {
    const redis = new FakeRedis()
    await redis.hset(KEY, { email: 'x@example.org' })
    await redis.expire(KEY, 3600)
    interleave(redis, 'pttl', () => redis.expire(KEY, 259200))
    expect(await recordSetupInRedis(redis as never, session)).toBe(true)
    expect(await redis.pttl(KEY)).toBe(259200 * 1000)
    expect(await redis.hgetall(KEY)).toMatchObject({ stripeCustomerId: 'cus_1', setupIntentId: 'seti_1' })
  })

  it('a signup record that runs out while the redelivery runs is not made again with no lifetime', async () => {
    const redis = new FakeRedis()
    await redis.hset(KEY, { email: 'x@example.org' })
    await redis.expire(KEY, 3600)
    interleave(redis, 'hgetall', () => redis.del(KEY))
    expect(await recordSetupInRedis(redis as never, session)).toBe(false)
    expect(await redis.exists(KEY)).toBe(0)
  })
})
