import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { handleManifest, handleManifestAck } from '../../server/utils/provision-manifest'
import { callbackToken } from '../../server/utils/provision-handlers'
import { gateDecision } from '../../shared/launch'
import { FakeRedis } from './helpers/fake-redis'

/**
 * GET /api/provision-manifest and POST /api/provision-manifest/ack (Phase 23,
 * plan 23-25, D-05, D-21, T-23-36, T-23-73).
 *
 * The provisioning workflow fetches a site's private details (organizer
 * address, community name, page types, AI choice) from here instead of
 * receiving them as workflow inputs. Only that site's own token opens its
 * manifest. Fakes only; the secrets and addresses are test strings.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const CONFIG = { provisionCallbackSecret: SECRET }
const PID_A = 'A1b2C3d4E5f6G7h8I9j0Kl'
const PID_B = 'Zy9X8w7V6u5T4s3R2q1P0o'
const PID_UNKNOWN = 'Nn0Oo1Pp2Qq3Rr4Ss5Tt6U'

const NINE_FIELDS = [
  'ai_key_source', 'ai_provider', 'community_seed', 'community_template', 'organizer_email', 'provision_id', 'site_name', 'subdomain', 'topic_types_b64'
]

/** Wraps FakeRedis and records every command, so a test can say "nothing was read". */
class SpyRedis extends FakeRedis {
  calls: string[] = []
  override async get<T = unknown>(key: string): Promise<T | null> {
    this.calls.push(`get ${key}`)
    return super.get<T>(key)
  }
  override async hgetall<T = Record<string, unknown>>(key: string): Promise<T | null> {
    this.calls.push(`hgetall ${key}`)
    return super.hgetall<T>(key)
  }
  override async del(...keys: string[]): Promise<number> {
    this.calls.push(`del ${keys.join(' ')}`)
    return super.del(...keys)
  }
}

const bearer = (pid: string, secret = SECRET) => `Bearer ${callbackToken(secret, pid)}`
const decodeTopics = (b64: string): unknown => JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))

async function seedSignup(redis: FakeRedis, pid: string, extra: Record<string, unknown> = {}) {
  await redis.hset(`signup:${pid}`, {
    subdomain: 'cascadia',
    communityName: 'Cascadia Commons',
    email: 'organizer@example.test',
    inviteId: 'inv_internal_1',
    topicTypes: ['Field Notes', 'Café Events'],
    aiProvider: 'gemini',
    aiKeySource: 'platform',
    createdAt: '2026-11-06T10:00:00Z',
    ...extra
  })
}

