// Server room (Phase 23, plan 23-17, D-08, TA-8). Redis is a fake, Stripe,
// Resend and Coolify are mocks: nothing here touches a network.
//
// The rule: a report fresher than 15 minutes, memAvailableMb minus 2048 per
// sign-up still being built at least 2048 + 1024, docker free at least 10 GB,
// load below the CPU count, and running apps (plus those being built) below
// NUXT_CAPACITY_MAX_SITES. A missing, stale or unreadable reading means full.
import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { FakeRedis } from './helpers/fake-redis'
import { roomyCapacity } from './helpers/capacity'
import { addInvite, emailKey, type InviteRecord } from '../../server/utils/invites'
import { handleCreateCheckout, type CheckoutDeps } from '../../server/utils/checkout'
import { gateDecision } from '../../shared/launch'
import { callbackToken, handleProvisionCallback } from '../../server/utils/provision-handlers'
import { retryProvisioning, stopProvision, type RetryStopDeps } from '../../server/utils/retry-stop'
import { handleStripeWebhook, type WebhookDeps } from '../../server/utils/stripe-webhook'
import {
  APPS_KEY,
  CAPACITY_KEY,
  FULL_MESSAGE,
  INFLIGHT_KEY,
  INFLIGHT_SECONDS,
  REPORT_TTL_SECONDS,
  addInflight,
  countRunningApps,
  rearmSessionCapacity,
  releaseSessionCapacity,
  removeInflight,
  handleCapacityRead,
  hasRoom,
  recordReport,
  recordWaitingForRoom,
  type RoomConfig
} from '../../server/utils/capacity'

const SECRET = 'capacity-report-secret-0123456789abcdef'
const BEARER = `Bearer ${SECRET}`
const T0 = 1_700_000_000_000
const CONFIG: RoomConfig = { perSiteMb: 2048, headroomMb: 1024, minDockerFreeGb: 10, maxSites: 5 }
/** The 2026-11-04 reading from OPS-DIAGNOSIS section 4: a site fits. */
const GOOD = { memAvailableMb: 7231, dockerFreeGb: 11, load1: 0.9, nproc: 8, reportedAt: '2026-11-04T20:22:49Z' }

async function reported(body: Record<string, unknown> = GOOD, at = T0) {
  const redis = new FakeRedis()
  const r = await recordReport(body, BEARER, { redis, secret: SECRET, now: () => at })
  expect(r.status).toBe(200)
  return redis
}

function room(redis: FakeRedis, over: { config?: Partial<RoomConfig>, running?: number, now?: number } = {}) {
  return hasRoom({
    redis,
    config: { ...CONFIG, ...over.config },
    runningApps: async () => over.running ?? 3,
    now: () => over.now ?? T0
  })
}

describe('capacity-report: the VPS pushes its reading', () => {
  it('with the right bearer, stores capacity:vps for 15 minutes (EX 900)', async () => {
    const redis = new FakeRedis()
    const r = await recordReport(GOOD, BEARER, { redis, secret: SECRET, now: () => T0 })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(REPORT_TTL_SECONDS).toBe(900)
    expect(await redis.ttl(CAPACITY_KEY)).toBe(900)
    expect(await redis.get(CAPACITY_KEY)).toMatchObject({ ...GOOD, receivedAt: T0 })
  })

  it('a wrong bearer gets 401 and stores nothing', async () => {
    const redis = new FakeRedis()
    const r = await recordReport(GOOD, 'Bearer not-the-secret-at-all-000000000000', { redis, secret: SECRET })
    expect(r.status).toBe(401)
    expect(redis.keys()).toEqual([])
  })

  it.each([
    ['no header', undefined],
    ['a header without Bearer', SECRET],
    ['a bearer of another length', 'Bearer short']
  ])('%s gets 401', async (_label, header) => {
    const redis = new FakeRedis()
    expect((await recordReport(GOOD, header, { redis, secret: SECRET })).status).toBe(401)
    expect(redis.keys()).toEqual([])
  })

  it('with no secret configured nothing passes, not even an empty bearer', async () => {
    const redis = new FakeRedis()
    expect((await recordReport(GOOD, 'Bearer ', { redis, secret: '' })).status).toBe(401)
    expect(redis.keys()).toEqual([])
  })

  it('checks the bearer before it reads the body: a bad body with a bad bearer is 401, not 400', async () => {
    const redis = new FakeRedis()
    expect((await recordReport({ nonsense: true }, 'Bearer wrong', { redis, secret: SECRET })).status).toBe(401)
  })

  it.each([
    ['negative memory', { ...GOOD, memAvailableMb: -1 }],
    ['memory as text', { ...GOOD, memAvailableMb: '7231' }],
    ['absurd memory', { ...GOOD, memAvailableMb: 1e12 }],
    ['zero CPUs', { ...GOOD, nproc: 0 }],
    ['fractional CPUs', { ...GOOD, nproc: 2.5 }],
    ['a negative load', { ...GOOD, load1: -0.1 }],
    ['negative disk', { ...GOOD, dockerFreeGb: -3 }],
    ['a missing field', { memAvailableMb: 7231, dockerFreeGb: 11, load1: 0.9, nproc: 8 }],
    ['a reportedAt that is not a UTC time', { ...GOOD, reportedAt: 'yesterday' }]
  ])('refuses %s with 400 and stores nothing', async (_label, body) => {
    const redis = new FakeRedis()
    expect((await recordReport(body, BEARER, { redis, secret: SECRET })).status).toBe(400)
    expect(redis.keys()).toEqual([])
  })

  it('the report route is not behind the launch gate; the capacity read is', () => {
    expect(gateDecision('/api/capacity-report', false)).toBe('pass')
    expect(gateDecision('/api/capacity', false)).toBe('not-found')
    expect(gateDecision('/api/capacity', false, true)).toBe('pass')
  })
})

