export default defineEventHandler(async (event) => {
  const signature = getHeader(event, 'stripe-signature')
  if (!signature) {
    throw createError({ status: 400, statusText: 'Missing Stripe signature' })
  }

  const rawBody = await readRawBody(event)
  if (!rawBody) {
    throw createError({ status: 400, statusText: 'Missing request body' })
  }

  const config = useRuntimeConfig()
  const stripe = useStripe()

  let stripeEvent
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message)
    throw createError({ status: 400, statusText: 'Invalid webhook signature' })
  }

  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object
      console.log('Checkout session completed:', {
        sessionId: session.id,
        customerEmail: session.customer_email,
        metadata: session.metadata,
        subscriptionId: session.subscription
      })
      // Phase 15 will add: trigger provisioning via GitHub Actions
      break
    }
    default:
      console.log(`Unhandled event type: ${stripeEvent.type}`)
  }

  return { received: true }
})