describe('provision-manifest: the fields', () => {
  let redis: SpyRedis
  const call = (query: unknown, header: string | undefined, config = CONFIG) =>
    handleManifest(query, header, { config, redis })

  beforeEach(async () => {
    redis = new SpyRedis()
    await seedSignup(redis, PID_A)
    await seedSignup(redis, PID_B, { subdomain: 'portland', communityName: 'Portland Commons', email: 'other@example.test' })
    redis.calls = []
  })

  it('with the right token returns exactly the nine fields for that site', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.status).toBe(200)
    expect(Object.keys(out.body).sort()).toEqual(NINE_FIELDS)
    expect(out.body).toMatchObject({
      provision_id: PID_A,
      subdomain: 'cascadia',
      site_name: 'Cascadia Commons',
      organizer_email: 'organizer@example.test',
      ai_provider: 'gemini',
      ai_key_source: 'platform'
    })
  })

  it('returns the confirmed page types as base64url JSON, with no padding and no + or /', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    const b64 = (out.body as { topic_types_b64: string }).topic_types_b64
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeTopics(b64)).toEqual(['Field Notes', 'Café Events'])
  })

  it('cleans the stored page types again: a label that breaks the rules or repeats a default never travels', async () => {
    await seedSignup(redis, PID_A, { topicTypes: ['Okay Type', '<script>', 'blog', 'x', 'Okay Type'] })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(decodeTopics((out.body as { topic_types_b64: string }).topic_types_b64)).toEqual(['Okay Type'])
  })

  it('sends an empty list when no page types were confirmed or the stored value is not a list', async () => {
    await seedSignup(redis, PID_A, { topicTypes: 'not a list' })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(decodeTopics((out.body as { topic_types_b64: string }).topic_types_b64)).toEqual([])
    await redis.del(`signup:${PID_B}`)
    await seedSignup(redis, PID_B, { topicTypes: undefined })
    const two = await call({ provision_id: PID_B }, bearer(PID_B))
    expect(decodeTopics((two.body as { topic_types_b64: string }).topic_types_b64)).toEqual([])
  })

  it('has no ai_key for a platform key', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.body).not.toHaveProperty('ai_key')
    expect(JSON.stringify(out.body)).not.toMatch(/ai_key"/)
  })

  it('never returns a stored field outside the nine (invite id, created time, anything else)', async () => {
    await seedSignup(redis, PID_A, { internalNote: 'do-not-send', apiKey: 'sk-not-a-real-key' })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(Object.keys(out.body).sort()).toEqual(NINE_FIELDS)
    const text = JSON.stringify(out.body)
    for (const leak of ['inv_internal_1', '2026-11-06', 'do-not-send', 'sk-not-a-real-key']) {
      expect(text).not.toContain(leak)
    }
  })

  it('returns a number-looking name and subdomain as strings (Upstash parses "2024" back as a number)', async () => {
    await seedSignup(redis, PID_A, { subdomain: '12345', communityName: '2024' })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.body).toMatchObject({ subdomain: '12345', site_name: '2024' })
  })

  it('returns the site name on one line, because the workflow refuses a multi-line value', async () => {
    await seedSignup(redis, PID_A, { communityName: 'Line one\nLine two\r\n  three' })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect((out.body as { site_name: string }).site_name).toBe('Line one Line two three')
  })

  it('answers each site its own details only', async () => {
    const b = await call({ provision_id: PID_B }, bearer(PID_B))
    expect(b.body).toMatchObject({ provision_id: PID_B, subdomain: 'portland', organizer_email: 'other@example.test' })
    expect(JSON.stringify(b.body)).not.toContain('organizer@example.test')
  })

  it('passes the provider and key source it was told, and falls back to gemini and platform when the record has none', async () => {
    await seedSignup(redis, PID_A, { aiProvider: undefined, aiKeySource: undefined })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.body).toMatchObject({ ai_provider: 'gemini', ai_key_source: 'platform' })
  })

  it.each([
    ['aiProvider', 'mystery-ai'],
    ['aiKeySource', 'stolen']
  ])('answers 404 for a record with an unrecognised %s, so a site is never set up on a guess', async (field, value) => {
    await seedSignup(redis, PID_A, { [field]: value })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.status).toBe(404)
    expect(JSON.stringify(out.body)).not.toContain('organizer@example.test')
  })

  it.each([
    ['subdomain'],
    ['communityName'],
    ['email']
  ])('answers 404 for a record that lacks %s', async (field) => {
    await seedSignup(redis, PID_A, { [field]: undefined })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.status).toBe(404)
  })

  it('answers 404 for an address with a space or control character', async () => {
    await seedSignup(redis, PID_A, { email: 'a@example.test\nBcc: b@example.test' })
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.status).toBe(404)
  })
})

describe('provision-manifest: who may read it', () => {
  let redis: SpyRedis
  const call = (query: unknown, header: string | undefined, config = CONFIG) =>
    handleManifest(query, header, { config, redis })

  beforeEach(async () => {
    redis = new SpyRedis()
    await seedSignup(redis, PID_A)
    await seedSignup(redis, PID_B, { subdomain: 'portland', email: 'other@example.test' })
    redis.calls = []
  })

  it.each([
    ['no header', () => undefined],
    ['a header without Bearer', () => 'Basic abc'],
    ['an empty bearer', () => 'Bearer '],
    ['the shared secret alone', () => `Bearer ${SECRET}`],
    ['another site\'s token', () => bearer(PID_B)],
    ['a token made with another secret', () => bearer(PID_A, 'some-other-secret')],
    ['a token of the wrong length', () => 'Bearer abc123']
  ])('answers %s with 401 and reads nothing from Redis (T-23-36)', async (_label, header) => {
    const out = await call({ provision_id: PID_A }, header())
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
    expect(JSON.stringify(out.body)).not.toMatch(/example\.test|cascadia/i)
  })

  it('answers 401 with no Redis read when the server has no callback secret, even for a token made from an empty key', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A, ''), { provisionCallbackSecret: '' })
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
  })

  it.each([
    ['no id', {}],
    ['an id of the wrong shape', { provision_id: 'short' }],
    ['an id with a path in it', { provision_id: '../signup:A1b2C3d4E5f6G7h8I9j' }],
    ['a repeated id', { provision_id: [PID_A, PID_B] }],
    ['a null query', null]
  ])('answers %s with 401 and reads nothing from Redis', async (_label, query) => {
    const out = await call(query, bearer(PID_A))
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
  })

  it('answers 404 for an id nobody holds, with a valid token for that id', async () => {
    const out = await call({ provision_id: PID_UNKNOWN }, bearer(PID_UNKNOWN))
    expect(out.status).toBe(404)
    expect(redis.calls).toEqual([`hgetall signup:${PID_UNKNOWN}`])
  })

  it('reads only the signup record of the id it was asked for, once', async () => {
    await call({ provision_id: PID_A }, bearer(PID_A))
    expect(redis.calls).toEqual([`hgetall signup:${PID_A}`])
  })

  it('answers every refusal with the same short body, so the reply shows nothing about the site', async () => {
    const wrong = await call({ provision_id: PID_A }, bearer(PID_B))
    const unknown = await call({ provision_id: PID_UNKNOWN }, bearer(PID_UNKNOWN))
    expect(Object.keys(wrong.body)).toEqual(['message'])
    expect(Object.keys(unknown.body)).toEqual(['message'])
  })
})

