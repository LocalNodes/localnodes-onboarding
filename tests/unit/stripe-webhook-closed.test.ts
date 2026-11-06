// Stripe webhook while the launch is closed (orchestrator ruling, 2026-11-06,
// PR #9). Uses the real Stripe SDK to sign and verify events offline.
import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { handleStripeWebhook } from '../../server/utils/stripe-webhook'

const SECRET = 'whsec_test_secret'
const stripe = new Stripe('sk_test_not_used')
const EMAIL = 'organizer@example.com'

const payload = JSON.stringify({
  id: 'evt_test_1',
  object: 'event',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_test_1', object: 'checkout.session', customer_email: EMAIL, metadata: { subdomain: 'repair', communityName: 'Repair Collective', email: EMAIL }, subscription: 'sub_1' } }
})

const signed = () => stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET })

function deps(open: boolean) {
  const logs: string[] = []
  return {
    logs,
    open,
    constructEvent: (body: string, sig: string) => stripe.webhooks.constructEvent(body, sig, SECRET),
    onCheckoutCompleted: vi.fn(async () => {}),
    log: (m: string) => { logs.push(m) }
  }
}

describe('stripe webhook, launch closed', () => {
  it('a valid signed checkout.session.completed returns 200 and creates nothing', async () => {
    const d = deps(false)
    const r = await handleStripeWebhook(payload, signed(), d)
    expect(r).toEqual({ status: 200, body: { received: true } })
    expect(d.onCheckoutCompleted).not.toHaveBeenCalled()
    expect(d.logs).toEqual(['stripe-webhook: launch closed, ignored checkout.session.completed'])
    expect(d.logs.join('\n')).not.toContain(EMAIL)
  })

  it('an invalid signature still gets 400 and creates nothing', async () => {
    const d = deps(false)
    const r = await handleStripeWebhook(payload, 't=1,v1=deadbeef', d)
    expect(r.status).toBe(400)
    expect(d.onCheckoutCompleted).not.toHaveBeenCalled()
  })

  it('a tampered body with a valid-looking signature gets 400', async () => {
    const d = deps(false)
    const r = await handleStripeWebhook(payload.replace('repair', 'other'), signed(), d)
    expect(r.status).toBe(400)
  })

  it('a missing signature or body gets 400', async () => {
    expect((await handleStripeWebhook(payload, undefined, deps(false))).status).toBe(400)
    expect((await handleStripeWebhook(undefined, signed(), deps(false))).status).toBe(400)
  })
})

describe('stripe webhook, launch open', () => {
  it('a valid signed checkout.session.completed starts provisioning', async () => {
    const d = deps(true)
    const r = await handleStripeWebhook(payload, signed(), d)
    expect(r.status).toBe(200)
    expect(d.onCheckoutCompleted).toHaveBeenCalledTimes(1)
    expect((d.onCheckoutCompleted.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe('cs_test_1')
  })
})
