import { defineEventHandler, getRequestURL, getCookie, sendRedirect, createError } from 'h3'
import { gateDecision, isLaunchOpen, EARLY_ACCESS_URL } from '../utils/launch'
import { getInvitedSession, invitedDetails, INVITE_COOKIE } from '../utils/invites'
import { serverLaunchOpen } from '#shared/launch-claims.mjs'

// Runs before every server route and server-rendered page (see
// server/utils/launch.ts). The gated pages are server-rendered, not
// prerendered (nuxt.config.ts routeRules), so this middleware sees them.
//
// Invited people (Phase 23, D-03): when a request would be refused, the
// httpOnly ln_invite cookie is looked up in Redis. Only a live server-side
// session lets the request through; the browser can't claim to be invited, and
// any Redis trouble counts as not invited. Requests the gate already passes
// never touch Redis.
export default defineEventHandler(async (event) => {
  // A production server stays closed while a home page promise is pending
  // (shared/launch-claims.mjs), even with the flag set when it starts.
  const open = serverLaunchOpen(isLaunchOpen(useRuntimeConfig(event).launchOpen), { dev: import.meta.dev })
  const path = getRequestURL(event).pathname
  let decision = gateDecision(path, open)
  if (decision !== 'pass') {
    let invited = false
    const sid = getCookie(event, INVITE_COOKIE)
    if (sid) {
      try {
        const session = await getInvitedSession(useRedis(), sid)
        invited = session !== null
        // The sign-up form shows the invited address (read-only) and fills in
        // the invite's code (23-19). Only these two fields are copied, for the
        // SSR plugin (app/plugins/invited-state.server.ts); the server never
        // reads them back, and every gated route re-checks the cookie.
        if (session) event.context.invitedDetails = invitedDetails(session)
      } catch {
        invited = false
      }
    }
    event.context.invited = invited
    decision = gateDecision(path, open, invited)
  }
  if (decision === 'not-found') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  if (decision === 'redirect') {
    return sendRedirect(event, EARLY_ACCESS_URL, 302)
  }
})
