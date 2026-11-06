// Early-access list (Tom, 2026-11-06, PR #9): validation, honeypot, rate
// limit, one reply for every accepted request, the email never logged.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleEarlyAccess, addResendContact, allowRequest, ACCEPTED, hashIp, RESPONSE_FLOOR_MS, RATE_LIMIT, type Deps, type LimiterRedis } from '../../server/utils/early-access'

const EMAIL = 'organizer@example.com'

function deps(over: Partial<Deps> = {}) {
  const logs: string[] = []
  const background: Promise<void>[] = []
  const d: Deps & { logs: string[], background: Promise<void>[] } = {
    configured: true,
    floorMs: 0,
    keepAlive: (w: Promise<void>) => { background.push(w) },
    background,
    allow: vi.fn(async () => true),
    addContact: vi.fn(async () => {}),
    log: (m: string) => { logs.push(m) },
    logs,
    ...over
  }
  return d
}

describe('early access: handler', () => {
  it('adds a valid email, trimmed and lower-cased, with the optional fields', async () => {
    const d = deps()
    const r = await handleEarlyAccess({ email: '  Organizer@Example.com ', community: 'Repair Collective', groupKind: 'Co-op' }, '1.2.3.4', d)
    expect(r).toEqual({ status: 200, body: ACCEPTED })
    expect(d.addContact).toHaveBeenCalledWith({ email: EMAIL, community: 'Repair Collective', groupKind: 'Co-op' })
  })

  it('rejects an invalid email server-side without calling Resend', async () => {
    const d = deps()
    for (const email of ['', 'not-an-email', 'a@', 'x'.repeat(250) + '@example.com']) {
      const r = await handleEarlyAccess({ email }, '1.2.3.4', d)
      expect(r.status).toBe(400)
    }
    expect(await handleEarlyAccess(null, '1.2.3.4', d)).toMatchObject({ status: 400 })
    expect(await handleEarlyAccess({ email: EMAIL, community: 'x'.repeat(81) }, '1.2.3.4', d)).toMatchObject({ status: 400 })
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('a filled honeypot gets the same reply and adds nothing', async () => {
    const d = deps()
    const r = await handleEarlyAccess({ email: EMAIL, hpField: 'http://spam.example' }, '1.2.3.4', d)
    expect(r).toEqual({ status: 200, body: ACCEPTED })
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('an email already on the list (Resend refuses) gets the same reply as a new one', async () => {
    const fresh = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', deps())
    const dupe = deps({ addContact: vi.fn(async () => { throw Object.assign(new Error(`Contact ${EMAIL} already exists`), { statusCode: 409 }) }) })
    const again = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', dupe)
    expect(again).toEqual(fresh)
    expect(JSON.stringify(again)).not.toContain(EMAIL)
  })

  it('never logs the email address, even when Resend errors with it in the message', async () => {
    const spy = vi.spyOn(console, 'log')
    const err = vi.spyOn(console, 'error')
    const d = deps({ addContact: vi.fn(async () => { throw Object.assign(new Error(`bad ${EMAIL}`), { statusCode: 422 }) }) })
    await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    await Promise.all(d.background) // the error is logged after the reply
    expect(d.logs.join('\n')).not.toContain(EMAIL)
    expect(d.logs.join('\n')).toContain('422')
    expect(spy.mock.calls.flat().join(' ')).not.toContain(EMAIL)
    expect(err.mock.calls.flat().join(' ')).not.toContain(EMAIL)
    spy.mockRestore(); err.mockRestore()
  })

  it('returns 429 once the per-IP limit is spent, and rate-limits by a hash, not the IP', async () => {
    const seen: string[] = []
    const d = deps({ allow: vi.fn(async (h: string) => { seen.push(h); return false }) })
    const r = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    expect(r.status).toBe(429)
    expect(d.addContact).not.toHaveBeenCalled()
    expect(seen[0]).toBe(hashIp('1.2.3.4'))
    expect(seen[0]).not.toContain('1.2.3.4')
  })

  it('says not open yet (503) when the list is not configured, adding nothing', async () => {
    const d = deps({ configured: false })
    const r = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    expect(r.status).toBe(503)
    expect(d.addContact).not.toHaveBeenCalled()
  })
})

describe('early access: Resend contact', () => {
  it('posts to /contacts with the segment id, subscribed, and the properties', async () => {
    const fetcher = vi.fn(async () => ({ object: 'contact', id: 'c1' }))
    await addResendContact({ email: EMAIL, community: 'Repair Collective', groupKind: 'Co-op' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, opts] = fetcher.mock.calls[0] as unknown as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/contacts')
    expect(opts.headers.Authorization).toBe('Bearer re_test')
    expect(opts.body).toEqual({ email: EMAIL, unsubscribed: false, segments: [{ id: 'seg_1' }], properties: { community_name: 'Repair Collective', group_kind: 'Co-op' } })
  })

  it('retries once without properties when Resend refuses them, so the address is kept', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('property not found'), { statusCode: 422 }))
      .mockResolvedValueOnce({ object: 'contact', id: 'c1' })
    await addResendContact({ email: EMAIL, community: 'Repair Collective', groupKind: '' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((fetcher.mock.calls[1] as unknown as [string, { body: Record<string, unknown> }])[1].body).toEqual({ email: EMAIL, unsubscribed: false, segments: [{ id: 'seg_1' }] })
  })

  it('sends no properties when the optional fields are empty', async () => {
    const fetcher = vi.fn(async () => ({}))
    await addResendContact({ email: EMAIL, community: '', groupKind: '' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body).not.toHaveProperty('properties')
  })
})

describe('early access: response-time floor (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  async function settleAt(promise: Promise<unknown>) {
    let done = false
    promise.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(RESPONSE_FLOOR_MS - 1)
    const before = done
    await vi.advanceTimersByTimeAsync(1)
    return { before, after: done }
  }

  const slow = (ms: number, fail = false) => vi.fn(() => new Promise<void>((resolve, reject) => setTimeout(() => (fail ? reject(Object.assign(new Error('dupe'), { statusCode: 409 })) : resolve()), ms)))

  it.each([
    ['a new contact (fast)', { email: EMAIL }, slow(5)],
    ['a duplicate Resend refuses (slower)', { email: EMAIL }, slow(400, true)],
    ['the honeypot (Resend never called)', { email: EMAIL, hpField: 'x' }, slow(5)]
  ])('%s replies only once the floor has passed', async (_name, body, addContact) => {
    const p = handleEarlyAccess(body, '1.2.3.4', { configured: true, allow: async () => true, addContact })
    const { before, after } = await settleAt(p)
    expect(before).toBe(false)
    expect(after).toBe(true)
    expect(await p).toEqual({ status: 200, body: ACCEPTED })
  })

  it('a 3 s provider still replies at the floor, and the contact call still completes after the reply', async () => {
    let replied = false
    let finished = false
    const kept: Promise<void>[] = []
    const logs: string[] = []
    const addContact = vi.fn(() => new Promise<void>(resolve => setTimeout(() => { finished = true; resolve() }, 3000)))
    const p = handleEarlyAccess({ email: EMAIL }, '1.2.3.4', { configured: true, allow: async () => true, addContact, keepAlive: w => { kept.push(w) }, log: m => { logs.push(m) } })
    p.then(() => { replied = true })
    await vi.advanceTimersByTimeAsync(RESPONSE_FLOOR_MS - 1)
    expect(replied).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(replied).toBe(true)
    expect(await p).toEqual({ status: 200, body: ACCEPTED })
    expect(finished).toBe(false)
    expect(kept).toHaveLength(1) // handed to waitUntil, not dropped
    await vi.advanceTimersByTimeAsync(2000)
    await kept[0]
    expect(finished).toBe(true)
    expect(logs).toEqual([])
  })

  it('a 3 s provider that fails after the reply logs the failure without the email', async () => {
    const kept: Promise<void>[] = []
    const logs: string[] = []
    const addContact = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(Object.assign(new Error(`${EMAIL} exists`), { statusCode: 409 })), 3000)))
    const p = handleEarlyAccess({ email: EMAIL }, '1.2.3.4', { configured: true, allow: async () => true, addContact, keepAlive: w => { kept.push(w) }, log: m => { logs.push(m) } })
    await vi.advanceTimersByTimeAsync(RESPONSE_FLOOR_MS)
    expect(await p).toEqual({ status: 200, body: ACCEPTED })
    expect(logs).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    await kept[0]
    expect(logs).toEqual(['early-access: contact not added (status 409)'])
    expect(logs.join(' ')).not.toContain(EMAIL)
  })
})

