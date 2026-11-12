// Pre-launch gate (Tom, 2026-11-06, PR #9). Runs the real middleware module in
// an h3 app, in front of a stand-in checkout route that would create a Stripe
// session: while the flag is closed, a direct POST never reaches it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { readFileSync } from 'node:fs'
import { gateDecision, isLaunchOpen, GATED_API, GATED_PAGES } from '../../shared/launch'
import { FakeRedis } from './helpers/fake-redis'
import { createInvitedSession, INVITE_COOKIE } from '../../server/utils/invites'

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

  it('stays closed with NUXT_LAUNCH_OPEN "true" while a home page promise is pending (a closed build started with the flag set)', async () => {
    launchOpen = 'true'
    const h = await app()
    expect((await h(new Request('http://localhost/api/price'))).status).toBe(404)
    expect((await h(post('/api/create-checkout'))).status).toBe(404)
    const res = await h(new Request('http://localhost/onboarding'))
    expect(res.status).toBe(302)
    expect(reached).toBe(0)
  })

  it('lets checkout through with NUXT_LAUNCH_OPEN "true" once every promise is ready', async () => {
    vi.resetModules()
    vi.doMock('../../shared/launch-claims.mjs', async (orig) => {
      const real = await orig<typeof import('../../shared/launch-claims.mjs')>()
      return { ...real, LAUNCH_CLAIMS: real.LAUNCH_CLAIMS.map(c => ({ ...c, ready: true })), serverLaunchOpen: (open: boolean, o: { dev: boolean | undefined }) => real.serverLaunchOpen(open, { ...o, claims: real.LAUNCH_CLAIMS.map(c => ({ ...c, ready: true })) }) }
    })
    try {
      launchOpen = 'true'
      const res = await (await app())(post('/api/create-checkout'))
      expect(res.status).toBe(200)
      expect(reached).toBe(1)
    } finally {
      vi.doUnmock('../../shared/launch-claims.mjs')
      vi.resetModules()
    }
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

describe('launch gate (client route middleware)', () => {
  const g = globalThis as Record<string, unknown>

  async function middleware(publicOpen: unknown) {
    const navigateTo = vi.fn((to: unknown) => to)
    g.defineNuxtRouteMiddleware = (fn: unknown) => fn
    g.useRuntimeConfig = () => ({ public: { launchOpen: publicOpen } })
    g.navigateTo = navigateTo
    vi.resetModules()
    const { default: mw } = await import('../../app/middleware/launch-gate.global')
    return { mw: mw as (to: { path: string }) => unknown, navigateTo }
  }

  afterEach(() => {
    delete g.defineNuxtRouteMiddleware
    delete g.navigateTo
  })

  it.each(['/onboarding', '/success', '/cancel'])('client navigation to %s while closed lands on #early-access', async (path) => {
    const { mw, navigateTo } = await middleware(false)
    const result = mw({ path })
    expect(navigateTo).toHaveBeenCalledWith({ path: '/', hash: '#early-access' }, { replace: true })
    expect(result).toEqual({ path: '/', hash: '#early-access' })
  })

  it('leaves the landing page alone while closed', async () => {
    const { mw, navigateTo } = await middleware(false)
    expect(mw({ path: '/' })).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('lets client navigation to /onboarding through once the launch is open', async () => {
    const { mw, navigateTo } = await middleware(true)
    expect(mw({ path: '/onboarding' })).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })
})

// Phase 23, plan 23-02 (D-03, D-04): the server may mark a request invited; the
// old two-argument call behaves exactly as before.
describe('launch gate (invited decision)', () => {
  it('gateDecision(path, open) without the third argument is unchanged', () => {
    for (const p of [...GATED_API, ...GATED_PAGES]) {
      expect(gateDecision(p, false)).toBe(gateDecision(p, false, false))
    }
    expect(gateDecision('/onboarding', false)).toBe('redirect')
    expect(gateDecision('/api/create-checkout', false)).toBe('not-found')
  })

  it.each([...GATED_API, ...GATED_PAGES])('%s passes for an invited request while closed', (p) => {
    expect(gateDecision(p, false, true)).toBe('pass')
  })

  it('open still passes whether or not invited', () => {
    expect(gateDecision('/onboarding', true)).toBe('pass')
    expect(gateDecision('/onboarding', true, false)).toBe('pass')
  })
})

// Phase 23, plan 23-02 (research Pitfall 3): every sign-up API route is gated
// from wave 1 on, and the provisioning callback is not, so a GitHub Actions
// run that was started before the gate closed can still report back. The
// callback proves itself with its own bearer check (23-11). The lists below
// are written out in full on purpose: a route added to or dropped from
// GATED_API has to change a test too.
describe('launch gate (Phase 23 list)', () => {
  const GATED_PHASE_23 = [
    '/api/create-checkout',
    '/api/check-subdomain',
    '/api/provision-status',
    '/api/check-code',
    '/api/capacity',
    '/api/suggest-topic-types',
    '/api/ai-key',
    '/api/retry-provisioning',
    '/api/price',
    // The owner-only redirect to Stripe's page for a held sign-up (23-37).
    '/api/confirm-payment'
  ]
  const OPEN_PHASE_23 = [
    '/api/stripe-webhook',
    '/api/provision-callback',
    '/api/provision-manifest',
    '/api/provision-manifest/ack',
    '/api/capacity-report',
    '/api/invite/request',
    '/api/invite/verify',
    '/api/early-access',
    // Posted by the QStash schedule; proves itself with QStash's signature (23-38).
    '/api/cron/sweep',
    // Called by teardown-instance.yml with the per-provision bearer (23-36, 23-37).
    '/api/teardown-check',
    '/api/teardown-result',
    // Called by fund-practice-relayer.yml with its own bearer.
    '/api/relayer-funding'
  ]

  it('GATED_API is exactly the Phase 23 sign-up routes', () => {
    expect([...GATED_API].sort()).toEqual([...GATED_PHASE_23].sort())
  })

  it.each(GATED_PHASE_23)('%s is not found while closed and uninvited', (p) => {
    expect(gateDecision(p, false)).toBe('not-found')
    expect(gateDecision(`${p}/`, false)).toBe('not-found')
    expect(gateDecision(p.toUpperCase(), false)).toBe('not-found')
  })

  it.each(GATED_PHASE_23)('%s passes when open or invited', (p) => {
    expect(gateDecision(p, true)).toBe('pass')
    expect(gateDecision(p, false, true)).toBe('pass')
  })

  it.each(OPEN_PHASE_23)('%s passes while closed and uninvited', (p) => {
    expect(gateDecision(p, false)).toBe('pass')
  })

  it('the "Not gated, on purpose" comment names both teardown routes', () => {
    const src = readFileSync(new URL('../../shared/launch.ts', import.meta.url), 'utf8')
    const notGated = src.slice(src.indexOf('// Not gated, on purpose:'))
    expect(notGated).toContain('/api/teardown-check')
    expect(notGated).toContain('/api/teardown-result')
  })

  it('the "Not gated, on purpose" comment names the relayer-funding route', () => {
    const src = readFileSync(new URL('../../shared/launch.ts', import.meta.url), 'utf8')
    const notGated = src.slice(src.indexOf('// Not gated, on purpose:'))
    expect(notGated).toContain('/api/relayer-funding')
    expect(GATED_API).not.toContain('/api/relayer-funding')
  })

  it('the provisioning callback is no longer in the gated list', () => {
    expect(GATED_API).not.toContain('/api/provision-callback')
    expect(gateDecision('/api/provision-callback', false)).toBe('pass')
  })

  it('a callback POST reaches its route through the real middleware while the flag is closed', async () => {
    let callbacks = 0
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ launchOpen: false })
    const { default: gate } = await import('../../server/middleware/launch-gate')
    const a = createApp()
    a.use(gate)
    const r = createRouter()
    r.post('/api/provision-callback', defineEventHandler(() => { callbacks++; return { ok: true } }))
    r.post('/api/capacity', defineEventHandler(() => { reached++; return { room: true } }))
    a.use(r)
    const h = toWebHandler(a)
    expect((await h(post('/api/provision-callback'))).status).toBe(200)
    expect(callbacks).toBe(1)
    expect((await h(post('/api/capacity'))).status).toBe(404)
    expect(reached).toBe(0)
  })
})

// Phase 23, plan 23-24 (D-01, D-03; threat T-23-70): the server's invited
// decision is copied into the page state `ln-invited` during SSR, and the
// client route middleware passes it to gateDecision. The state only steers
// navigation. It is never sent back and never trusted by the server: the real
// server middleware is run in the same tests to prove it.
describe('launch gate (invited state: server decision to client navigation)', () => {
  const g = globalThis as Record<string, unknown>
  const SECRET = 'test-invite-hash-secret'
  const GLOBALS = ['defineNuxtPlugin', 'defineNuxtRouteMiddleware', 'useState', 'useRequestEvent', 'useRuntimeConfig', 'useRedis', 'navigateTo']
  type Cell = { value: unknown }
  let states: Map<string, Cell>
  let navigateTo: ReturnType<typeof vi.fn>
  let redis: FakeRedis
  let currentEvent: unknown

  function installNuxtGlobals() {
    states = new Map()
    navigateTo = vi.fn((to: unknown) => to)
    redis = new FakeRedis()
    currentEvent = undefined
    g.defineNuxtPlugin = (fn: unknown) => fn
    g.defineNuxtRouteMiddleware = (fn: unknown) => fn
    // useState as Nuxt has it: one cell per key, the init runs only when the key is new.
    g.useState = (key: string, init?: () => unknown) => {
      if (!states.has(key)) states.set(key, { value: init?.() })
      return states.get(key)
    }
    g.useRequestEvent = () => currentEvent
    g.useRuntimeConfig = () => ({ launchOpen: false, inviteHashSecret: SECRET, public: { launchOpen: false } })
    g.useRedis = () => redis
    g.navigateTo = navigateTo
  }

  const plugin = async () => {
    vi.resetModules()
    return (await import('../../app/plugins/invited-state.server')).default as () => void
  }
  const clientGate = async () => {
    vi.resetModules()
    return (await import('../../app/middleware/launch-gate.global')).default as (to: { path: string }) => unknown
  }

  beforeEach(installNuxtGlobals)
  afterEach(() => { for (const k of GLOBALS) delete g[k] })

  /** A page route behind the real server gate: it runs the SSR plugin, then the client gate, as a server render does. */
  async function ssrApp() {
    const { default: gate } = await import('../../server/middleware/launch-gate')
    const a = createApp()
    a.use(gate)
    const r = createRouter()
    r.get('/onboarding', defineEventHandler(async (event) => {
      currentEvent = event
      ;(await plugin())()
      const result = (await clientGate())({ path: '/onboarding' })
      return result === undefined ? 'rendered' : 'bounced'
    }))
    r.post('/api/create-checkout', defineEventHandler(() => { reached++; return { url: 'https://checkout.stripe.com/x' } }))
    for (const p of GATED_API) r.post(p, defineEventHandler(() => { reached++; return { ok: true } }))
    a.use(r)
    return toWebHandler(a)
  }

  const page = (cookie?: string) => new Request('http://localhost/onboarding', { headers: cookie ? { cookie } : {} })

  it('copies event.context.invited true into the ln-invited state during SSR', async () => {
    currentEvent = { context: { invited: true } }
    ;(await plugin())()
    expect(states.get('ln-invited')?.value).toBe(true)
  })

  it.each([
    ['false', { context: { invited: false } }],
    ['missing (the flag is open, so the server never decided)', { context: {} }],
    ['no request event', undefined]
  ])('keeps the state false when the server decision is %s', async (_label, event) => {
    currentEvent = event
    ;(await plugin())()
    expect(states.get('ln-invited')?.value).toBe(false)
  })

  it('only the boolean true counts: a string or number on the server context does not make the state true', async () => {
    for (const bad of ['true', 1, {}, []]) {
      states.clear()
      currentEvent = { context: { invited: bad } }
      ;(await plugin())()
      expect(states.get('ln-invited')?.value).toBe(false)
    }
  })

  it('flag closed, live invited session: the SSR render keeps the person on /onboarding', async () => {
    const sid = await createInvitedSession(redis as never, { inviteId: 'i1', emailHmac: 'h1', email: 'someone@example.com' })
    const res = await (await ssrApp())(page(`${INVITE_COOKIE}=${sid}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('rendered')
    expect(states.get('ln-invited')?.value).toBe(true)
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('flag set at start-up while a promise is pending, live invited session: still reaches /onboarding and checkout, as on a closed site', async () => {
    g.useRuntimeConfig = () => ({ launchOpen: 'true', inviteHashSecret: SECRET, public: { launchOpen: false } })
    const sid = await createInvitedSession(redis as never, { inviteId: 'i1', emailHmac: 'h1', email: 'someone@example.com' })
    const h = await ssrApp()
    const res = await h(page(`${INVITE_COOKIE}=${sid}`))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('rendered')
    const pay = await h(new Request('http://localhost/api/create-checkout', { method: 'POST', headers: { cookie: `${INVITE_COOKIE}=${sid}` } }))
    expect(pay.status).toBe(200)
    // Without the invite, the same server stays closed.
    expect((await h(new Request('http://localhost/api/create-checkout', { method: 'POST' }))).status).toBe(404)
  })

  it('client navigation to /onboarding passes while closed once the state is true', async () => {
    states.set('ln-invited', { value: true })
    const mw = await clientGate()
    expect(mw({ path: '/onboarding' })).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it.each(['/onboarding', '/success', '/cancel'])('no invited state: client navigation to %s still redirects exactly as before', async (path) => {
    const mw = await clientGate()
    expect(mw({ path })).toEqual({ path: '/', hash: '#early-access' })
    expect(navigateTo).toHaveBeenCalledWith({ path: '/', hash: '#early-access' }, { replace: true })
  })

  it('an uninvited SSR decision leaves the state false, so the client gate redirects', async () => {
    currentEvent = { context: { invited: false } }
    ;(await plugin())()
    const mw = await clientGate()
    expect(mw({ path: '/onboarding' })).toEqual({ path: '/', hash: '#early-access' })
  })

  it('the state is read only for a path the gate would refuse', async () => {
    states.set('ln-invited', { value: true })
    const mw = await clientGate()
    expect(mw({ path: '/' })).toBeUndefined()
    expect(navigateTo).not.toHaveBeenCalled()
  })

  it('a state that is not the boolean true does not pass the client gate', async () => {
    for (const bad of ['true', 1, {}]) {
      states.set('ln-invited', { value: bad })
      navigateTo.mockClear()
      const mw = await clientGate()
      expect(mw({ path: '/onboarding' })).toEqual({ path: '/', hash: '#early-access' })
    }
  })

  it('setting ln-invited true by hand on the client changes nothing on the server: every gated API route is still 404', async () => {
    states.set('ln-invited', { value: true })
    const h = await ssrApp()
    for (const p of GATED_API) {
      const res = await h(new Request(`http://localhost${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
      expect(res.status, p).toBe(404)
    }
    // A forged cookie value and a made-up state header are no better.
    const forged = await h(new Request('http://localhost/api/create-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cookie': `${INVITE_COOKIE}=${'a'.repeat(43)}`, 'x-ln-invited': 'true' },
      body: '{}'
    }))
    expect(forged.status).toBe(404)
    expect(reached).toBe(0)
  })

  it('the state is not stored on the server context by the plugin (it reads, never writes back)', async () => {
    const ctx: Record<string, unknown> = { invited: false }
    currentEvent = { context: ctx }
    ;(await plugin())()
    states.get('ln-invited')!.value = true
    expect(ctx.invited).toBe(false)
  })
})
