import { waitUntil } from '@vercel/functions'
import { handleProvisionCallback } from '../utils/provision-handlers'
import { makeBillingDeps, makeStopDeps } from '../utils/billing-wiring'

// Logic in server/utils/provision-handlers.ts; a "failed" goes on to
// server/utils/retry-stop.ts (23-14). A second failure stops the sign-up in the
// background: it releases the code hold, detaches the saved card and sends one
// mail. The Vercel node preset doesn't wire event.waitUntil, so both calls keep
// that work alive (the same as early-access.post.ts). Stripe is read only when
// a stop or a charge runs. A "ready" starts the first payment in the background
// (23-32, server/utils/billing.ts); the site gets its answer at once.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const authHeader = getHeader(event, 'authorization')
  const body = await readBody(event)
  const redis = useRedis()
  const keepAlive = (work: Promise<void>) => {
    event.waitUntil(work)
    waitUntil(work)
  }
  // The stop deps carry the app delete (23-37): a build-failure stop asks for it too.
  return handleProvisionCallback(authHeader, body, config, redis, {
    ...makeStopDeps(config, keepAlive),
    billing: makeBillingDeps(config, keepAlive)
  })
})