describe('early access: rate limit TTL', () => {
  // In-memory stand-in for Upstash with a clock; EXPIRE can be made to fail.
  function memRedis() {
    let now = 0
    const store = new Map<string, { n: number, until: number | null }>()
    let expireFailures = 0
    const live = (k: string) => {
      const e = store.get(k)
      if (e && e.until !== null && e.until <= now) store.delete(k)
      return store.get(k)
    }
    const redis: LimiterRedis = {
      incr: async (k) => { const e = live(k) ?? { n: 0, until: null }; e.n++; store.set(k, e); return e.n },
      ttl: async (k) => { const e = live(k); return !e ? -2 : e.until === null ? -1 : Math.ceil((e.until - now) / 1000) },
      expire: async (k, sec) => {
        if (expireFailures > 0) { expireFailures--; throw new Error('EXPIRE failed') }
        const e = live(k); if (e) e.until = now + sec * 1000; return 1
      }
    }
    return { redis, tick: (sec: number) => { now += sec * 1000 }, failNextExpire: () => { expireFailures++ } }
  }

  it('allows up to the limit in a window, then refuses', async () => {
    const { redis } = memRedis()
    const results = []
    for (let i = 0; i < RATE_LIMIT.max + 1; i++) results.push(await allowRequest(redis, 'ip'))
    expect(results.slice(0, RATE_LIMIT.max).every(Boolean)).toBe(true)
    expect(results.at(-1)).toBe(false)
  })

  it('when EXPIRE fails once, the next request repairs the TTL and the IP is not blocked forever', async () => {
    const m = memRedis()
    m.failNextExpire()
    expect(await allowRequest(m.redis, 'ip')).toBe(true) // EXPIRE fails here
    expect(await m.redis.ttl('rl:early-access:ip')).toBe(-1)
    for (let i = 0; i < RATE_LIMIT.max; i++) await allowRequest(m.redis, 'ip') // TTL reapplied
    expect(await allowRequest(m.redis, 'ip')).toBe(false)
    expect(await m.redis.ttl('rl:early-access:ip')).toBeGreaterThan(0)
    m.tick(RATE_LIMIT.windowSeconds + 1)
    expect(await allowRequest(m.redis, 'ip')).toBe(true)
  })
})
