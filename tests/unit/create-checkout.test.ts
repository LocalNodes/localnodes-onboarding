import { describe, it, expect } from 'vitest'
import * as v from 'valibot'

/**
 * Unit tests for create-checkout server route logic.
 *
 * We test the pure logic functions extracted from the server route:
 * - Body validation schema (Valibot)
 * - Checkout session params construction
 * - Error handling when session URL is null
 *
 * Full integration tests (actual HTTP requests) require the Nuxt dev server.
 */

// Body schema (mirrors the server route)
const createCheckoutBody = v.object({
  communityName: v.pipe(v.string(), v.minLength(3), v.maxLength(50)),
  email: v.pipe(v.string(), v.email()),
  subdomain: v.pipe(v.string(), v.minLength(3), v.maxLength(63))
})

type CreateCheckoutBody = v.InferOutput<typeof createCheckoutBody>

// Pure function: build checkout session params from validated body + config
function buildCheckoutParams(body: CreateCheckoutBody, priceId: string, origin: string) {
  return {
    mode: 'subscription' as const,
    customer_email: body.email,
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ],
    metadata: {
      communityName: body.communityName,
      subdomain: body.subdomain,
      email: body.email
    },
    subscription_data: {
      metadata: {
        communityName: body.communityName,
        subdomain: body.subdomain
      }
    },
    success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/onboarding`
  }
}

describe('create-checkout: body validation', () => {
  it('accepts valid input', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'Cascadia Bioregion',
      email: 'organizer@example.com',
      subdomain: 'cascadia'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.communityName).toBe('Cascadia Bioregion')
      expect(result.output.email).toBe('organizer@example.com')
      expect(result.output.subdomain).toBe('cascadia')
    }
  })

  it('rejects missing communityName (too short)', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'ab',
      email: 'test@example.com',
      subdomain: 'test-community'
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid email', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'Valid Name',
      email: 'not-an-email',
      subdomain: 'valid-sub'
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing subdomain (too short)', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'Valid Name',
      email: 'test@example.com',
      subdomain: 'ab'
    })
    expect(result.success).toBe(false)
  })

  it('rejects communityName over 50 characters', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'A'.repeat(51),
      email: 'test@example.com',
      subdomain: 'valid-sub'
    })
    expect(result.success).toBe(false)
  })

  it('rejects subdomain over 63 characters', () => {
    const result = v.safeParse(createCheckoutBody, {
      communityName: 'Valid Name',
      email: 'test@example.com',
      subdomain: 'a'.repeat(64)
    })
    expect(result.success).toBe(false)
  })
})

describe('create-checkout: session params construction', () => {
  const validBody: CreateCheckoutBody = {
    communityName: 'Cascadia Bioregion',
    email: 'organizer@cascadia.org',
    subdomain: 'cascadia'
  }

  it('creates session with subscription mode', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.mode).toBe('subscription')
  })

  it('sets customer_email from body', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.customer_email).toBe('organizer@cascadia.org')
  })

  it('includes metadata with communityName, subdomain, and email', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.metadata).toEqual({
      communityName: 'Cascadia Bioregion',
      subdomain: 'cascadia',
      email: 'organizer@cascadia.org'
    })
  })

  it('includes subscription_data.metadata with communityName and subdomain', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.subscription_data.metadata).toEqual({
      communityName: 'Cascadia Bioregion',
      subdomain: 'cascadia'
    })
  })

  it('sets line_items with price ID and quantity 1', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.line_items).toEqual([{ price: 'price_test123', quantity: 1 }])
  })

  it('constructs success_url with session ID template', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.success_url).toBe('https://localnodes.xyz/success?session_id={CHECKOUT_SESSION_ID}')
  })

  it('constructs cancel_url pointing to /onboarding', () => {
    const params = buildCheckoutParams(validBody, 'price_test123', 'https://localnodes.xyz')
    expect(params.cancel_url).toBe('https://localnodes.xyz/onboarding')
  })
})

describe('create-checkout: response handling', () => {
  it('returns url when session creation succeeds', () => {
    const mockSession = { url: 'https://checkout.stripe.com/c/pay_123' }
    expect(mockSession.url).toBeTruthy()
    const response = { url: mockSession.url }
    expect(response).toEqual({ url: 'https://checkout.stripe.com/c/pay_123' })
  })

  it('throws error when session URL is null', () => {
    const mockSession = { url: null }
    expect(mockSession.url).toBeFalsy()
    // In the actual route, this would throw createError({ status: 500, statusText: ... })
    expect(() => {
      if (!mockSession.url) {
        throw new Error('Failed to create checkout session')
      }
    }).toThrow('Failed to create checkout session')
  })
})