describe('hasRoom: the decision', () => {
  it('true for memAvailableMb 7231, 0 in flight, docker free 11 GB, load 0.9 on 8 CPUs, 3 running apps under a max of 5', async () => {
    expect(await room(await reported())).toBe(true)
  })

  it('false with no metric', async () => {
    expect(await room(new FakeRedis())).toBe(false)
  })

  it('false with a metric older than 15 minutes (the key has expired)', async () => {
    const redis = await reported()
    redis.advance(REPORT_TTL_SECONDS + 1)
    expect(await room(redis, { now: T0 + (REPORT_TTL_SECONDS + 1) * 1000 })).toBe(false)
  })

  it('false with a metric older than 15 minutes even if the key outlived it', async () => {
    const redis = new FakeRedis()
    await redis.set(CAPACITY_KEY, { ...GOOD, receivedAt: T0 - 16 * 60 * 1000 }, { ex: 3600 })
    expect(await room(redis)).toBe(false)
  })

  it('false when memAvailableMb 5000 with 1 in-flight sign-up (5000 - 2048 < 3072)', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 5000 })
    await redis.zadd(INFLIGHT_KEY, { score: T0 + 45 * 60 * 1000, member: 'AAAAAAAAAAAAAAAAAAAAAA' })
    expect(await room(redis)).toBe(false)
  })

  it('true at exactly the line: memAvailableMb 5120 with 1 in flight (5120 - 2048 = 3072)', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 5120 })
    await redis.zadd(INFLIGHT_KEY, { score: T0 + 45 * 60 * 1000, member: 'AAAAAAAAAAAAAAAAAAAAAA' })
    expect(await room(redis)).toBe(true)
  })

  it('false with docker free under 10 GB', async () => {
    expect(await room(await reported({ ...GOOD, dockerFreeGb: 9 }))).toBe(false)
  })

  it('false when the load is not below the CPU count', async () => {
    expect(await room(await reported({ ...GOOD, load1: 8 }))).toBe(false)
  })

  it('false when running apps reach the max', async () => {
    expect(await room(await reported(), { running: 5 })).toBe(false)
  })

  it('counts sites still being built against the max: 3 running + 2 in flight reach a max of 5', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 15000 })
    await redis.zadd(INFLIGHT_KEY, { score: T0 + 60_000, member: 'AAAAAAAAAAAAAAAAAAAAAA' }, { score: T0 + 60_000, member: 'BBBBBBBBBBBBBBBBBBBBBB' })
    expect(await room(redis, { running: 3 })).toBe(false)
  })

  it('a max of 0 (the shipped default) sells nothing', async () => {
    expect(await room(await reported(), { config: { maxSites: 0 }, running: 0 })).toBe(false)
  })

  it('every number is runtime config: values given as env strings are read as numbers', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 4000 })
    const config = { perSiteMb: '1024', headroomMb: '512', minDockerFreeGb: '5', maxSites: '6' } as unknown as RoomConfig
    expect(await hasRoom({ redis, config, runningApps: async () => 3, now: () => T0 })).toBe(true)
    const tight = { ...config, perSiteMb: '4096' } as unknown as RoomConfig
    expect(await hasRoom({ redis, config: tight, runningApps: async () => 3, now: () => T0 })).toBe(false)
  })

  it('a config value that is not a number means full', async () => {
    const config = { ...CONFIG, minDockerFreeGb: 'ten' } as unknown as RoomConfig
    expect(await hasRoom({ redis: await reported(), config, runningApps: async () => 3, now: () => T0 })).toBe(false)
  })

  it('an in-flight sign-up whose 45 minutes are over is not counted', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 5000 })
    await redis.zadd(INFLIGHT_KEY, { score: T0 - 1, member: 'AAAAAAAAAAAAAAAAAAAAAA' })
    expect(await room(redis)).toBe(true)
  })

  it('an error reading Redis means full', async () => {
    const redis = await reported()
    redis.get = async () => { throw new Error('upstash down') }
    expect(await room(redis)).toBe(false)
  })

  it('an error counting running apps means full', async () => {
    const redis = await reported()
    expect(await hasRoom({ redis, config: CONFIG, runningApps: async () => { throw new Error('coolify down') }, now: () => T0 })).toBe(false)
  })

  it('a stored reading that is not a reading means full', async () => {
    const redis = new FakeRedis()
    await redis.set(CAPACITY_KEY, 'garbage', { ex: 900 })
    expect(await room(redis)).toBe(false)
  })
})

