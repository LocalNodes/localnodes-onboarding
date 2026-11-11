import { defineEventHandler, readBody, setCookie, setResponseHeader, setResponseStatus } from 'h3'
import { handleInviteVerify, INVITE_COOKIE, SESSION_TTL_SECONDS } from '../../utils/invites'

// Consumes the one-time token (server/utils/invites.ts) and sets the invited
// session cookie. The link only shows a page; this POST is what spends the
// token, so a mail scanner that opens the link can't burn it. Not gated.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const raw = await readBody(event).catch(() => null)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const outcome = await handleInviteVerify(raw, { redis: useRedis(), secret: config.inviteHashSecret })
  if (outcome.sessionId) {
    setCookie(event, INVITE_COOKIE, outcome.sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS
    })
  }
  setResponseStatus(event, outcome.status)
  return outcome.body
})
