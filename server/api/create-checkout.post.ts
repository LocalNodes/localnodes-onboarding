import * as v from 'valibot'

const bodySchema = v.object({
  communityName: v.pipe(v.string(), v.minLength(3), v.maxLength(50)),
  email: v.pipe(v.string(), v.email()),
  subdomain: v.pipe(v.string(), v.minLength(3), v.maxLength(63))
})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, input => v.parse(bodySchema, input))
  const config = useRuntimeConfig()
  const stripe = useStripe()

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: body.email,
    line_items: [
      {
        price: config.stripePriceId,
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
    success_url: `${getRequestURL(event).origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${getRequestURL(event).origin}/onboarding`
  })

  if (!session.url) {
    throw createError({
      status: 500,
      statusText: 'Failed to create checkout session'
    })
  }

  return { url: session.url }
})
