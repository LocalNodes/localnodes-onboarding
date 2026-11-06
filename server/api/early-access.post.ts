import { waitUntil } from '@vercel/functions'
import { handleEarlyAccess, addResendContact, allowRequest } from '../utils/early-access'

// Early-access list (server/utils/early-access.ts). The rate limit uses the
// Upstash Redis already wired for provisioning; if Redis isn't configured or
// fails, the limit fails open (the sign-up still works) and says so in the log.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  const ip = getRequestIP(event, { xForwardedFor: true })

  const outcome = await handleEarlyAccess(raw, ip, {
    configured: Boolean(config.resendApiKey && config.resendSegmentId),
    allow: async (ipHash) => {
      try {
        return await allowRequest(useRedis(), ipHash)
      } catch {
        console.warn('early-access: rate limit unavailable, allowing the request')
        return true
      }
    },
    addContact: contact => addResendContact(contact, config.resendApiKey, config.resendSegmentId, (url, opts) => $fetch(url, opts)),
    log: msg => console.warn(msg),
    // The reply doesn't wait for Resend. Nitro's event.waitUntil covers
    // runtimes that wire it; the Vercel node preset doesn't, so Vercel's own
    // waitUntil keeps the function alive there (a no-op elsewhere).
    keepAlive: (work) => {
      event.waitUntil(work)
      waitUntil(work)
    }
  })

  setResponseStatus(event, outcome.status)
  return outcome.body
})
