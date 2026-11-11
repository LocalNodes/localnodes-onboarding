// Security follow-up (2026-11-09, from 22.1's security audit): the anonymous
// POST /api/early-access fails closed when its rate limit can't answer, and the
// limit keys on the client IP Vercel's proxy sets, not on a raw X-Forwarded-For
// value the client can prepend to.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { handleEarlyAccess, addResendContact, earlyAccessLimiter, hashIp, ACCEPTED, RATE_LIMIT, type Deps, type LimiterRedis } from '../../server/utils/early-access'
import { trustedClientIp } from '../../server/utils/client-ip'
import { SERVER_ERROR_MESSAGE } from '../../shared/ai-choice'

const EMAIL = 'organizer@example.com'
const GENERIC = { status: 503, body: { ok: false, message: SERVER_ERROR_MESSAGE } }

/** Handler deps wired to the real Resend call, with fetch replaced by a spy. */
function wired(allow: Deps['allow']) {
  const resendFetch = vi.fn(async () => ({ object: 'contact', id: 'c1' }))
  const logs: string[] = []
  const background: Promise<void>[] = []
  const deps: Deps = {
    configured: true,
    floorMs: 0,
    allow,
    addContact: contact => addResendContact(contact, 're_test', 'seg_1', resendFetch),
    log: m => { logs.push(m) },
    keepAlive: (w) => { background.push(w) }
  }
  return { deps, resendFetch, logs, settle: () => Promise.all(background), background }
}

const boom = (what: string) => async () => { throw new Error(`${what} failed: connect ECONNREFUSED`) }

describe('early access: the rate limit fails closed', () => {
  it.each<[string, () => LimiterRedis]>([
    ['Redis unreachable: every command throws, so the count can\'t be read', () => ({ incr: boom('INCR'), ttl: boom('TTL'), expire: boom('EXPIRE') })],
    ['Redis throws on the increment (INCR) only', () => ({ incr: boom('INCR'), ttl: async () => 3600, expire: async () => 1 })],
    ['Redis not configured: getting the client throws, as useRedis() does', () => { throw new Error('Upstash Redis credentials not configured') }]
  ])('%s: generic 503, nothing sent to Resend', async (_name, getRedis) => {
    const w = wired(earlyAccessLimiter(getRedis))
    const r = await handleEarlyAccess({ email: EMAIL, community: 'Repair Collective' }, '1.2.3.4', w.deps)
    expect(r).toEqual(GENERIC)
    await w.settle()
    expect(w.background).toHaveLength(0)
    expect(w.resendFetch).not.toHaveBeenCalled()
    expect(w.logs).toEqual(['early-access: rate limit unavailable, nothing sent'])
    expect(JSON.stringify(r)).not.toContain(EMAIL)
  })

  it('a limiter that rejects for any reason gets the generic 503, never the accepted reply', async () => {
    const w = wired(vi.fn(async () => { throw new Error('anything') }))
    const r = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', w.deps)
    expect(r).toEqual(GENERIC)
    expect(r).not.toEqual({ status: 200, body: ACCEPTED })
    expect(w.resendFetch).not.toHaveBeenCalled()
  })

  it('the honeypot path also refuses when the limiter is down (the limit is checked first)', async () => {
    const w = wired(earlyAccessLimiter(() => { throw new Error('Upstash Redis credentials not configured') }))
    expect(await handleEarlyAccess({ email: EMAIL, hpField: 'x' }, '1.2.3.4', w.deps)).toEqual(GENERIC)
  })

  it('with Redis working, the limiter still lets the first five through and refuses the sixth', async () => {
    const counts = new Map<string, number>()
    const redis: LimiterRedis = {
      incr: async (k) => { const n = (counts.get(k) ?? 0) + 1; counts.set(k, n); return n },
      ttl: async () => 3600,
      expire: async () => 1
    }
    const w = wired(earlyAccessLimiter(() => redis))
    const statuses = []
    for (let i = 0; i < RATE_LIMIT.max + 1; i++) statuses.push((await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', w.deps)).status)
    await w.settle()
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429])
    expect(w.resendFetch).toHaveBeenCalledTimes(RATE_LIMIT.max)
  })

  it('a TTL read that throws after INCR answered doesn\'t lift the limit: the count still decides', async () => {
    // allowRequest swallows TTL/EXPIRE errors on purpose (the next request
    // repairs a missing TTL, Codex P2); the count from INCR still bounds the sends.
    let n = 0
    const redis: LimiterRedis = { incr: async () => ++n, ttl: boom('TTL'), expire: async () => 1 }
    const w = wired(earlyAccessLimiter(() => redis))
    const statuses = []
    for (let i = 0; i < RATE_LIMIT.max + 3; i++) statuses.push((await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', w.deps)).status)
    await w.settle()
    expect(statuses.filter(s => s === 200)).toHaveLength(RATE_LIMIT.max)
    expect(statuses.slice(RATE_LIMIT.max)).toEqual([429, 429, 429])
    expect(w.resendFetch).toHaveBeenCalledTimes(RATE_LIMIT.max)
  })

  it('the route wires the fail-closed limiter and has no fail-open catch left (source guard)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/api/early-access.post.ts'), 'utf8')
    expect(src).toMatch(/allow:\s*earlyAccessLimiter\(\(\)\s*=>\s*useRedis\(\)\)/)
    // The old fail-open was a try/catch around the limiter that returned true.
    // (readBody(...).catch is fine: it only turns a bad body into a 400.)
    expect(src).not.toMatch(/return true/)
    expect(src).not.toMatch(/\btry\s*\{/)
    expect(src.match(/catch/g) ?? []).toEqual(['catch'])
    expect(src).toMatch(/readBody\(event\)\.catch\(\(\) => null\)/)
  })
})

