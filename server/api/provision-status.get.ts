import { waitUntil } from '@vercel/functions'
import { handleProvisionStatus } from '../utils/provision-handlers'
import { makeBillingDeps, makeStopDeps } from '../utils/billing-wiring'
import { INVITE_COOKIE, sha256 } from '../utils/invites'

// Logic in server/utils/provision-handlers.ts. A read can make a site's own
// "failed" final once its 10-minute window has passed (23-14). When that is the
// second failure, the stop starts here: no other callback may come. The stop
// runs in the background through both waitUntil calls (the Vercel node preset
// doesn't wire event.waitUntil), and Stripe is read only when a stop runs. A
// sign-up in ready nudges its first payment or activation (23-32), at most once
// per 10 seconds, in the background; the reply does not wait for it.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const query = getQuery(event)
  const sessionId = query.session_id as string | undefined
  const redis = useRedis()
  const keepAlive = (work: Promise<void>) => {
    event.waitUntil(work)
    waitUntil(work)
  }
  // The stop deps carry the app delete (23-37): a build-failure stop asks for it too.
  // The request's own invited session, hashed as checkout hashes it (23-18):
  // on a held sign-up only the browser that made it may confirm (23-37).
  const invite = getCookie(event, INVITE_COOKIE)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return handleProvisionStatus(sessionId, redis, {
    ...makeStopDeps(config, keepAlive),
    requestHash: invite ? sha256(invite) : null,
    billing: makeBillingDeps(config, keepAlive)
  })
})
