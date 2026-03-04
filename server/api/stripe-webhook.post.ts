import type Stripe from 'stripe'
import { triggerProvisioning } from '../utils/provisioning'
import { dispatchProvisioningWorkflow } from '../utils/github'

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

  let stripeEvent: Stripe.Event
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret)
  } catch (err) {
    console.error('Webhook signature verification failed:', (err as Error).message)
    throw createError({ status: 400, statusText: 'Invalid webhook signature' })
  }

  switch (stripeEvent.type) {
    case 'checkout.session.completed': {
      const session = stripeEvent.data.object as Stripe.Checkout.Session
      console.log('Checkout session completed:', {
        sessionId: session.id,
        customerEmail: session.customer_email,
        metadata: session.metadata,
        subscriptionId: session.subscription
      })

      const redis = useRedis()
      const { alreadyProcessing } = await triggerProvisioning(
        {
          id: session.id,
          metadata: session.metadata as { subdomain: string; communityName: string; email: string },
          customer_email: session.customer_email || ''
        },
        { redis, dispatchProvisioningWorkflow }
      )

      if (alreadyProcessing) {
        console.log('Provisioning already in progress for session:', session.id)
      }

      break
    }
    default:
      console.log(`Unhandled event type: ${stripeEvent.type}`)
  }

  return { received: true }
})
