import Stripe from 'stripe'
import { stripeHttpClient } from './stripe-deadline'

let _stripe: Stripe | null = null

export function useStripe(): Stripe {
  if (!_stripe) {
    const config = useRuntimeConfig()
    if (!config.stripeSecretKey) {
      throw new Error('NUXT_STRIPE_SECRET_KEY environment variable is not set')
    }
    // The fetch client with the deadline-aware fetch (23-43 code review fix round 1, C3): a call
    // under stripeCall is aborted at its deadline; every other call is sent as before.
    _stripe = new Stripe(config.stripeSecretKey, { httpClient: stripeHttpClient() })
  }
  return _stripe
}
