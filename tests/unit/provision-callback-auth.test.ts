import { describe, it, expect, beforeEach, vi } from 'vitest'
import { callbackToken, handleProvisionCallback, handleProvisionStatus } from '../../server/utils/provision-handlers'
import { CALLBACK_STATUSES, PROVISION_STATUSES, REASON_CODES } from '../../shared/provisioning'
import { BILLING_INDEX } from '../../server/utils/billing'
import { INFLIGHT_KEY } from '../../server/utils/capacity'
import { provisionKeyName } from '../../server/utils/byo-key'
import { FakeRedis } from './helpers/fake-redis'

/**
 * POST /api/provision-callback (Phase 23, plan 23-11, D-17, T-23-35).
 *
 * Each site reports with Authorization: Bearer hex HMAC-SHA256(secret,
 * provision_id). The shared secret alone, a wrong token, or another
 * provision's token is a 401. Fakes only; the secrets are test strings.
 */

// 64 hex characters, the shape `openssl rand -hex 32` makes, so the shared
// secret has the same length as a token and a wrong-token case reaches the
// compare instead of stopping at a length check.
const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CONFIG = { provisionCallbackSecret: SECRET }
const PID_A = 'A1b2C3d4E5f6G7h8I9j0Kl'
const PID_B = 'Zy9X8w7V6u5T4s3R2q1P0o'
const SID_A = 'cs_test_site_a'
const SID_B = 'cs_test_site_b'

const statusOf = (err: unknown) => (err as { statusCode?: number }).statusCode

