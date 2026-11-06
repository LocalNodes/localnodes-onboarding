import { handleEarlyAccess, addResendContact, RATE_LIMIT } from '../utils/early-access'

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
        const redis = useRedis()
        const key = `rl:early-access:${ipHash}`
        const count = await redis.incr(key)
        if (count === 1) await redis.expire(key, RATE_LIMIT.windowSeconds)
        return count <= RATE_LIMIT.max
      } catch {
        console.warn('early-access: rate limit unavailable, allowing the request')
        return true
      }
    },
    addContact: contact => addResendContact(contact, config.resendApiKey, config.resendSegmentId, (url, opts) => $fetch(url, opts)),
    log: msg => console.warn(msg)
  })

  setResponseStatus(event, outcome.status)
  return outcome.body
})
