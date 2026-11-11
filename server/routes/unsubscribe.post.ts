import { defineEventHandler, getQuery, readBody, setResponseHeader, setResponseStatus } from 'h3'
import { handleUnsubscribe } from '../utils/unsubscribe'

// POST /unsubscribe?t=<token> (fresh3 23-19, ruling R5, RFC 8058). The mail
// client's one-click POST (body List-Unsubscribe=One-Click) and the page's
// button both land here; there is no confirmation page. Not gated: someone on
// the early-access list must be able to leave it while the launch is closed.
// The token alone decides; the body is read only so the request completes.
// Logic in server/utils/unsubscribe.ts. A GET of /unsubscribe never reaches
// this file (it is POST only), so opening the link removes nothing.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  await readBody(event).catch(() => null)
  const t = getQuery(event).t
  const outcome = await handleUnsubscribe(typeof t === 'string' ? t : '', {
    secret: config.inviteHashSecret,
    apiKey: config.resendApiKey,
    segmentId: config.resendSegmentId,
    fetch: (url, opts) => $fetch(url, opts),
    log: msg => console.warn(msg)
  })
  setResponseStatus(event, outcome.status)
  return outcome.body
})
