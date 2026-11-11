import { defineEventHandler, getCookie, readBody, setResponseStatus } from 'h3'
import { handleCheckCode } from '../utils/check-code'
import { isPaidSignupsEnabled } from '../utils/checkout'
import { getInvitedSession, INVITE_COOKIE, type InviteRecord } from '../utils/invites'

// Logic in server/utils/check-code.ts. Gated while the launch is closed
// (shared/launch.ts), and it answers only for a live invited session (the
// ln_invite cookie, looked up server-side): the code is checked for that
// invite and held for it. Not for the public flow.
export default defineEventHandler(async (event) => {
  const raw = await readBody(event).catch(() => null)
  let session: InviteRecord | null = null
  const sid = getCookie(event, INVITE_COOKIE)
  if (sid) {
    try {
      session = await getInvitedSession(useRedis(), sid)
    } catch {
      session = null
    }
  }
  const outcome = await handleCheckCode(raw, {
    session,
    stripe: useStripe(),
    redis: useRedis(),
    paidSignupsEnabled: isPaidSignupsEnabled(useRuntimeConfig(event).paidSignupsEnabled),
    log: msg => console.warn(msg)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})
