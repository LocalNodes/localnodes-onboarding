import { waitUntil } from '@vercel/functions'
import { handleEarlyAccess, addResendContact, earlyAccessLimiter } from '../utils/early-access'
import { trustedClientIp } from '../utils/client-ip'

// Early-access list (server/utils/early-access.ts). The rate limit uses the
// Upstash Redis already wired for provisioning. It fails closed: if Redis isn't
// configured or can't be reached, the request gets the generic 503 and nothing
// goes to Resend (security follow-up, 2026-11-09). The limit keys on the IP
// Vercel's proxy sets (server/utils/client-ip.ts), not on X-Forwarded-For.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  const ip = trustedClientIp(event.headers, event.node.req.socket?.remoteAddress)

  const outcome = await handleEarlyAccess(raw, ip, {
    configured: Boolean(config.resendApiKey && config.resendSegmentId),
    allow: earlyAccessLimiter(() => useRedis()),
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