describe('provision-manifest: caching and the launch gate', () => {
  let redis: SpyRedis
  const call = (query: unknown, header: string | undefined) =>
    handleManifest(query, header, { config: CONFIG, redis })

  beforeEach(async () => {
    redis = new SpyRedis()
    await seedSignup(redis, PID_A)
  })

  it('sends Cache-Control no-store with the manifest, the 401 and the 404 (D-21)', async () => {
    const ok = await call({ provision_id: PID_A }, bearer(PID_A))
    const denied = await call({ provision_id: PID_A }, undefined)
    const missing = await call({ provision_id: PID_UNKNOWN }, bearer(PID_UNKNOWN))
    for (const out of [ok, denied, missing]) {
      expect(out.headers['Cache-Control']).toBe('no-store')
    }
  })

  it('is not behind the launch gate: the workflow calls it while the flag is closed', () => {
    expect(gateDecision('/api/provision-manifest', false)).toBe('pass')
    expect(gateDecision('/api/provision-manifest/ack', false)).toBe('pass')
  })
})

describe('provision-manifest ack: the sealed key slot', () => {
  let redis: SpyRedis
  const call = (body: unknown, header: string | undefined, config = CONFIG) =>
    handleManifestAck(body, header, { config, redis })

  beforeEach(async () => {
    redis = new SpyRedis()
    await seedSignup(redis, PID_A)
    await redis.set(`byok:${PID_A}`, 'sealed-test-blob-a', { ex: 86400 })
    await redis.set(`byok:${PID_B}`, 'sealed-test-blob-b', { ex: 86400 })
    redis.calls = []
  })

  it('with the right token deletes byok:{provisionId} and answers 200', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(out.status).toBe(200)
    expect(await redis.exists(`byok:${PID_A}`)).toBe(0)
  })

  it('answers 200 when nothing was there (a platform key, a second ack, or a slot that already expired)', async () => {
    await call({ provision_id: PID_A }, bearer(PID_A))
    const again = await call({ provision_id: PID_A }, bearer(PID_A))
    expect(again.status).toBe(200)
    const neverHadOne = await call({ provision_id: PID_UNKNOWN }, bearer(PID_UNKNOWN))
    expect(neverHadOne.status).toBe(200)
  })

  it('answers the same whether or not a key was there, so the reply does not say if the site brought one', async () => {
    const had = await call({ provision_id: PID_A }, bearer(PID_A))
    const hadNone = await call({ provision_id: PID_UNKNOWN }, bearer(PID_UNKNOWN))
    expect(hadNone.body).toEqual(had.body)
  })

  it('deletes that site\'s slot only: another site\'s key and the signup record stay', async () => {
    await call({ provision_id: PID_A }, bearer(PID_A))
    expect(redis.calls).toEqual([`del byok:${PID_A}`])
    expect(await redis.exists(`byok:${PID_B}`)).toBe(1)
    expect(await redis.exists(`signup:${PID_A}`)).toBe(1)
  })

  it('ignores any other field in the body: the id that is deleted is the one the token was made for', async () => {
    await call({ provision_id: PID_A, key: `byok:${PID_B}`, keys: [`byok:${PID_B}`] }, bearer(PID_A))
    expect(redis.calls).toEqual([`del byok:${PID_A}`])
    expect(await redis.exists(`byok:${PID_B}`)).toBe(1)
  })

  it.each([
    ['no header', () => undefined],
    ['a header without Bearer', () => 'Basic abc'],
    ['the shared secret alone', () => `Bearer ${SECRET}`],
    ['another site\'s token', () => bearer(PID_B)],
    ['a token made with another secret', () => bearer(PID_A, 'some-other-secret')],
    ['a token of the wrong length', () => 'Bearer abc123']
  ])('answers %s with 401 and deletes nothing', async (_label, header) => {
    const out = await call({ provision_id: PID_A }, header())
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
    expect(await redis.exists(`byok:${PID_A}`)).toBe(1)
    expect(await redis.exists(`byok:${PID_B}`)).toBe(1)
  })

  it('answers 401 and deletes nothing when the server has no callback secret', async () => {
    const out = await call({ provision_id: PID_A }, bearer(PID_A, ''), { provisionCallbackSecret: '' })
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
    expect(await redis.exists(`byok:${PID_A}`)).toBe(1)
  })

  it.each([
    ['no body', undefined],
    ['a null body', null],
    ['a text body', 'provision_id'],
    ['a body with no id', {}],
    ['an id of the wrong shape', { provision_id: 'short' }],
    ['an id that is a list', { provision_id: [PID_A] }]
  ])('answers %s with 401 and deletes nothing', async (_label, body) => {
    const out = await call(body, bearer(PID_A))
    expect(out.status).toBe(401)
    expect(redis.calls).toEqual([])
    expect(await redis.exists(`byok:${PID_A}`)).toBe(1)
  })

  it('sends Cache-Control no-store with the 200 and the 401 (D-21)', async () => {
    const ok = await call({ provision_id: PID_A }, bearer(PID_A))
    const denied = await call({ provision_id: PID_A }, undefined)
    expect(ok.headers['Cache-Control']).toBe('no-store')
    expect(denied.headers['Cache-Control']).toBe('no-store')
  })

  it('a key acked away stays gone from the manifest: the manifest never holds one', async () => {
    await call({ provision_id: PID_A }, bearer(PID_A))
    const out = await handleManifest({ provision_id: PID_A }, bearer(PID_A), { config: CONFIG, redis })
    expect(out.body).not.toHaveProperty('ai_key')
    expect(JSON.stringify(out.body)).not.toContain('sealed-test-blob')
  })
})

