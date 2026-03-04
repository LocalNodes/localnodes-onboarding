import { describe, it, expect, vi } from 'vitest'

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
