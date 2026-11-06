// Pre-launch gate (Tom, 2026-11-06, PR #9): LocalNodes launches only when
// funds and votes are complete. Until then the paid sign-up flow stays in the
// code but is unreachable: its pages redirect to the early-access form and its
// API routes return 404. One server-side flag opens it: runtimeConfig
// `launchOpen`, set by the env var NUXT_LAUNCH_OPEN (default closed).
// Plain module, no Nitro globals, so tests import it directly.

/** Sign-up pages: redirect to the early-access form while closed. */
export const GATED_PAGES = ['/onboarding', '/success', '/cancel']

/** Sign-up API routes: 404 while closed. */
export const GATED_API = [
  '/api/create-checkout',
  '/api/check-subdomain',
  '/api/provision-status',
  '/api/provision-callback',
  '/api/stripe-webhook'
]

export const EARLY_ACCESS_URL = '/#early-access'

/** The flag is open only when set to true ("true" or "1" from an env var). */
export function isLaunchOpen(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')
}

/** What the gate does with a request path. */
export function gateDecision(path: string, open: boolean): 'pass' | 'redirect' | 'not-found' {
  if (open) return 'pass'
  const p = path.replace(/\/+$/, '') || '/'
  const lower = p.toLowerCase()
  if (GATED_API.some(a => matches(lower, a))) return 'not-found'
  if (GATED_PAGES.some(a => matches(lower, a))) return 'redirect'
  return 'pass'
}