describe('provision-manifest: the host report address (HOST_REPORT_EMAIL)', () => {
  let redis: SpyRedis
  beforeEach(async () => {
    redis = new SpyRedis()
    await seedSignup(redis, PID_A)
  })
  const call = (hostReportEmail?: string) =>
    handleManifest({ provision_id: PID_A }, bearer(PID_A), { config: { ...CONFIG, ...(hostReportEmail === undefined ? {} : { hostReportEmail }) }, redis })

  it('sends host_report_email when the app has one, the same for every site', async () => {
    const out = await call('reports@example.test')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ host_report_email: 'reports@example.test', organizer_email: 'organizer@example.test' })
    expect(Object.keys(out.body).sort()).toEqual([...NINE_FIELDS, 'host_report_email'].sort())
  })

  it('leaves the field out when none is set or the setting is not one plain address, so the site keeps the nine fields', async () => {
    for (const bad of [undefined, '', '   ', 'no-at-sign', 'a@b.test c@d.test', 'a@b.test\nX-Header: y', 'a@b.test,c@d.test']) {
      const out = await call(bad)
      expect(out.status).toBe(200)
      expect(Object.keys(out.body).sort()).toEqual(NINE_FIELDS)
    }
  })

  it('the route passes runtimeConfig hostReportEmail (NUXT_HOST_REPORT_EMAIL)', () => {
    expect(readFileSync(new URL('../../server/api/provision-manifest.get.ts', import.meta.url), 'utf8')).toMatch(/hostReportEmail/)
    expect(readFileSync(new URL('../../nuxt.config.ts', import.meta.url), 'utf8')).toMatch(/hostReportEmail: ''/)
  })
})