describe('countRunningApps: Coolify GET /servers/{uuid}/resources, cached 60 s', () => {
  const resources = [
    { uuid: 'a1', type: 'application', status: 'running:healthy' },
    { uuid: 'a2', type: 'application', status: 'running:unhealthy' },
    { uuid: 'a3', type: 'application', status: 'exited:unhealthy' },
    { uuid: 's1', type: 'service', status: 'running:healthy' }
  ]

  it('counts every running resource on the server and asks Coolify with the token', async () => {
    const redis = new FakeRedis()
    const fetch = vi.fn(async (_url: string, _opts: { headers: Record<string, string> }) => resources as unknown)
    const n = await countRunningApps({ redis, fetch, apiUrl: 'https://coolify.example/api/v1', token: 'tok', serverUuid: 'srv1' })
    expect(n).toBe(3)
    expect(fetch).toHaveBeenCalledWith('https://coolify.example/api/v1/servers/srv1/resources', { headers: { Authorization: 'Bearer tok', Accept: 'application/json' } })
    expect(await redis.ttl(APPS_KEY)).toBe(60)
  })

  it('a second read inside 60 s uses the cache; after 60 s it asks again', async () => {
    const redis = new FakeRedis()
    const fetch = vi.fn(async () => resources as unknown)
    const deps = { redis, fetch, apiUrl: 'https://c/api/v1', token: 'tok', serverUuid: 'srv1' }
    await countRunningApps(deps)
    expect(await countRunningApps(deps)).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(1)
    redis.advance(61)
    await countRunningApps(deps)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('throws (so the decision is full) with no server uuid, no token, or an answer that is not a list', async () => {
    const redis = new FakeRedis()
    const fetch = vi.fn(async () => ({ error: 'nope' }) as unknown)
    await expect(countRunningApps({ redis, fetch, apiUrl: 'https://c', token: 'tok', serverUuid: '' })).rejects.toThrow()
    await expect(countRunningApps({ redis, fetch, apiUrl: 'https://c', token: '', serverUuid: 'srv1' })).rejects.toThrow()
    await expect(countRunningApps({ redis, fetch, apiUrl: 'https://c', token: 'tok', serverUuid: 'srv1' })).rejects.toThrow()
    expect(redis.keys()).toEqual([])
  })
})

describe('recordWaitingForRoom: the Resend early-access segment, waiting_for_room "true" (TA-8)', () => {
  type Call = [string, { method: string, headers: Record<string, string>, body: Record<string, any> }]
  const EMAIL = 'invited.person@example.com'

  it('adds the address to the segment with properties.waiting_for_room the string "true", not a boolean', async () => {
    const fetch = vi.fn(async () => ({ object: 'contact', id: 'c1' }) as unknown)
    await recordWaitingForRoom(EMAIL, { apiKey: 're_test', segmentId: 'seg_1', fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0] as unknown as Call
    expect(url).toBe('https://api.resend.com/contacts')
    expect(opts.method).toBe('POST')
    expect(opts.body.segments).toEqual([{ id: 'seg_1' }])
    expect(opts.body.properties.waiting_for_room).toBe('true')
    expect(typeof opts.body.properties.waiting_for_room).toBe('string')
  })

  it('an address that is already a contact (create refused) gets the property through PATCH /contacts/{email}, as the string "true"', async () => {
    const refused = Object.assign(new Error('contact exists'), { statusCode: 409 })
    const fetch = vi.fn()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ object: 'contact', id: 'c1' })
    await recordWaitingForRoom(EMAIL, { apiKey: 're_test', segmentId: 'seg_1', fetch })
    expect(fetch).toHaveBeenCalledTimes(3)
    const [url, opts] = fetch.mock.calls[2] as unknown as Call
    expect(url).toBe(`https://api.resend.com/contacts/${encodeURIComponent(EMAIL)}`)
    expect(opts.method).toBe('PATCH')
    expect(opts.body).toEqual({ properties: { waiting_for_room: 'true' } })
    expect(typeof opts.body.properties.waiting_for_room).toBe('string')
  })

  it('throws, with no address in the message, when Resend is not configured', async () => {
    const fetch = vi.fn()
    await expect(recordWaitingForRoom(EMAIL, { apiKey: '', segmentId: 'seg_1', fetch })).rejects.toThrow(/not configured/)
    await expect(recordWaitingForRoom(EMAIL, { apiKey: 're', segmentId: '', fetch })).rejects.not.toThrow(EMAIL)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('create-checkout when the server is full', () => {
  const INVITED = 'invited.person@example.com'
  const BODY = { communityName: 'Repair Collective', subdomain: 'repair' }

  async function fullSetup(over: Partial<CheckoutDeps> = {}) {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, 'hash-secret', { email: INVITED, kind: 'wave', wave: 'w1' })
    const session: InviteRecord = { inviteId, emailHmac: emailKey('hash-secret', INVITED), email: INVITED }
    const create = vi.fn(async (_p: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
    const dispatch = vi.fn()
    const fetch = vi.fn(async () => ({ object: 'contact' }) as unknown)
    const logs: string[] = []
    const capacity = {
      ...roomyCapacity(),
      hasRoom: vi.fn(async () => false),
      waitlist: vi.fn((email: string) => recordWaitingForRoom(email, { apiKey: 're_test', segmentId: 'seg_1', fetch }))
    }
    const deps: CheckoutDeps = {
      open: false,
      session,
      stripe: { checkout: { sessions: { create } } },
      redis,
      priceId: 'price_1', paidSignupsEnabled: true,
      currency: 'usd',
      origin: 'https://localnodes.xyz',
      newProvisionId: () => 'AAAAAAAAAAAAAAAAAAAAAA',
      log: (m: string) => { logs.push(m) },
      capacity,
      ...over
    }
    return { redis, create, dispatch, fetch, logs, capacity, deps }
  }

  it('returns 409 with the full reply, word for word', async () => {
    const { deps } = await fullSetup()
    const r = await handleCreateCheckout(BODY, deps)
    expect(FULL_MESSAGE).toBe('We\'re full right now. We\'ll email you when there\'s room.')
    expect(r).toEqual({ status: 409, body: { message: FULL_MESSAGE } })
  })

  it('adds the invited email to the segment with waiting_for_room the string "true"', async () => {
    const { deps, fetch, capacity } = await fullSetup()
    await handleCreateCheckout({ ...BODY, email: 'someone.else@example.org' }, deps)
    expect(capacity.waitlist).toHaveBeenCalledWith(INVITED)
    const body = (fetch.mock.calls[0] as unknown as [string, { body: Record<string, any> }])[1].body
    expect(body.email).toBe(INVITED)
    expect(body.properties.waiting_for_room).toBe('true')
    expect(typeof body.properties.waiting_for_room).toBe('string')
  })

  it('never calls Stripe or dispatch, holds no code and writes no sign-up record', async () => {
    const { deps, create, dispatch, redis } = await fullSetup()
    const before = redis.keys().sort()
    await handleCreateCheckout({ ...BODY, code: 'PILOT-AAAA' }, deps)
    expect(create).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.keys().sort()).toEqual(before)
    expect(redis.keys().some(k => k.startsWith('signup:') || k.startsWith('promo:'))).toBe(false)
  })

  it('a room check that throws counts as full', async () => {
    const { deps, create, capacity } = await fullSetup()
    capacity.hasRoom.mockImplementation(async () => { throw new Error('boom') })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(409)
    expect(create).not.toHaveBeenCalled()
  })

  it('a Resend failure still answers the full reply, and the log has no address', async () => {
    const { deps, create, capacity, logs } = await fullSetup()
    capacity.waitlist.mockImplementation(async () => { throw new Error(`failed for ${INVITED}`) })
    const r = await handleCreateCheckout(BODY, deps)
    expect(r).toEqual({ status: 409, body: { message: FULL_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
    expect(logs.join('\n')).not.toContain(INVITED)
  })

  it('a used invite is still refused as used, before the room is asked', async () => {
    const { deps, redis, capacity } = await fullSetup()
    await redis.set(`invite:u:${deps.session!.inviteId}`, 'cs_other')
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(409)
    expect(r.body).not.toEqual({ message: FULL_MESSAGE })
    expect(capacity.hasRoom).not.toHaveBeenCalled()
  })

  it('the public flow (launch open) is refused the same way and its form email is kept', async () => {
    const { deps, create, capacity } = await fullSetup({ open: true, session: null, redis: undefined })
    const r = await handleCreateCheckout({ ...BODY, email: 'public.person@example.org' }, deps)
    expect(r).toEqual({ status: 409, body: { message: FULL_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
    expect(capacity.waitlist).toHaveBeenCalledWith('public.person@example.org')
  })

  it('with room, the checkout goes ahead and nobody is added to the waiting list', async () => {
    const { deps, create, capacity } = await fullSetup()
    capacity.hasRoom.mockImplementation(async () => true)
    const r = await handleCreateCheckout(BODY, deps)
    expect(r.status).toBe(200)
    expect(create).toHaveBeenCalledTimes(1)
    expect(capacity.waitlist).not.toHaveBeenCalled()
  })
})

describe('GET /api/capacity (handleCapacityRead)', () => {
  const session: InviteRecord = { inviteId: 'inv_1', emailHmac: 'h', email: 'invited.person@example.com' }

  it('an invited session with no room gets {room: false} and its address is added once with waiting_for_room "true"', async () => {
    const redis = new FakeRedis()
    const fetch = vi.fn(async () => ({ object: 'contact' }) as unknown)
    const waitlist = vi.fn((email: string) => recordWaitingForRoom(email, { apiKey: 're_test', segmentId: 'seg_1', fetch }))
    const r = await handleCapacityRead({ redis, session, hasRoom: async () => false, waitlist })
    expect(r).toEqual({ room: false })
    expect(waitlist).toHaveBeenCalledTimes(1)
    expect(waitlist).toHaveBeenCalledWith('invited.person@example.com')
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = (fetch.mock.calls[0] as unknown as [string, { body: Record<string, any> }])[1].body
    expect(body.properties.waiting_for_room).toBe('true')
    expect(typeof body.properties.waiting_for_room).toBe('string')
  })

  it('with room it answers {room: true} and adds nothing', async () => {
    const waitlist = vi.fn(async () => {})
    expect(await handleCapacityRead({ redis: new FakeRedis(), session, hasRoom: async () => true, waitlist })).toEqual({ room: true })
    expect(waitlist).not.toHaveBeenCalled()
  })

  it('a reload by the same invite does not add the address again', async () => {
    const redis = new FakeRedis()
    const waitlist = vi.fn(async () => {})
    await handleCapacityRead({ redis, session, hasRoom: async () => false, waitlist })
    await handleCapacityRead({ redis, session, hasRoom: async () => false, waitlist })
    expect(waitlist).toHaveBeenCalledTimes(1)
    expect(redis.dump()).not.toContain('invited.person@example.com')
  })

  it('a failed add is tried again on the next read, and the reply is still {room: false}', async () => {
    const redis = new FakeRedis()
    const waitlist = vi.fn().mockRejectedValueOnce(new Error('resend down')).mockResolvedValueOnce(undefined)
    expect(await handleCapacityRead({ redis, session, hasRoom: async () => false, waitlist })).toEqual({ room: false })
    expect(await handleCapacityRead({ redis, session, hasRoom: async () => false, waitlist })).toEqual({ room: false })
    expect(waitlist).toHaveBeenCalledTimes(2)
  })

  it('no session (launch open, not invited): {room: false} and no address to add', async () => {
    const waitlist = vi.fn(async () => {})
    expect(await handleCapacityRead({ redis: new FakeRedis(), session: null, hasRoom: async () => false, waitlist })).toEqual({ room: false })
    expect(waitlist).not.toHaveBeenCalled()
  })

  it('a room check that throws answers {room: false}, never an error', async () => {
    const r = await handleCapacityRead({ redis: new FakeRedis(), session, hasRoom: async () => { throw new Error('x') }, waitlist: async () => {} })
    expect(r).toEqual({ room: false })
  })

  it('the reply has exactly one key, room', async () => {
    const r = await handleCapacityRead({ redis: new FakeRedis(), session, hasRoom: async () => true, waitlist: async () => {} })
    expect(Object.keys(r)).toEqual(['room'])
  })
})

// --- Task 2: the in-flight count from create-checkout to complete, final stop or expiry ---

const PID = 'A1b2C3d4E5f6G7h8I9j0Kl'
const SID = 'cs_test_capacity'

describe('addInflight and removeInflight: capacity:inflight, score = expiry 45 minutes out', () => {
  it('addInflight adds the provision id with a 45-minute score, and hasRoom counts it', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 5000 })
    expect(await room(redis)).toBe(true)
    await addInflight(redis, PID, T0)
    expect(INFLIGHT_SECONDS).toBe(2700)
    expect(await redis.zrangebyscore(INFLIGHT_KEY, '-inf', '+inf')).toEqual([PID])
    expect(await redis.zcount(INFLIGHT_KEY, T0 + 2700 * 1000, T0 + 2700 * 1000)).toBe(1)
    expect(await room(redis)).toBe(false)
  })

  it('hasRoom counts only unexpired members: after 45 minutes the sign-up no longer holds room', async () => {
    const redis = await reported({ ...GOOD, memAvailableMb: 5000 })
    await addInflight(redis, PID, T0)
    // A fresh reading 46 minutes later, with the member still in the set.
    await recordReport({ ...GOOD, memAvailableMb: 5000 }, BEARER, { redis, secret: SECRET, now: () => T0 + 46 * 60 * 1000 })
    await redis.zadd(INFLIGHT_KEY, { score: T0 + 45 * 60 * 1000, member: PID })
    expect(await room(redis, { now: T0 + 46 * 60 * 1000 })).toBe(true)
  })

  it('adding the same provision id again keeps one member and moves its expiry', async () => {
    const redis = new FakeRedis()
    await addInflight(redis, PID, T0)
    await addInflight(redis, PID, T0 + 10 * 60 * 1000)
    expect(await redis.zcard(INFLIGHT_KEY)).toBe(1)
    expect(await redis.zcount(INFLIGHT_KEY, T0 + 55 * 60 * 1000, T0 + 55 * 60 * 1000)).toBe(1)
  })

  it('drops expired members on the way, so the set does not grow', async () => {
    const redis = new FakeRedis()
    await redis.zadd(INFLIGHT_KEY, { score: T0 - 1, member: 'BBBBBBBBBBBBBBBBBBBBBB' })
    await addInflight(redis, PID, T0)
    expect(await redis.zrangebyscore(INFLIGHT_KEY, '-inf', '+inf')).toEqual([PID])
  })

  it('removeInflight removes the member and leaves the others', async () => {
    const redis = new FakeRedis()
    await addInflight(redis, PID, T0)
    await addInflight(redis, 'BBBBBBBBBBBBBBBBBBBBBB', T0)
    await removeInflight(redis, PID)
    expect(await redis.zrangebyscore(INFLIGHT_KEY, '-inf', '+inf')).toEqual(['BBBBBBBBBBBBBBBBBBBBBB'])
  })
})

describe('create-checkout counts the sign-up in flight', () => {
  const INVITED = 'invited.person@example.com'
  const BODY = { communityName: 'Repair Collective', subdomain: 'repair' }

  async function roomySetup(url: string | null = 'https://checkout.stripe.com/c/pay_1') {
    const redis = new FakeRedis()
    const { inviteId } = await addInvite(redis, 'hash-secret', { email: INVITED, kind: 'wave', wave: 'w1' })
    const session: InviteRecord = { inviteId, emailHmac: emailKey('hash-secret', INVITED), email: INVITED }
    const create = vi.fn(async (_p: unknown) => ({ url }))
    const capacity = roomyCapacity()
    const deps: CheckoutDeps = {
      open: false, session, stripe: { checkout: { sessions: { create } } }, redis, priceId: 'price_1', paidSignupsEnabled: true, currency: 'usd',
      origin: 'https://localnodes.xyz', newProvisionId: () => PID, capacity
    }
    return { create, capacity, deps }
  }

  it('after the Stripe session is created, the provision id is added in flight', async () => {
    const { deps, create, capacity } = await roomySetup()
    expect((await handleCreateCheckout(BODY, deps)).status).toBe(200)
    expect(capacity.addInflight).toHaveBeenCalledTimes(1)
    expect(capacity.addInflight).toHaveBeenCalledWith(PID)
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(capacity.addInflight.mock.invocationCallOrder[0]!)
  })

  it('no URL from Stripe, a Stripe error, or a full server: nothing is added', async () => {
    const noUrl = await roomySetup(null)
    await handleCreateCheckout(BODY, noUrl.deps)
    expect(noUrl.capacity.addInflight).not.toHaveBeenCalled()

    const boom = await roomySetup()
    boom.create.mockImplementation(async () => { throw new Error('stripe down') })
    await expect(handleCreateCheckout(BODY, boom.deps)).rejects.toThrow('stripe down')
    expect(boom.capacity.addInflight).not.toHaveBeenCalled()

    const full = await roomySetup()
    full.capacity.hasRoom.mockImplementation(async () => false)
    await handleCreateCheckout(BODY, full.deps)
    expect(full.capacity.addInflight).not.toHaveBeenCalled()
  })

  it('a failure to count it still returns the checkout URL (the member would only hold room, never block)', async () => {
    const { deps, capacity } = await roomySetup()
    capacity.addInflight.mockImplementation(async () => { throw new Error('upstash down') })
    expect(await handleCreateCheckout(BODY, deps)).toEqual({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay_1' } })
  })
})

describe('the in-flight member is removed when the sign-up ends', () => {
  const CB_SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
  const bearer = `Bearer ${callbackToken(CB_SECRET, PID)}`

  async function seeded() {
    const redis = new FakeRedis()
    await redis.set(`provision:by-id:${PID}`, SID, { ex: 86400 })
    await redis.set(`provision:${SID}:lock`, 'locked', { nx: true, ex: 3600 })
    await redis.hset(`provision:${SID}`, { status: 'provisioning', subdomain: 'cascadia', provisionId: PID, attempt: 1, failedAttempts: 0, startedAt: '2026-11-08T10:00:00Z' })
    await redis.hset(`signup:${PID}`, { subdomain: 'cascadia', email: 'organizer@example.org', inviteId: 'inv_1', setupIntentId: 'seti_1' })
    await addInflight(redis, PID, Date.now())
    await addInflight(redis, 'BBBBBBBBBBBBBBBBBBBBBB', Date.now())
    const stripe = {
      setupIntents: { retrieve: vi.fn().mockResolvedValue({ payment_method: 'pm_1' }) },
      paymentMethods: { detach: vi.fn().mockResolvedValue({}) }
    }
    const deps: RetryStopDeps = {
      redis,
      stripe: () => stripe,
      mail: { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', fetch: vi.fn().mockResolvedValue({ id: 'e1' }) },
      // The app delete (23-37): a mocked dispatch, never GitHub.
      teardown: vi.fn().mockResolvedValue(undefined),
      dispatch: vi.fn().mockResolvedValue({ runId: 1, runUrl: 'https://example.test/run/1' }),
      log: () => {}
    }
    const members = () => redis.zrangebyscore(INFLIGHT_KEY, '-inf', '+inf')
    return { redis, deps, members }
  }

  it('a ready callback removes it (23-32: the site is running; complete is the sign-up app\'s own word now)', async () => {
    const { redis, deps, members } = await seeded()
    expect(await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready', site_url: 'https://cascadia.localnodes.xyz' }, { provisionCallbackSecret: CB_SECRET }, redis, deps)).toEqual({ updated: true })
    expect(await members()).toEqual(['BBBBBBBBBBBBBBBBBBBBBB'])
  })

  it('a progress callback (installing) keeps it', async () => {
    const { redis, deps, members } = await seeded()
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'installing' }, { provisionCallbackSecret: CB_SECRET }, redis, deps)
    expect(await members()).toContain(PID)
  })

  it('a first failure keeps it: the free retry will build again', async () => {
    const { redis, deps, members } = await seeded()
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'failed', reason: 'deploy_timeout' }, { provisionCallbackSecret: CB_SECRET }, redis, deps)
    expect(await members()).toContain(PID)
  })

  it('a ready callback whose removal fails is still applied', async () => {
    const { redis, deps } = await seeded()
    redis.zrem = async () => { throw new Error('upstash down') }
    expect(await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'ready', site_url: 'https://cascadia.localnodes.xyz' }, { provisionCallbackSecret: CB_SECRET }, redis, deps)).toEqual({ updated: true })
    expect((await redis.hgetall<Record<string, unknown>>(`provision:${SID}`))?.status).toBe('ready')
  })

  it('the final stop (stopProvision) removes it as its own step, stopCapacity, before stopped is set', async () => {
    const { redis, deps, members } = await seeded()
    // 23-43 Task 2: a stop runs only from a build that failed twice (status failed, two failures).
    await redis.hset(`provision:${SID}`, { status: 'failed', failedAttempts: 2 })
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(await members()).toEqual(['BBBBBBBBBBBBBBBBBBBBBB'])
    expect(await redis.hgetall(`provision:${SID}`)).toMatchObject({ stopHold: true, stopLock: true, stopCard: true, stopMail: true, stopCapacity: true, stopped: true })
  })

  it('a stop cut short at the capacity step is not marked stopped, and the next run finishes it without repeating a step', async () => {
    const { redis, deps, members } = await seeded()
    // 23-43 Task 2: a stop runs only from a build that failed twice (status failed, two failures).
    await redis.hset(`provision:${SID}`, { status: 'failed', failedAttempts: 2 })
    const zrem = redis.zrem.bind(redis)
    redis.zrem = async () => { throw new Error('upstash down') }
    await expect(stopProvision(SID, deps)).rejects.toThrow('upstash down')
    const cut = await redis.hgetall<Record<string, unknown>>(`provision:${SID}`)
    expect(cut).toMatchObject({ stopMail: true })
    expect(cut?.stopCapacity).toBeUndefined()
    expect(cut?.stopped).toBeUndefined()
    redis.zrem = zrem
    const mail = deps.mail!.fetch as ReturnType<typeof vi.fn>
    expect(await stopProvision(SID, deps)).toEqual({ stopped: true })
    expect(mail).toHaveBeenCalledTimes(1)
    expect(await members()).toEqual(['BBBBBBBBBBBBBBBBBBBBBB'])
  })

  it('a retry does not add a second member; it moves the expiry, so the new build is still counted', async () => {
    const { redis, deps } = await seeded()
    await handleProvisionCallback(bearer, { provision_id: PID, attempt: 1, status: 'failed', reason: 'deploy_timeout' }, { provisionCallbackSecret: CB_SECRET }, redis, deps)
    const later = Date.now() + 40 * 60 * 1000
    expect((await retryProvisioning(SID, { ...deps, now: () => later })).status).toBe(200)
    expect(await redis.zcard(INFLIGHT_KEY)).toBe(2)
    expect(await redis.zcount(INFLIGHT_KEY, later + INFLIGHT_SECONDS * 1000, later + INFLIGHT_SECONDS * 1000)).toBe(1)
  })
})

describe('the Stripe webhook: expired releases the in-flight member, completed re-arms it', () => {
  const WH_SECRET = 'whsec_test_secret'
  const stripeLib = new Stripe('sk_test_not_used')

  function signed(type: string, metadata: Record<string, string> = { provision_id: PID }) {
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object: { id: SID, object: 'checkout.session', metadata } } })
    return { payload, sig: stripeLib.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET }) }
  }

  function deps(redis: FakeRedis, open: boolean, logs: string[], now = T0): WebhookDeps {
    return {
      open,
      constructEvent: (body, sig) => stripeLib.webhooks.constructEvent(body, sig, WH_SECRET),
      onCheckoutCompleted: vi.fn(async () => {}),
      releaseCapacity: s => releaseSessionCapacity(redis, s),
      rearmCapacity: s => rearmSessionCapacity(redis, s, () => now),
      log: m => { logs.push(m) }
    }
  }

  it.each([['closed', false], ['open', true]])('checkout.session.expired removes the member while %s', async (_l, open) => {
    const redis = new FakeRedis()
    await addInflight(redis, PID, T0)
    const { payload, sig } = signed('checkout.session.expired')
    expect((await handleStripeWebhook(payload, sig, deps(redis, open, []))).status).toBe(200)
    expect(await redis.zcard(INFLIGHT_KEY)).toBe(0)
  })

  it('a removal that fails is logged and the event is still answered 200', async () => {
    const redis = new FakeRedis()
    redis.zrem = async () => { throw new Error('upstash down') }
    const logs: string[] = []
    const { payload, sig } = signed('checkout.session.expired')
    expect((await handleStripeWebhook(payload, sig, deps(redis, false, logs))).status).toBe(200)
    expect(logs.join('\n')).toContain('could not release')
    expect(logs.join('\n')).not.toContain(PID)
  })

  it('an expired session with no or a malformed provision id touches nothing', async () => {
    const redis = new FakeRedis()
    await addInflight(redis, PID, T0)
    for (const metadata of [{}, { provision_id: 'not a provision id' }]) {
      const { payload, sig } = signed('checkout.session.expired', metadata)
      expect((await handleStripeWebhook(payload, sig, deps(redis, true, []))).status).toBe(200)
    }
    expect(await redis.zcard(INFLIGHT_KEY)).toBe(1)
  })

  it('a completed session (launch open) moves the member\'s expiry to 45 minutes from completion, so a slow checkout is still counted while it builds', async () => {
    const redis = new FakeRedis()
    await addInflight(redis, PID, T0)
    const done = T0 + 40 * 60 * 1000
    const { payload, sig } = signed('checkout.session.completed')
    expect((await handleStripeWebhook(payload, sig, deps(redis, true, [], done))).status).toBe(200)
    expect(await redis.zcard(INFLIGHT_KEY)).toBe(1)
    expect(await redis.zcount(INFLIGHT_KEY, done + INFLIGHT_SECONDS * 1000, done + INFLIGHT_SECONDS * 1000)).toBe(1)
  })
})
