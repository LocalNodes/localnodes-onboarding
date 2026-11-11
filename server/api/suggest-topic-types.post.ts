import { defineEventHandler, getCookie, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { INVITE_COOKIE, getInvitedSession } from '../utils/invites'
import { hashIp } from '../utils/early-access'
import { suggestTopicTypes } from '../utils/topic-types'
import { trustedClientIp } from '../utils/client-ip'

// Suggests page types from a short community description (D-19, D-20). Gated
// by server/middleware/launch-gate.ts (invited sessions only while closed);
// the util checks for an invited session again. The logic is in
// server/utils/topic-types.ts. The per-IP limit keys on the IP Vercel's proxy
// sets (server/utils/client-ip.ts), not on X-Forwarded-For.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const raw = await readBody(event).catch(() => null)
  const redis = useRedis()

  // No invited session, or a Redis that can't answer, means no inviteId: the util answers 404 and calls nothing.
  let inviteId: string | null = null
  try {
    inviteId = (await getInvitedSession(redis, getCookie(event, INVITE_COOKIE)))?.inviteId ?? null
  } catch {
    inviteId = null
  }

  const outcome = await suggestTopicTypes(raw, {
    fetch: (url, init) => fetch(url, init),
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    inviteId,
    ipHash: hashIp(trustedClientIp(event.headers, event.node.req.socket?.remoteAddress)),
    redis,
    timeoutMs: 8000,
    log: msg => console.warn(msg)
  })

  setResponseStatus(event, outcome.status)
  return outcome.body
})
