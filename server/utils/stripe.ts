import Stripe from 'stripe'

let _stripe: Stripe | null = null

export function useStripe(): Stripe {
  if (!_stripe) {
    const config = useRuntimeConfig()
    if (!config.stripeSecretKey) {
      throw new Error('NUXT_STRIPE_SECRET_KEY environment variable is not set')
    }
    _stripe = new Stripe(config.stripeSecretKey)
  }
  return _stripe
}
