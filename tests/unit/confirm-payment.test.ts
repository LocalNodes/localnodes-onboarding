import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createApp, createRouter, toWebHandler } from 'h3'
import { handleConfirmPayment } from '../../server/utils/teardown'
import { INVITE_COOKIE, sha256 } from '../../server/utils/invites'
import { GATED_API, gateDecision } from '../../shared/launch'
import { FakeRedis } from './helpers/fake-redis'

/**
 * POST /api/confirm-payment (Phase 23, plan 23-37; Tom's answer 3, T-23-188).
 *
 * The held screen's "Confirm my payment" button is a form POST, so the hosted
 * invoice URL is in no page's HTML, the owner's included. The route answers
 * only the browser that made this sign-up (its ln_invite cookie hashes to the
 * stored ownerSessionHash) with a 303 to Stripe's page; everyone else gets 404
 * with no URL in the body. Gated: 404 while closed without a live session.
 */

const SID = 'cs_test_confirm_payment'
const PID = 'C0nf1rm000000000000000'
const COOKIE = 'owner-cookie-value-43-characters-long-xxxxx'
const OWNER = sha256(COOKIE)
const HOSTED = 'https://invoice.stripe.com/i/acct_x/test_secret_canary'

async function seed(redis: FakeRedis, extra: Record<string, unknown> = {}, signupExtra: Record<string, unknown> = {}) {
  await redis.hset(`provision:${SID}`, { status: 'held', provisionId: PID, heldUntil: Date.parse('2026-11-09T16:15:00Z'), ...extra })
  await redis.hset(`signup:${PID}`, { email: 'organizer@example.org', ownerSessionHash: OWNER, hostedInvoiceUrl: HOSTED, ...signupExtra })
}

describe('handleConfirmPayment: the owner of a held sign-up only', () => {
  let redis: FakeRedis

  beforeEach(async () => {
    redis = new FakeRedis()
    await seed(redis)
  })

  it('the owner of a held sign-up: 303 to the hosted page', async () => {
    expect(await handleConfirmPayment(SID, OWNER, { redis })).toEqual({ status: 303, location: HOSTED })
  })

  it.each(['tearing_down', 'torn_down'])('a sign-up %s (23-43 Task 2): 404 with no URL, even for the owner', async (status) => {
    await redis.hset(`provision:${SID}`, { status, teardownReason: 'held_expired' })
    const out = await handleConfirmPayment(SID, OWNER, { redis })
    expect(out).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(JSON.stringify(out)).not.toContain('invoice.stripe.com')
  })

  it.each([
    ['another session', sha256('someone-else')],
    ['no session', null],
    ['an empty hash', '']
  ])('%s: 404 with no URL', async (_l, hash) => {
    const out = await handleConfirmPayment(SID, hash, { redis })
    expect(out).toEqual({ status: 404, body: { message: 'Not Found' } })
    expect(JSON.stringify(out)).not.toContain('invoice.stripe.com')
  })

  it.each(['ready', 'declined', 'complete', 'failed'])('a sign-up not held (%s): 404', async (status) => {
    await redis.hset(`provision:${SID}`, { status })
    expect(await handleConfirmPayment(SID, OWNER, { redis })).toEqual({ status: 404, body: { message: 'Not Found' } })
  })

  it.each([
    'https://evil.example/i/acct_x',
    'http://invoice.stripe.com/i/acct_x',
    'https://invoice.stripe.com.evil.example/i',
    'javascript:alert(1)',
    ''
  ])('a stored URL that does not start with https://invoice.stripe.com/ (%s): 404', async (url) => {
    await redis.hset(`signup:${PID}`, { hostedInvoiceUrl: url })
    const out = await handleConfirmPayment(SID, OWNER, { redis })
    expect(out.status).toBe(404)
  })

  it.each(['', 'not-a-session', 'cs_test_x"><script>', undefined, 7])('a bad session id (%s): 404', async (sid) => {
    expect(await handleConfirmPayment(sid as string, OWNER, { redis })).toEqual({ status: 404, body: { message: 'Not Found' } })
  })

  it('an unknown session: 404', async () => {
    expect(await handleConfirmPayment('cs_test_unknown', OWNER, { redis })).toEqual({ status: 404, body: { message: 'Not Found' } })
  })
})

describe('POST /api/confirm-payment through the route (JSON and form-encoded)', () => {
  let redis: FakeRedis
  let handler: (req: Request) => Promise<Response>

  beforeEach(async () => {
    redis = new FakeRedis()
    await seed(redis)
    ;(globalThis as Record<string, unknown>).useRedis = () => redis
    const { default: route } = await import('../../server/api/confirm-payment.post')
    const app = createApp()
    const router = createRouter()
    router.post('/api/confirm-payment', route)
    app.use(router)
    handler = toWebHandler(app)
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).useRedis
  })

  const post = (body: string, type: string, cookie?: string) => handler(new Request('http://localhost/api/confirm-payment', {
    method: 'POST',
    headers: { 'content-type': type, ...(cookie ? { cookie: `${INVITE_COOKIE}=${cookie}` } : {}) },
    body,
    redirect: 'manual'
  }))

  it('form-encoded from the owner\'s browser: 303, Location the hosted page, no-store, no-referrer', async () => {
    const res = await post(`session_id=${SID}`, 'application/x-www-form-urlencoded', COOKIE)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(HOSTED)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('JSON from the owner\'s browser: 303', async () => {
    const res = await post(JSON.stringify({ session_id: SID }), 'application/json', COOKIE)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(HOSTED)
  })

  it('no session: 404 before any Redis client is built (a closed or unconfigured store never turns into a 500)', async () => {
    ;(globalThis as Record<string, unknown>).useRedis = () => {
      throw new Error('Upstash not configured')
    }
    const res = await post(`session_id=${SID}`, 'application/x-www-form-urlencoded')
    expect(res.status).toBe(404)
  })

  it.each([
    ['another session', 'someone-else-cookie'],
    ['no session', undefined]
  ])('%s: 404, no Location, no URL in the body', async (_l, cookie) => {
    const res = await post(`session_id=${SID}`, 'application/x-www-form-urlencoded', cookie)
    expect(res.status).toBe(404)
    expect(res.headers.get('location')).toBeNull()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).not.toContain('invoice.stripe.com')
  })
})

describe('the confirm route is gated (shared/launch.ts GATED_API)', () => {
  it('is in GATED_API: 404 while closed without a live invite session, passes with one', () => {
    expect(GATED_API).toContain('/api/confirm-payment')
    expect(gateDecision('/api/confirm-payment', false)).toBe('not-found')
    expect(gateDecision('/api/confirm-payment', false, true)).toBe('pass')
  })

  it('the hosted invoice URL is never logged by the route', () => {
    const src = readFileSync(new URL('../../server/api/confirm-payment.post.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/console\.(log|warn|error)/)
  })
})
