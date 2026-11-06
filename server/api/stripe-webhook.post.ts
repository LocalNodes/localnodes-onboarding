import type Stripe from 'stripe'
import { triggerProvisioning } from '../utils/provisioning'
import { dispatchProvisioningWorkflow } from '../utils/github'
import { handleStripeWebhook } from '../utils/stripe-webhook'
import { isLaunchOpen } from '../utils/launch'

// Logic in server/utils/stripe-webhook.ts. While the launch is closed a
// verified event gets 200 and no action (the route isn't gated to 404).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)

  const outcome = await handleStripeWebhook(await readRawBody(event), getHeader(event, 'stripe-signature'), {
    open: isLaunchOpen(config.launchOpen),
    constructEvent: (body, signature) => useStripe().webhooks.constructEvent(body, signature, config.stripeWebhookSecret),
    log: msg => console.log(msg),
    onCheckoutCompleted: async (session: Stripe.Checkout.Session) => {
      console.log('Checkout session completed:', { sessionId: session.id, subscriptionId: session.subscription })
      const { alreadyProcessing } = await triggerProvisioning(
        {
          id: session.id,
          metadata: session.metadata as { subdomain: string, communityName: string, email: string },
          customer_email: session.customer_email || ''
        },
        { redis: useRedis(), dispatchProvisioningWorkflow }
      )
      if (alreadyProcessing) {
        console.log('Provisioning already in progress for session:', session.id)
      }
    }
  })

  if (outcome.status !== 200) {
    throw createError({ status: outcome.status, statusText: outcome.body.error })
  }
  return outcome.body
})
