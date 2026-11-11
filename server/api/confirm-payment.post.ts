import { defineEventHandler, getCookie, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { handleConfirmPayment } from '../utils/teardown'
import { INVITE_COOKIE, sha256 } from '../utils/invites'

// POST /api/confirm-payment (23-37; Tom's answer 3, T-23-188). The held
// screen's "Confirm my payment" is a plain form POST with session_id (JSON
// works too), so the hosted invoice URL is in no page's HTML, the owner's
// included, and it works with scripts off. Logic in server/utils/teardown.ts:
// only the browser whose ln_invite cookie hashes to the sign-up's
// ownerSessionHash gets a 303 to Stripe's hosted page; everyone else gets 404
// with no URL. Gated (shared/launch.ts GATED_API): while the launch is closed
// only a live invited session reaches it. Nothing here is logged.
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null) as { session_id?: unknown } | null
  const cookie = getCookie(event, INVITE_COOKIE)
  // Redis is built only once the handler needs it: a request with no session
  // is answered 404 without touching the store.
  const outcome = await handleConfirmPayment(body?.session_id, cookie ? sha256(cookie) : null, {
    redis: { hgetall: key => useRedis().hgetall(key) }
  })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
  if (outcome.status === 303) {
    setResponseHeader(event, 'Location', outcome.location)
    setResponseStatus(event, 303)
    return ''
  }
  setResponseStatus(event, 404)
  return outcome.body
})
