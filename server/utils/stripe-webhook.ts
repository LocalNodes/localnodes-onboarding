// Stripe webhook logic (plain module, testable without Nitro). Pre-launch
// (orchestrator ruling, 2026-11-06, PR #9): while NUXT_LAUNCH_OPEN is closed
// the route stays reachable, so Stripe never sees failures and never disables
// the endpoint. The signature is still verified (invalid: 400); a valid event
// gets 200 and NO action, no provisioning and no Redis writes, and only its
// type is logged.
import type Stripe from 'stripe'

export interface WebhookDeps {
  open: boolean
  constructEvent: (body: string, signature: string) => Stripe.Event
  onCheckoutCompleted: (session: Stripe.Checkout.Session) => Promise<void>
  log: (msg: string) => void
}

export type WebhookOutcome =
  | { status: 200, body: { received: true } }
  | { status: 400, body: { error: string } }

export async function handleStripeWebhook(rawBody: string | undefined, signature: string | undefined, deps: WebhookDeps): Promise<WebhookOutcome> {
  if (!signature) return { status: 400, body: { error: 'Missing Stripe signature' } }
  if (!rawBody) return { status: 400, body: { error: 'Missing request body' } }

  let stripeEvent: Stripe.Event
  try {
    stripeEvent = deps.constructEvent(rawBody, signature)
  } catch {
    deps.log('stripe-webhook: signature verification failed')
    return { status: 400, body: { error: 'Invalid webhook signature' } }
  }

  if (!deps.open) {
    deps.log(`stripe-webhook: launch closed, ignored ${stripeEvent.type}`)
    return { status: 200, body: { received: true } }
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    await deps.onCheckoutCompleted(stripeEvent.data.object as Stripe.Checkout.Session)
  } else {
    deps.log(`stripe-webhook: unhandled event type ${stripeEvent.type}`)
  }
  return { status: 200, body: { received: true } }
}
