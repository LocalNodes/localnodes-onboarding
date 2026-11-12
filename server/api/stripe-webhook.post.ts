import type Stripe from 'stripe'
import { waitUntil } from '@vercel/functions'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { generateCommunitySeed } from '../utils/community-seed'
import { triggerProvisioning } from '../utils/provisioning'
import { dispatchProvisioningWorkflow } from '../utils/github'
import { claimInvitedCheckout, handleStripeWebhook, recordSetupInRedis } from '../utils/stripe-webhook'
import { isLaunchOpen } from '../utils/launch'
import { rearmSessionHold, releaseSessionHold } from '../utils/promo'
import { rearmSessionCapacity, releaseSessionCapacity } from '../utils/capacity'
import { releaseSessionKey } from '../utils/byo-key'
import { forgetCheckout } from '../utils/checkout-marker'
import { routeInvoiceEvent } from '../utils/billing'
import { makeBillingDeps } from '../utils/billing-wiring'
import { recordLateContinuation, type LateSession } from '../utils/pilot-late'

// Logic in server/utils/stripe-webhook.ts. While the launch is closed a
// verified event gets 200 and no action (the route isn't gated to 404), except
// an invited checkout that passes the server re-check (invite open, email
// matches, one claim per invite). A Redis or other infrastructure error in that
// re-check answers 503, so Stripe retries instead of the organizer being lost.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)

  const outcome = await handleStripeWebhook(await readRawBody(event), getHeader(event, 'stripe-signature'), {
    open: isLaunchOpen(config.launchOpen),
    constructEvent: (body, signature) => useStripe().webhooks.constructEvent(body, signature, config.stripeWebhookSecret),
    log: msg => console.log(msg),
    isInvitedCheckout: session => claimInvitedCheckout(useRedis(), config.inviteHashSecret, session),
    recordSetup: session => recordSetupInRedis(useRedis(), session),
    rearmHold: session => rearmSessionHold(useRedis(), session),
    releaseHold: session => releaseSessionHold(useRedis(), session),
    releaseCapacity: session => releaseSessionCapacity(useRedis(), session),
    releaseAiKey: session => releaseSessionKey(useRedis(), session),
    releaseCheckoutMarker: session => forgetCheckout(useRedis(), session),
    rearmCapacity: session => rearmSessionCapacity(useRedis(), session),
    // invoice.paid for a first invoice activates; renewals get the card mail (23-32).
    onInvoice: async (stripeEvent) => {
      const billing = makeBillingDeps(config)
      await routeInvoiceEvent(stripeEvent, { ...billing.deps, onRenewalProblem: billing.onRenewalProblem })
    },
    // A late yes's payment page was paid: keep the new subscription on the pilot's record.
    onLateCompleted: async (session) => {
      const from = session.metadata?.pilot_continued_from
      if (!from) return
      const redis = useRedis()
      await recordLateContinuation({ get: key => redis.get(key), set: (key, value, opts) => redis.set(key, value, opts as never), del: (...keys) => redis.del(...keys) }, from, session as unknown as LateSession, Math.floor(Date.now() / 1000), msg => console.log(msg))
    },
    onCheckoutCompleted: async (session: Stripe.Checkout.Session) => {
      console.log('Checkout session completed:', { sessionId: session.id, subscriptionId: session.subscription })
      const { alreadyProcessing } = await triggerProvisioning(
        {
          id: session.id,
          metadata: session.metadata as { subdomain: string, provision_id?: string }
        },
        { redis: useRedis(), dispatchProvisioningWorkflow }
      )
      if (alreadyProcessing) {
        console.log('Provisioning already in progress for session:', session.id)
      }
      // The four first texts for the new site (23-33, T-2), made in the
      // background: the reply does not wait for Gemini. The Vercel node preset
      // doesn't wire event.waitUntil, so both calls keep the work alive. A
      // repeated event finds the stored seed or the lock and calls nothing.
      const provisionId = session.metadata?.provision_id
      if (provisionId && PROVISION_ID_PATTERN.test(provisionId)) {
        const work = generateCommunitySeed(provisionId, {
          fetch: (url, init) => fetch(url, init),
          redis: useRedis(),
          apiKey: config.geminiApiKey,
          model: config.geminiModel,
          timeoutMs: 15000,
          log: msg => console.warn(msg)
        }).catch(() => console.log('community-seed: failed'))
        event.waitUntil(work)
        waitUntil(work)
      }
    }
  })

  if (outcome.status !== 200) {
    throw createError({ status: outcome.status, statusText: outcome.body.error })
  }
  return outcome.body
})