async function seed(redis: FakeRedis, sid: string, pid: string, extra: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${pid}`, sid, { ex: 86400 })
  await redis.hset(`provision:${sid}`, {
    status: 'provisioning',
    subdomain: 'cascadia',
    provisionId: pid,
    attempt: 1,
    failedAttempts: 0,
    startedAt: '2026-03-04T10:00:00Z',
    updatedAt: '2026-03-04T10:00:00Z',
    ...extra
  })
}

describe('callbackToken (server/utils/provision-handlers.ts)', () => {
  it('is 64 lowercase hex characters, the same every time for one secret and id', () => {
    const t = callbackToken(SECRET, PID_A)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(callbackToken(SECRET, PID_A)).toBe(t)
  })

  it('differs for another id and for another secret', () => {
    expect(callbackToken(SECRET, PID_B)).not.toBe(callbackToken(SECRET, PID_A))
    expect(callbackToken('another-secret', PID_A)).not.toBe(callbackToken(SECRET, PID_A))
  })

  it('matches hex HMAC-SHA256 as the workflow computes it with openssl dgst', () => {
    // The published HMAC-SHA256 test vector (RFC 4231 style, key "key"); the workflow's openssl dgst -sha256 -hmac gives the same hex
    expect(callbackToken('key', 'The quick brown fox jumps over the lazy dog'))
      .toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })
})

describe('shared lists (Pitfall 14)', () => {
  it('holds the twelve statuses and the sixteen reason codes, once (23-32 adds ready, held and declined; 23-43 Task 7 refunding and refunded, page statuses only; pilot web3 B5 the two web3 codes)', () => {
    expect([...PROVISION_STATUSES]).toEqual(
      ['triggered', 'provisioning', 'installing', 'creating_user', 'sending_email', 'ready', 'held', 'declined', 'complete', 'failed', 'refunding', 'refunded']
    )
    expect(REASON_CODES).toHaveLength(16)
    expect(new Set(REASON_CODES).size).toBe(16)
    for (const code of [
      'invalid_request', 'coolify_unreachable', 'subdomain_taken', 'create_failed', 'env_failed', 'deploy_failed',
      'deploy_timeout', 'install_timeout', 'manifest_failed', 'unknown',
      'install_failed', 'db_not_empty', 'platform_enable_failed', 'organizer_failed',
      'web3_enable_failed', 'web3_check_failed'
    ]) {
      expect(REASON_CODES).toContain(code)
    }
  })
})

describe('provision-callback: per-provision token', () => {
  let redis: FakeRedis

  beforeEach(async () => {
    redis = new FakeRedis()
    await seed(redis, SID_A, PID_A)
    await seed(redis, SID_B, PID_B)
  })

  const call = (header: string | undefined, body: unknown, config = CONFIG) =>
    handleProvisionCallback(header, body, config, redis)

  const bearer = (pid: string) => `Bearer ${callbackToken(SECRET, pid)}`

  it('accepts the token for the body\'s own id, updates state, and the status reply shows it', async () => {
    const result = await call(bearer(PID_A), {
      provision_id: PID_A,
      attempt: 1,
      status: 'installing',
      site_url: 'https://cascadia.localnodes.xyz'
    })
    expect(result).toEqual({ updated: true })
    expect(await handleProvisionStatus(SID_A, redis)).toMatchObject({
      status: 'installing',
      siteUrl: 'https://cascadia.localnodes.xyz'
    })
  })

  it('stores reason and app uuid from a failed callback and refreshes the 24-hour life', async () => {
    // 23-43: a lifetime is raised to the day, never lowered or set where none was.
    await redis.expire(`provision:${SID_A}`, 3600)
    await call(bearer(PID_A), {
      provision_id: PID_A,
      attempt: 1,
      status: 'failed',
      reason: 'deploy_timeout',
      app_uuid: 'abcdefghijklmnopqrstuvwx'
    })
    const state = await redis.hgetall<Record<string, unknown>>(`provision:${SID_A}`)
    expect(state).toMatchObject({ status: 'failed', reason: 'deploy_timeout', appUuid: 'abcdefghijklmnopqrstuvwx' })
    expect(await redis.ttl(`provision:${SID_A}`)).toBeGreaterThan(86000)
  })

  it('answers the shared secret alone with 401 and writes nothing (T-23-35)', async () => {
    const before = redis.dump()
    const err = await call(`Bearer ${SECRET}`, { provision_id: PID_A, attempt: 1, status: 'complete' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
    expect(redis.dump()).toBe(before)
  })

  it('answers another provision\'s token on this body with 401 and writes nothing', async () => {
    const before = redis.dump()
    const err = await call(bearer(PID_B), { provision_id: PID_A, attempt: 1, status: 'failed', reason: 'unknown' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
    expect(redis.dump()).toBe(before)
  })

  it('answers a wrong token of the right length with 401', async () => {
    const wrong = callbackToken('some-other-secret', PID_A)
    const err = await call(`Bearer ${wrong}`, { provision_id: PID_A, attempt: 1, status: 'installing' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
  })

  it.each([
    ['no header', undefined],
    ['a header without Bearer', 'Basic abc']
  ])('answers %s with 401', async (_label, header) => {
    const err = await call(header, { provision_id: PID_A, attempt: 1, status: 'installing' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
  })

  it('answers a body with no usable provision id with 401, whatever the token', async () => {
    const err = await call(bearer(PID_A), { attempt: 1, status: 'installing' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
  })

  it('fails closed when no callback secret is configured: a token made from an empty key is refused', async () => {
    const forged = callbackToken('', PID_A)
    const err = await call(`Bearer ${forged}`, { provision_id: PID_A, attempt: 1, status: 'complete' }, { provisionCallbackSecret: '' }).catch(e => e)
    expect(statusOf(err)).toBe(401)
  })

  it('answers a valid token for an id the app never issued with 404 and writes nothing', async () => {
    const stranger = 'Qq0Ww1Ee2Rr3Tt4Yy5Uu6I'
    const before = redis.dump()
    const err = await call(bearer(stranger), { provision_id: stranger, attempt: 1, status: 'installing' }).catch(e => e)
    expect(statusOf(err)).toBe(404)
    expect(redis.dump()).toBe(before)
  })

  it('rejects a status that is not a callback status', async () => {
    const err = await call(bearer(PID_A), { provision_id: PID_A, attempt: 1, status: 'invalid_status' }).catch(e => e)
    expect(statusOf(err)).toBe(400)
  })

  it('rejects a site address that is not https', async () => {
    const err = await call(bearer(PID_A), { provision_id: PID_A, attempt: 1, status: 'installing', site_url: 'javascript:alert(1)' }).catch(e => e)
    expect(statusOf(err)).toBe(400)
  })

  it('stores an unknown reason as "unknown", never as free text, and still records the failure', async () => {
    await call(bearer(PID_A), { provision_id: PID_A, attempt: 1, status: 'failed', reason: 'Coolify said: token abc expired' })
    const state = await redis.hgetall<Record<string, unknown>>(`provision:${SID_A}`)
    expect(state).toMatchObject({ status: 'failed', reason: 'unknown' })
    expect(redis.dump()).not.toContain('Coolify said')
  })

  it('does not touch another site\'s state', async () => {
    await call(bearer(PID_A), { provision_id: PID_A, attempt: 1, status: 'ready', site_url: 'https://cascadia.localnodes.xyz' })
    const other = await redis.hgetall<Record<string, unknown>>(`provision:${SID_B}`)
    expect(other).toMatchObject({ status: 'provisioning' })
  })
})

describe('provision-callback: refusals and replays (Task 2)', () => {
  let redis: FakeRedis

  beforeEach(async () => {
    redis = new FakeRedis()
    await seed(redis, SID_A, PID_A)
  })

  const call = (header: string | undefined, body: unknown) => handleProvisionCallback(header, body, CONFIG, redis)
  const bearer = (pid: string) => `Bearer ${callbackToken(SECRET, pid)}`
  const body = (over: Record<string, unknown> = {}) => ({ provision_id: PID_A, attempt: 1, status: 'installing', ...over })

  it.each([
    ['shorter than a token', 'abc123'],
    ['longer than a token', `${callbackToken(SECRET, PID_A)}00`],
    ['empty after Bearer', ''],
    ['one character short', callbackToken(SECRET, PID_A).slice(0, 63)]
  ])('answers a token %s with 401, without throwing anything else', async (_label, token) => {
    const err = await call(`Bearer ${token}`, body()).catch(e => e)
    expect(statusOf(err)).toBe(401)
    expect(await redis.hgetall(`provision:${SID_A}`)).toMatchObject({ status: 'provisioning' })
  })

  it('refuses a wrong token before it reads anything from Redis', async () => {
    const reads: string[] = []
    const spying = {
      get: async (k: string) => { reads.push(k); return null },
      hgetall: async (k: string) => { reads.push(k); return null },
      hset: async () => { reads.push('hset') },
      expire: async () => { reads.push('expire') }
    }
    const err = await handleProvisionCallback(`Bearer ${SECRET}`, body(), CONFIG, spying).catch(e => e)
    expect(statusOf(err)).toBe(401)
    expect(reads).toEqual([])
  })

  it('ignores a callback whose attempt is lower than the stored attempt', async () => {
    await redis.hset(`provision:${SID_A}`, { attempt: 2, status: 'provisioning', failedAttempts: 1 })
    const before = redis.dump()
    const result = await call(bearer(PID_A), body({ attempt: 1, status: 'failed', reason: 'deploy_failed' }))
    expect(result).toEqual({ updated: false })
    expect(redis.dump()).toBe(before)
  })

  it('accepts a callback for the stored attempt', async () => {
    await redis.hset(`provision:${SID_A}`, { attempt: 2 })
    const result = await call(bearer(PID_A), body({ attempt: 2, status: 'installing' }))
    expect(result).toEqual({ updated: true })
    expect(await redis.hgetall(`provision:${SID_A}`)).toMatchObject({ status: 'installing' })
  })

  it('stores nothing for a sign-in link field, however it is spelled', async () => {
    const link = 'https://cascadia.localnodes.xyz/user/reset/1/abc123/login'
    await call(bearer(PID_A), body({
      status: 'ready',
      site_url: 'https://cascadia.localnodes.xyz',
      login_url: link,
      loginUrl: link,
      sign_in_url: link,
      error: 'Provisioning workflow failed'
    }))
    const dump = redis.dump()
    expect(dump).not.toContain('reset')
    expect(dump).not.toContain('abc123')
    expect(dump).not.toContain('Provisioning workflow failed')
    expect(await redis.hgetall(`provision:${SID_A}`)).toMatchObject({ status: 'ready', siteUrl: 'https://cascadia.localnodes.xyz' })
    expect(Object.keys((await redis.hgetall(`provision:${SID_A}`))!).sort()).toEqual(
      // lastOpId and readyAt: the transition's op id and the first ready (23-43); cbSeen:1:ready: the
      // per-callback key (code review fix round 1, C5), a time only.
      ['attempt', 'cbSeen:1:ready', 'failedAttempts', 'lastOpId', 'provisionId', 'readyAt', 'readyAtMs', 'siteUrl', 'startedAt', 'status', 'subdomain', 'updatedAt']
    )
  })

  it('a stale callback with a sign-in field changes nothing when its attempt is old', async () => {
    await redis.hset(`provision:${SID_A}`, { attempt: 2 })
    const before = redis.dump()
    await call(bearer(PID_A), body({ attempt: 1, status: 'ready', login_url: 'https://x.localnodes.xyz/user/reset/1/z/login' }))
    expect(redis.dump()).toBe(before)
  })
})


describe('provision-callback: ready starts billing; only the sign-up app writes complete (23-32, B-1 steps 1 to 3)', () => {
  let redis: FakeRedis
  let start: ReturnType<typeof vi.fn>
  let nudge: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    redis = new FakeRedis()
    await seed(redis, SID_A, PID_A, { status: 'sending_email' })
    await redis.zadd(INFLIGHT_KEY, { score: 9_999_999_999_999, member: PID_A })
    await redis.hset(provisionKeyName(PID_A), { kind: 'openrouter', sealed: 'sealed-canary' })
    start = vi.fn(async () => {})
    nudge = vi.fn(async () => {})
  })

  const bearer = `Bearer ${callbackToken(SECRET, PID_A)}`
  const call = (over: Record<string, unknown> = {}, withBilling = true) =>
    handleProvisionCallback(bearer, { provision_id: PID_A, attempt: 1, status: 'ready', site_url: 'https://cascadia.localnodes.xyz', source: 'site', ...over }, CONFIG, redis,
      withBilling ? { billing: { start, nudge }, log: () => {} } : { log: () => {} })
  const state = () => redis.hgetall<Record<string, unknown>>(`provision:${SID_A}`)

  // Pilot web3 B5: a practice site's ready carries its relayer's public address, kept for the
  // operator who funds the relayer. Never in the status reply; a malformed one is dropped.
  const RELAYER = '0x00000000000000000000000000000000000000A1'
  it('a ready with relayer_address stores it, and the status reply never shows it', async () => {
    expect(await call({ relayer_address: RELAYER })).toEqual({ updated: true })
    expect(await state()).toMatchObject({ status: 'ready', relayerAddress: RELAYER })
    const reply = await handleProvisionStatus(SID_A, redis)
    expect(reply).toMatchObject({ status: 'ready' })
    expect(JSON.stringify(reply)).not.toContain(RELAYER)
    expect(Object.keys(reply)).not.toContain('relayerAddress')
  })

  it('a ready without relayer_address (web3 off) writes no relayerAddress field', async () => {
    expect(await call()).toEqual({ updated: true })
    expect(Object.keys((await state()) ?? {})).not.toContain('relayerAddress')
  })

  it.each([
    ['too short', '0x1234'],
    ['not hex', '0xZZ000000000000000000000000000000000000A1'],
    ['no 0x', '00000000000000000000000000000000000000A1ab'],
    ['trailing text', `${'0x00000000000000000000000000000000000000A1'} key=abc`],
    ['a number', 12345],
    ['an object', { a: 1 }]
  ])('a malformed relayer_address (%s) is dropped and the ready still applies', async (_label, bad) => {
    expect(await call({ relayer_address: bad })).toEqual({ updated: true })
    const st = await state()
    expect(st).toMatchObject({ status: 'ready' })
    expect(Object.keys(st ?? {})).not.toContain('relayerAddress')
  })

  it('a relayer_address on a progress callback is not stored', async () => {
    await redis.hset(`provision:${SID_A}`, { status: 'installing' })
    expect(await call({ status: 'creating_user', relayer_address: RELAYER })).toEqual({ updated: true })
    expect(Object.keys((await state()) ?? {})).not.toContain('relayerAddress')
  })

  it('a ready over the site\'s own provisional failed (web3_check_failed, then the restart passes) stores the address', async () => {
    await redis.hset(`provision:${SID_A}`, { status: 'failed', reason: 'web3_check_failed', provisionalUntil: Date.now() + 600_000 })
    expect(await call({ relayer_address: RELAYER })).toEqual({ updated: true })
    expect(await state()).toMatchObject({ status: 'ready', relayerAddress: RELAYER, provisionalUntil: 0, reason: '' })
  })

  it('CALLBACK_STATUSES is the status list without held, declined and complete', () => {
    expect([...CALLBACK_STATUSES]).toEqual(['triggered', 'provisioning', 'installing', 'creating_user', 'sending_email', 'ready', 'failed'])
  })

  it('a callback with status complete answers 400 Invalid callback and writes nothing', async () => {
    const before = redis.dump()
    const err = await call({ status: 'complete' }).catch(e => e)
    expect(statusOf(err)).toBe(400)
    expect((err as Error).message).toBe('Invalid callback')
    expect(redis.dump()).toBe(before)
    expect(start).not.toHaveBeenCalled()
  })

  it.each(['held', 'declined'])('a callback with status %s answers 400', async (status) => {
    const err = await call({ status }).catch(e => e)
    expect(statusOf(err)).toBe(400)
  })

  it('a ready for the current attempt: updated, status ready with siteUrl, in-flight member and AI key gone, in sweep:billing, billing started once', async () => {
    expect(await call()).toEqual({ updated: true })
    expect(await state()).toMatchObject({ status: 'ready', siteUrl: 'https://cascadia.localnodes.xyz' })
    expect(await redis.zrangebyscore(INFLIGHT_KEY, '-inf', '+inf')).toEqual([])
    expect(await redis.exists(provisionKeyName(PID_A))).toBe(0)
    expect(await redis.zrangebyscore(BILLING_INDEX, '-inf', '+inf')).toEqual([SID_A])
    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(SID_A)
    expect(nudge).not.toHaveBeenCalled()
  })

  it('without billing deps a ready is recorded and waits in sweep:billing for the sweep', async () => {
    expect(await call({}, false)).toEqual({ updated: true })
    expect((await state())?.status).toBe('ready')
    expect(await redis.zrangebyscore(BILLING_INDEX, '-inf', '+inf')).toEqual([SID_A])
  })

  it('a repeated ready for a sign-up already in ready answers {updated: false}, writes nothing and nudges billing once', async () => {
    await call()
    const before = redis.dump()
    expect(await call()).toEqual({ updated: false })
    expect(redis.dump()).toBe(before)
    expect(start).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledWith(SID_A, PID_A)
  })

  it.each(['rejected', 'review'])('a repeated ready for a ready sign-up whose billing is %s nudges nothing (23-43 Task 3)', async (billing) => {
    await call()
    await redis.hset(`provision:${SID_A}`, { billing })
    expect(await call()).toEqual({ updated: false })
    expect(nudge).not.toHaveBeenCalled()
  })

  it('a repeated ready for a sign-up whose site never answered the probe (siteNeverAnswered) nudges nothing (23-43 Task 6)', async () => {
    await call()
    await redis.hset(`provision:${SID_A}`, { siteNeverAnswered: true })
    expect(await call()).toEqual({ updated: false })
    expect(nudge).not.toHaveBeenCalled()
  })

  it.each(['held', 'declined', 'complete'])('a ready for a sign-up in %s does nothing at all', async (stored) => {
    await redis.hset(`provision:${SID_A}`, { status: stored })
    const before = redis.dump()
    expect(await call()).toEqual({ updated: false })
    expect(redis.dump()).toBe(before)
    expect(start).not.toHaveBeenCalled()
    expect(nudge).not.toHaveBeenCalled()
  })

  it.each(['ready', 'held', 'declined', 'complete'])('after %s, a late installing or a workflow failed changes nothing', async (stored) => {
    await redis.hset(`provision:${SID_A}`, { status: stored, billing: 'paid' })
    const before = redis.dump()
    expect(await call({ status: 'installing', source: 'workflow' })).toEqual({ updated: false })
    expect(await call({ status: 'failed', reason: 'deploy_failed', source: 'workflow' })).toEqual({ updated: false })
    expect(await call({ status: 'failed', reason: 'organizer_failed', source: 'site' })).toEqual({ updated: false })
    expect(redis.dump()).toBe(before)
    expect((await state())?.status).toBe(stored)
  })

  it('the provisional window waits for ready: a site failed then ready inside the window ends ready', async () => {
    await call({ status: 'failed', reason: 'organizer_failed', source: 'site' })
    expect((await state())?.status).toBe('failed')
    expect(await call({ status: 'installing', source: 'workflow' })).toEqual({ updated: false })
    expect(await call()).toEqual({ updated: true })
    expect(await state()).toMatchObject({ status: 'ready', provisionalUntil: 0, failedAttempts: 0 })
    expect(start).toHaveBeenCalledTimes(1)
  })
})
