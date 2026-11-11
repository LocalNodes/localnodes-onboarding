import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { waitUntil } from '@vercel/functions'
import { handleInviteRequest, sendInviteMail } from '../../utils/invites'
import { trustedClientIp } from '../../utils/client-ip'

// Asks for a sign-in link (server/utils/invites.ts). Not gated. Every valid
// request gets the same reply, whether or not the address is invited. The
// limit keys on the IP Vercel's proxy sets (server/utils/client-ip.ts).
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  const ip = trustedClientIp(event.headers, event.node.req.socket?.remoteAddress)

  const outcome = await handleInviteRequest(raw, ip, {
    redis: useRedis(),
    secret: config.inviteHashSecret,
    sendMail: mail => sendInviteMail(
      mail,
      { apiKey: config.resendApiKey, from: config.mailFrom, unsubscribeSecret: config.inviteHashSecret },
      (url, opts) => $fetch(url, opts as Parameters<typeof $fetch>[1])
    ),
    log: msg => console.warn(msg),
    // The Vercel node preset doesn't wire event.waitUntil, so both calls
    // keep the work alive (the same as early-access.post.ts).
    keepAlive: (work) => {
      event.waitUntil(work)
      waitUntil(work)
    }
  })

  setResponseStatus(event, outcome.status)
  return outcome.body
})
