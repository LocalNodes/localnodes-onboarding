// Pre-launch gate (Tom, 2026-11-06, PR #9). Runs the real middleware module in
// an h3 app, in front of a stand-in checkout route that would create a Stripe
// session: while the flag is closed, a direct POST never reaches it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { gateDecision, isLaunchOpen, GATED_API, GATED_PAGES } from '../../server/utils/launch'

let launchOpen: unknown = false
let reached = 0

async function app() {
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ launchOpen })
  const { default: gate } = await import('../../server/middleware/launch-gate')
  const a = createApp()
  a.use(gate)
  const r = createRouter()
  r.post('/api/create-checkout', defineEventHandler(() => { reached++; return { url: 'https://checkout.stripe.com/x' } }))
  r.get('/onboarding', defineEventHandler(() => { reached++; return 'onboarding page' }))
  r.get('/', defineEventHandler(() => 'landing'))
  r.post('/api/early-access', defineEventHandler(() => ({ ok: true })))
  a.use(r)
  return toWebHandler(a)
}

const post = (path: string) => new Request(`http://localhost${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ communityName: 'Repair Collective', email: 'a@example.com', subdomain: 'repair' })
})

beforeEach(() => { reached = 0; launchOpen = false })
afterEach(() => { delete (globalThis as Record<string, unknown>).useRuntimeConfig })

describe('launch gate (middleware)', () => {
  it('refuses a direct POST to checkout while the flag is closed', async () => {
    const res = await (await app())(post('/api/create-checkout'))
    expect(res.status).toBe(404)
    expect(reached).toBe(0)
  })

  it('refuses it with a trailing slash or different case too', async () => {
    const h = await app()
    expect((await h(post('/api/create-checkout/'))).status).toBe(404)
    expect((await h(post('/API/Create-Checkout'))).status).toBe(404)
    expect(reached).toBe(0)
  })

  it('redirects /onboarding to the early-access form while closed', async () => {
    const res = await (await app())(new Request('http://localhost/onboarding'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/#early-access')
    expect(reached).toBe(0)
  })

  it('leaves the landing page and the early-access route open', async () => {
    const h = await app()
    expect((await h(new Request('http://localhost/'))).status).toBe(200)
    expect((await h(post('/api/early-access'))).status).toBe(200)
  })

  it('lets checkout through only when NUXT_LAUNCH_OPEN is "true"', async () => {
    launchOpen = 'true'
    const res = await (await app())(post('/api/create-checkout'))
    expect(res.status).toBe(200)
    expect(reached).toBe(1)
  })
})

describe('launch gate (decision)', () => {
  it('is closed by default and for anything but true', () => {
    for (const v of [false, undefined, '', 'false', '0', 'yes', 0]) expect(isLaunchOpen(v)).toBe(false)
    for (const v of [true, 'true', '1', 1]) expect(isLaunchOpen(v)).toBe(true)
  })

  it.each(GATED_API)('%s is not found while closed', (p) => {
    expect(gateDecision(p, false)).toBe('not-found')
  })

  it.each(GATED_PAGES)('%s redirects while closed', (p) => {
    expect(gateDecision(p, false)).toBe('redirect')
  })

  it('does not catch look-alike paths', () => {
    expect(gateDecision('/onboardingx', false)).toBe('pass')
    expect(gateDecision('/api/early-access', false)).toBe('pass')
    // The webhook is handled in its route while closed (200, no action).
    expect(gateDecision('/api/stripe-webhook', false)).toBe('pass')
  })
})
