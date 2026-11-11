import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { waitUntil } from '@vercel/functions'
import { dispatchProvisioningWorkflow } from '../utils/github'
import { isLaunchOpen } from '../utils/launch'
import { handleRetryRequest } from '../utils/retry-stop'
import { makeStopDeps } from '../utils/billing-wiring'

// Logic in server/utils/retry-stop.ts. Gated (shared/launch.ts GATED_API):
// while the launch is closed only a live invited session reaches it. The gate
// middleware looks the ln_invite cookie up and leaves the answer in
// event.context.invited; the handler checks it again. The Stripe session id
// comes from the body; the retry reuses it, so no new checkout is ever made.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  // A retry whose dispatch fails is the second failure, and stops the sign-up;
  // the stop deps carry the app delete (23-37).
  const keepAlive = (work: Promise<void>) => {
    event.waitUntil(work)
    waitUntil(work)
  }
  const outcome = await handleRetryRequest(raw, {
    ...makeStopDeps(config, keepAlive),
    open: isLaunchOpen(config.launchOpen),
    invited: event.context.invited === true,
    dispatch: dispatchProvisioningWorkflow
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})