describe('early access: the limit keys on the IP Vercel\'s proxy sets', () => {
  const headers = (h: Record<string, string>) => new Headers(h)

  it('uses x-real-ip, not the first X-Forwarded-For value the client can prepend', () => {
    expect(trustedClientIp(headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4', 'x-real-ip': '1.2.3.4' }), '10.0.0.1')).toBe('1.2.3.4')
  })

  it('a spoofed leading X-Forwarded-For value can\'t rotate the limit key', async () => {
    const seen: string[] = []
    const w = wired(vi.fn(async (h: string) => { seen.push(h); return true }))
    for (const spoof of ['6.6.6.6', '7.7.7.7', '203.0.113.9', '']) {
      const xff = spoof ? `${spoof}, 1.2.3.4` : '1.2.3.4'
      const ip = trustedClientIp(headers({ 'x-forwarded-for': xff, 'x-real-ip': '1.2.3.4' }), '10.0.0.1')
      await handleEarlyAccess({ email: EMAIL }, ip, w.deps)
    }
    expect(seen).toHaveLength(4)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]).toBe(hashIp('1.2.3.4'))
  })

  it('off Vercel (no x-real-ip) it uses the socket address and ignores X-Forwarded-For', () => {
    expect(trustedClientIp(headers({ 'x-forwarded-for': '6.6.6.6' }), '127.0.0.1')).toBe('127.0.0.1')
    expect(trustedClientIp(headers({ 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '' }), '127.0.0.1')).toBe('127.0.0.1')
    expect(trustedClientIp(headers({ 'x-forwarded-for': '6.6.6.6' }), undefined)).toBeUndefined()
  })

  it('the route keys on trustedClientIp, never on X-Forwarded-For (source guard)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/api/early-access.post.ts'), 'utf8')
    const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(code).toMatch(/const ip = trustedClientIp\(event\.headers, /)
    expect(code).not.toMatch(/xForwardedFor|x-forwarded-for|getRequestIP/i)
  })
})
