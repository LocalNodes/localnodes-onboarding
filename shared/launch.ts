// Pre-launch gate: until launch the paid sign-up flow stays in the code but is
// unreachable: its pages redirect to the early-access form and its
// API routes return 404 (the Stripe webhook answers but acts on nothing). One server-side flag opens it: runtimeConfig
// `launchOpen`, set by the env var NUXT_LAUNCH_OPEN (default closed).
// Plain module, no Nitro or Nuxt globals: shared by the server middleware
// (server/middleware/launch-gate.ts) and the client route middleware
// (app/middleware/launch-gate.global.ts), and imported directly by tests.

/** Sign-up pages: redirect to the early-access form while closed. */
export const GATED_PAGES = ['/onboarding', '/success', '/cancel']

/** Sign-up API routes: 404 while closed, unless the request has a live invited session. */
export const GATED_API = [
  '/api/create-checkout',
  '/api/check-subdomain',
  '/api/provision-status',
  '/api/check-code',
  '/api/capacity',
  '/api/suggest-topic-types',
  '/api/ai-key',
  '/api/retry-provisioning',
  '/api/price',
  // The owner-only redirect to Stripe's payment page for a held sign-up (23-37).
  '/api/confirm-payment'
]
// Not gated, on purpose:
// - /api/stripe-webhook stays reachable while closed, verifies the signature
//   and takes no action (server/utils/stripe-webhook.ts), so Stripe never logs
//   failures against a live endpoint.
// - /api/provision-callback must reach the app while closed: a provisioning
//   run started before the gate closed has to report back, or its buyer is
//   stuck. It proves itself with its own per-provision bearer check (23-11),
//   not with the gate (Phase 23 research, Pitfall 3).
// - /api/provision-manifest, /api/provision-manifest/ack and /api/capacity-report
//   are called by the server side (workflow, VPS) with their own bearer secrets.
// - /api/invite/request, /api/invite/verify and /api/early-access are how a
//   person gets in or onto the list, so they stay open.
// - /api/cron/sweep is posted by the QStash schedule every 5 minutes (23-38). It
//   proves itself with QStash's signature (server/utils/cron-sweep.ts), and it
//   must run while closed, because invited sign-ups happen then.
// - /api/teardown-check and /api/teardown-result are called by
//   teardown-instance.yml (23-36, 23-37) with the per-provision bearer, which
//   they check before any read; a teardown must finish while closed.
// - /api/relayer-funding (GET and POST) is called by
//   fund-practice-relayer.yml with its own per-provision
//   bearer, checked before any read; practice sites are funded while closed.

export const EARLY_ACCESS_URL = '/#early-access'

/** The flag is open only when set to true ("true" or "1" from an env var). */
export function isLaunchOpen(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1
}

function matches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?')
}

/**
 * What the gate does with a request path. `invited` is true only when the
 * server found a live invited session for the request (Phase 23, D-03): the
 * server middleware sets it from the ln_invite cookie. Left out, it is false,
 * so the two-argument call decides exactly as it did before invites.
 */
export function gateDecision(path: string, open: boolean, invited = false): 'pass' | 'redirect' | 'not-found' {
  if (open || invited) return 'pass'
  const p = path.replace(/\/+$/, '') || '/'
  const lower = p.toLowerCase()
  if (GATED_API.some(a => matches(lower, a))) return 'not-found'
  if (GATED_PAGES.some(a => matches(lower, a))) return 'redirect'
  return 'pass'
}
