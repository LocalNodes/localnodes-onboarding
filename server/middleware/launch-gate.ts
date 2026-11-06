import { defineEventHandler, getRequestURL, sendRedirect, createError } from 'h3'
import { gateDecision, isLaunchOpen, EARLY_ACCESS_URL } from '../utils/launch'

// Runs before every server route and server-rendered page (see
// server/utils/launch.ts). The gated pages are server-rendered, not
// prerendered (nuxt.config.ts routeRules), so this middleware sees them.
export default defineEventHandler((event) => {
  const open = isLaunchOpen(useRuntimeConfig(event).launchOpen)
  const decision = gateDecision(getRequestURL(event).pathname, open)
  if (decision === 'not-found') {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  if (decision === 'redirect') {
    return sendRedirect(event, EARLY_ACCESS_URL, 302)
  }
})
