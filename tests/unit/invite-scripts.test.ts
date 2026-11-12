// Phase 23, plan 23-24 (D-05, D-06, D-07; threats T-23-71, T-23-72): the two
// operator scripts that fill the invite list. Everything runs offline: a fake
// Resend fetcher, a fake Stripe, the shared FakeRedis. Tom runs the scripts
// later against the real services; no test touches a network or reads a secret.
// The addresses below are made up. The one rule every test repeats: nothing a
// script prints may contain an email address.
import { describe, it, expect, vi } from 'vitest'
import { FakeRedis } from './helpers/fake-redis'
import { addInvite, COMMUNITY_TEMPLATES, emailKey, inviteKey } from '../../server/utils/invites'
import * as wave from '../../scripts/invites/import-wave.mjs'
import * as pilot from '../../scripts/invites/add-pilot.mjs'

const SECRET = 'test-invite-hash-secret'
const invites = { addInvite, emailKey, inviteKey }
const KINDS = ['Co-op', 'Online guild or DAO', 'Land trust']

interface Contact { id: string, email: string, unsubscribed?: boolean, properties?: Record<string, unknown> }

const contact = (n: number, kind: string | null, over: Partial<Contact> = {}): Contact => ({
  id: `c${n}`,
  email: `person${n}@example.invalid`,
  unsubscribed: false,
  properties: kind === null ? {} : { group_kind: kind },
  ...over
})

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const fail = (status: number, headers: Record<string, string> = {}) => ({
  ok: false,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  // A real error body from Resend can carry addresses: the scripts must never print it.
  json: async () => ({ message: 'rejected person1@example.invalid', name: 'error' })
})

/** A fake Resend: pages of 2 contacts, optional properties, a request log, no network. */
function fakeResend(contacts: Contact[], opts: { listProperties?: boolean, pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 2
  const listProperties = opts.listProperties ?? true
  const calls: string[] = []
  const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url)
    expect(init?.headers?.Authorization).toBe('Bearer re_test_key')
    const u = new URL(url)
    const one = u.pathname.match(/^\/contacts\/([^/]+)$/)
    if (one) return ok(contacts.find(c => c.id === one[1]))
    expect(u.pathname).toBe('/contacts')
    expect(u.searchParams.get('segment_id')).toBe('seg_test')
    const after = u.searchParams.get('after')
    const start = after ? contacts.findIndex(c => c.id === after) + 1 : 0
    const page = contacts.slice(start, start + pageSize)
    return ok({
      object: 'list',
      has_more: start + pageSize < contacts.length,
      data: page.map(c => listProperties ? c : { id: c.id, email: c.email, unsubscribed: c.unsubscribed })
    })
  })
  return { fetch, calls }
}

function waveDeps(over: Record<string, unknown> = {}) {
  const redis = new FakeRedis()
  const resend = fakeResend([
    contact(1, 'Co-op'),
    contact(2, 'Neighborhood group'),
    contact(3, 'Online guild or DAO'),
    contact(4, null),
    contact(5, 'Land trust')
  ])
  return {
    redis,
    resend,
    deps: { redis, fetch: resend.fetch, secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}, ...over }
  }
}

const hashOf = async (redis: FakeRedis, email: string) =>
  redis.hgetall<Record<string, unknown>>(inviteKey(emailKey(SECRET, email)))

function io() {
  const lines: string[] = []
  return { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s), text: () => lines.join('\n') }
}

describe('import-wave: arguments', () => {
  it('reads --wave, --kinds and --dry-run', () => {
    expect(wave.parseArgs(['--wave', '1', '--kinds', ' Co-op , Land trust ,', '--dry-run']))
      .toEqual({ wave: '1', kinds: ['Co-op', 'Land trust'], dryRun: true })
    expect(wave.parseArgs(['--wave=2', '--kinds=Co-op']).dryRun).toBe(false)
  })

  it.each([
    [[], 'no arguments'],
    [['--wave', '1'], 'no --kinds (never invite everyone by accident)'],
    [['--kinds', 'Co-op'], 'no --wave'],
    [['--wave', '', '--kinds', 'Co-op'], 'empty wave'],
    [['--wave', '1', '--kinds', ' , '], 'only empty kinds'],
    [['--wave', 'a b', '--kinds', 'Co-op'], 'a wave label with spaces'],
    [['--wave', '1', '--kinds', 'Co-op', '--bogus'], 'an unknown flag']
  ])('refuses %j (%s)', (argv) => {
    expect(() => wave.parseArgs(argv as string[])).toThrow()
  })
})

describe('import-wave: the import', () => {
  it('writes an invite for each contact of a chosen kind and counts the rest', async () => {
    const { redis, deps } = waveDeps()
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps)
    expect(counts).toMatchObject({ seen: 5, added: 3, skipped: 0, otherKind: 2, unsubscribed: 0, failed: 0 })
    expect(redis.keys().filter(k => k.startsWith('invite:e:'))).toHaveLength(3)
    for (const n of [1, 3, 5]) {
      const h = await hashOf(redis, `person${n}@example.invalid`)
      // Redis reads a stored "1" back as the number 1 (as Upstash does), so compare as text.
      expect(h).toMatchObject({ kind: 'wave', status: 'open' })
      expect(String(h?.wave)).toBe('1')
      expect(h?.inviteId).toBeTruthy()
    }
    for (const n of [2, 4]) expect(await hashOf(redis, `person${n}@example.invalid`)).toBeNull()
  })

  it('matches kinds ignoring case and surrounding spaces', async () => {
    const { deps } = waveDeps()
    const counts = await wave.importWave({ wave: '1', kinds: ['co-op', ' LAND TRUST '], dryRun: false }, deps)
    expect(counts.added).toBe(2)
  })

  it('follows every page of the segment', async () => {
    const { resend, deps } = waveDeps()
    await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps)
    const lists = resend.calls.filter(u => new URL(u).pathname === '/contacts')
    expect(lists).toHaveLength(3)
    expect(new URL(lists[0]!).searchParams.get('limit')).toBe('100')
    expect(new URL(lists[1]!).searchParams.get('after')).toBe('c2')
    expect(new URL(lists[2]!).searchParams.get('after')).toBe('c4')
  })

  it('skips an address that already has an invite and counts it as skipped', async () => {
    const { redis, deps } = waveDeps()
    const before = await addInvite(redis as never, SECRET, { email: 'person1@example.invalid', kind: 'pilot', wave: 'pilot' })
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps)
    expect(counts).toMatchObject({ added: 2, skipped: 1 })
    // The earlier invite is untouched: same id, still a pilot.
    expect(await hashOf(redis, 'person1@example.invalid')).toMatchObject({ inviteId: before.inviteId, kind: 'pilot' })
  })

  it('does not touch a used invite, and a second run adds nothing', async () => {
    const { redis, deps } = waveDeps()
    await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps)
    await redis.hset(inviteKey(emailKey(SECRET, 'person3@example.invalid')), { status: 'used' })
    const again = await wave.importWave({ wave: '2', kinds: KINDS, dryRun: false }, deps)
    expect(again).toMatchObject({ added: 0, skipped: 3 })
    const kept = await hashOf(redis, 'person3@example.invalid')
    expect(kept).toMatchObject({ status: 'used' })
    expect(String(kept?.wave)).toBe('1')
  })

  it('leaves out anyone who unsubscribed from the list', async () => {
    const redis = new FakeRedis()
    const resend = fakeResend([contact(1, 'Co-op', { unsubscribed: true }), contact(2, 'Co-op')])
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, { ...waveDeps().deps, redis, fetch: resend.fetch })
    expect(counts).toMatchObject({ added: 1, unsubscribed: 1 })
    expect(await hashOf(redis, 'person1@example.invalid')).toBeNull()
  })

  it('asks for each contact when the list response carries no properties', async () => {
    const redis = new FakeRedis()
    const resend = fakeResend([contact(1, 'Co-op'), contact(2, 'Neighborhood group'), contact(3, 'Land trust')], { listProperties: false })
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, { ...waveDeps().deps, redis, fetch: resend.fetch })
    expect(counts).toMatchObject({ seen: 3, added: 2, otherKind: 1 })
    expect(resend.calls.filter(u => /\/contacts\/c\d$/.test(u))).toHaveLength(3)
  })

  it('does not fetch a contact it can already place, or one that unsubscribed', async () => {
    const redis = new FakeRedis()
    const resend = fakeResend([contact(1, 'Co-op'), contact(2, null, { unsubscribed: true })])
    await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, { ...waveDeps().deps, redis, fetch: resend.fetch })
    expect(resend.calls.filter(u => /\/contacts\/c\d$/.test(u))).toHaveLength(0)
  })

  it('--dry-run writes nothing and reports what it would add', async () => {
    const { redis, deps } = waveDeps()
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: true }, deps)
    expect(counts).toMatchObject({ added: 0, wouldAdd: 3, otherKind: 2 })
    expect(redis.keys()).toEqual([])
  })

  it('waits between per-contact lookups and once on a 429', async () => {
    const sleep = vi.fn(async () => {})
    const redis = new FakeRedis()
    const resend = fakeResend([contact(1, 'Co-op')], { listProperties: false })
    let first = true
    const fetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (first && /\/contacts\/c1$/.test(url)) { first = false; return fail(429, { 'retry-after': '1' }) }
      return resend.fetch(url, init)
    })
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, { ...waveDeps().deps, redis, fetch, sleep, throttleMs: 250 })
    expect(counts.added).toBe(1)
    expect(sleep).toHaveBeenCalledWith(1000)
    expect(sleep).toHaveBeenCalledWith(250)
  })

  it('a Resend error stops the run with a status code and nothing else', async () => {
    const { deps } = waveDeps({ fetch: vi.fn(async () => fail(401)) })
    const err = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('401')
    expect(err.message).not.toMatch(/example\.invalid|re_test_key/)
  })

  it('counts a failed write without printing why, and carries on', async () => {
    const { redis, deps } = waveDeps()
    const real = redis.hset.bind(redis)
    let n = 0
    redis.hset = (async (k: string, f: Record<string, unknown>) => {
      if (++n === 1) throw new Error('boom person1@example.invalid')
      return real(k, f)
    }) as typeof redis.hset
    const counts = await wave.importWave({ wave: '1', kinds: KINDS, dryRun: false }, deps)
    expect(counts).toMatchObject({ added: 2, failed: 1 })
    // The reason is the error class only, never its message.
    expect(counts.reasons).toEqual(['Error'])
    expect(JSON.stringify(counts)).not.toContain('example.invalid')
  })
})

describe('import-wave: what it prints', () => {
  const env = {
    RESEND_API_KEY: 're_test_key',
    RESEND_SEGMENT_ID: 'seg_test',
    UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'upstash-test-token',
    INVITE_HASH_SECRET: SECRET
  }

  it('prints "3 invites added" and no address', async () => {
    const { redis, resend } = waveDeps()
    const out = io()
    const code = await wave.main(['--wave', '1', '--kinds', KINDS.join(',')], env, out, async () => ({
      redis, fetch: resend.fetch, secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}
    }))
    expect(code).toBe(0)
    expect(out.text()).toContain('3 invites added')
    expect(out.text()).not.toMatch(/example\.invalid|@/)
    expect(out.text()).not.toMatch(/re_test_key|upstash-test-token|test-invite-hash-secret/)
  })

  it('prints the skipped and other counts, still no address', async () => {
    const { redis, resend } = waveDeps()
    await addInvite(redis as never, SECRET, { email: 'person1@example.invalid', kind: 'wave', wave: '0' })
    const out = io()
    await wave.main(['--wave', '1', '--kinds', KINDS.join(',')], env, out, async () => ({
      redis, fetch: resend.fetch, secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}
    }))
    expect(out.text()).toContain('2 invites added')
    expect(out.text()).toMatch(/1 skipped/)
    expect(out.text()).toMatch(/2 .*other/)
    expect(out.text()).not.toMatch(/example\.invalid|@/)
  })

  it('--dry-run says nothing was written and prints no address', async () => {
    const { redis, resend } = waveDeps()
    const out = io()
    const code = await wave.main(['--wave', '1', '--kinds', KINDS.join(','), '--dry-run'], env, out, async () => ({
      redis, fetch: resend.fetch, secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}
    }))
    expect(code).toBe(0)
    expect(out.text()).toMatch(/dry run/i)
    expect(out.text()).toContain('3 invites would be added')
    expect(redis.keys()).toEqual([])
    expect(out.text()).not.toMatch(/example\.invalid|@/)
  })

  it('a Resend failure exits non-zero with a status and no address or key', async () => {
    const { redis } = waveDeps()
    const out = io()
    const code = await wave.main(['--wave', '1', '--kinds', 'Co-op'], env, out, async () => ({
      redis, fetch: vi.fn(async () => fail(500)), secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}
    }))
    expect(code).not.toBe(0)
    expect(out.text()).toContain('500')
    expect(out.text()).not.toMatch(/example\.invalid|re_test_key/)
  })

  it('a failed write is reported by error class, with no address', async () => {
    const { redis, resend } = waveDeps()
    redis.hset = (async () => { throw Object.assign(new Error('boom person1@example.invalid'), { name: 'UpstashError' }) }) as typeof redis.hset
    const out = io()
    const code = await wave.main(['--wave', '1', '--kinds', 'Co-op'], env, out, async () => ({
      redis, fetch: resend.fetch, secret: SECRET, apiKey: 're_test_key', segmentId: 'seg_test', invites, throttleMs: 0, sleep: async () => {}
    }))
    expect(code).not.toBe(0)
    expect(out.text()).toMatch(/1 failed.*UpstashError/)
    expect(out.text()).not.toMatch(/example\.invalid|boom|@/)
  })

  it('names every missing environment variable, and never builds a client', async () => {
    const out = io()
    const makeDeps = vi.fn()
    const code = await wave.main(['--wave', '1', '--kinds', 'Co-op'], { RESEND_API_KEY: 're_test_key' }, out, makeDeps)
    expect(code).not.toBe(0)
    expect(makeDeps).not.toHaveBeenCalled()
    for (const k of ['RESEND_SEGMENT_ID', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'INVITE_HASH_SECRET']) expect(out.text()).toContain(k)
    expect(out.text()).not.toContain('re_test_key')
  })

  it('a bad argument prints usage and exits non-zero without touching anything', async () => {
    const out = io()
    const makeDeps = vi.fn()
    expect(await wave.main(['--wave', '1'], env, out, makeDeps)).not.toBe(0)
    expect(makeDeps).not.toHaveBeenCalled()
    expect(out.text()).toMatch(/usage/i)
  })
})

// --- add-pilot ----------------------------------------------------------------

const PILOT = 'pilot.person@example.invalid'

function pilotDeps(over: Record<string, unknown> = {}) {
  const redis = new FakeRedis()
  const create = vi.fn(async (_params: Record<string, unknown>, _opts?: Record<string, unknown>) => ({ id: 'promo_test_123', code: 'PILOTCODE123', max_redemptions: 1 }))
  const stripe = { promotionCodes: { create } }
  return { redis, create, deps: { redis, secret: SECRET, stripe, invites, ...over } }
}

describe('add-pilot: arguments', () => {
  it('reads --email, --coupon, --test, --wave and --dry-run', () => {
    expect(pilot.parseArgs(['--email', PILOT, '--coupon', 'coupon_100', '--test', '--dry-run']))
      .toEqual({ email: PILOT, coupon: 'coupon_100', test: true, wave: 'pilot', dryRun: true, template: '' })
    expect(pilot.parseArgs(['--email', PILOT, '--wave', 'pilot-2']))
      .toEqual({ email: PILOT, coupon: undefined, test: false, wave: 'pilot-2', dryRun: false, template: '' })
  })

  it('refuses a missing or malformed email, and the error never repeats it', () => {
    expect(() => pilot.parseArgs([])).toThrow()
    let message = ''
    try { pilot.parseArgs(['--email', 'not-an-address@@']) } catch (e) { message = (e as Error).message }
    expect(message).not.toBe('')
    expect(message).not.toContain('not-an-address')
  })

  it('refuses an unknown flag and an empty --coupon', () => {
    expect(() => pilot.parseArgs(['--email', PILOT, '--bogus'])).toThrow()
    expect(() => pilot.parseArgs(['--email', PILOT, '--coupon', ''])).toThrow()
  })

  it('reads --template with a community kind on the list', () => {
    expect(pilot.parseArgs(['--email', PILOT, '--template', 'housing_coop']))
      .toEqual({ email: PILOT, coupon: undefined, test: false, wave: 'pilot', dryRun: false, template: 'housing_coop' })
  })

  it.each(['housing.coop', 'Housing_coop', 'village', ''])('refuses --template %j, naming the allowed kinds and never repeating the value', (bad) => {
    let message = ''
    try { pilot.parseArgs(['--email', PILOT, '--template', bad]) } catch (e) { message = (e as Error).message }
    expect(message).not.toBe('')
    for (const id of COMMUNITY_TEMPLATES) expect(message).toContain(id)
    if (bad) expect(message).not.toContain(bad)
  })

  it('keeps its copy of the community kinds equal to the app list, in the same order', () => {
    expect(pilot.COMMUNITY_TEMPLATES).toEqual(COMMUNITY_TEMPLATES)
  })
})

describe('add-pilot: the invite', () => {
  it('adds one open pilot invite and no promotion code without --coupon', async () => {
    const { redis, create, deps } = pilotDeps()
    const result = await pilot.addPilot({ email: PILOT, test: false, wave: 'pilot', dryRun: false }, deps)
    expect(create).not.toHaveBeenCalled()
    const h = await hashOf(redis, PILOT)
    expect(h).toMatchObject({ kind: 'pilot', wave: 'pilot', status: 'open', inviteId: result.inviteId })
    expect(h?.promoCode).toBeUndefined()
    expect(h?.test).toBeUndefined()
  })

  it('--coupon creates a single-use promotion code bound to the invite and stores it on the invite', async () => {
    const { redis, create, deps } = pilotDeps()
    const result = await pilot.addPilot({ email: PILOT, coupon: 'coupon_100', test: false, wave: 'pilot', dryRun: false }, deps)
    expect(create).toHaveBeenCalledTimes(1)
    const [params, opts] = create.mock.calls[0]!
    expect(params).toMatchObject({
      promotion: { type: 'coupon', coupon: 'coupon_100' },
      max_redemptions: 1,
      metadata: { invite_id: result.inviteId }
    })
    expect(opts).toMatchObject({ idempotencyKey: expect.stringContaining(result.inviteId) })
    expect(await hashOf(redis, PILOT)).toMatchObject({ promoCodeId: 'promo_test_123', promoCode: 'PILOTCODE123', inviteId: result.inviteId, status: 'open' })
    expect(result).toMatchObject({ promoCode: 'PILOTCODE123', promoCodeId: 'promo_test_123' })
  })

  it('--test marks the invite as a test pilot', async () => {
    const { redis, deps } = pilotDeps()
    await pilot.addPilot({ email: PILOT, coupon: 'coupon_100', test: true, wave: 'pilot', dryRun: false }, deps)
    expect(await hashOf(redis, PILOT)).toMatchObject({ test: true, kind: 'pilot', promoCode: 'PILOTCODE123' })
  })

  it('--test works without a coupon too', async () => {
    const { redis, deps } = pilotDeps()
    await pilot.addPilot({ email: PILOT, test: true, wave: 'pilot', dryRun: false }, deps)
    expect(await hashOf(redis, PILOT)).toMatchObject({ test: true, kind: 'pilot' })
  })

  it('keeps no plain address in Redis', async () => {
    const { redis, deps } = pilotDeps()
    await pilot.addPilot({ email: PILOT, coupon: 'coupon_100', test: true, wave: 'pilot', dryRun: false }, deps)
    expect(redis.dump()).not.toContain('example.invalid')
  })

  it('replaces an open invite for the same address (new invite id, so an old link stops working)', async () => {
    const { redis, deps } = pilotDeps()
    const first = await addInvite(redis as never, SECRET, { email: PILOT, kind: 'wave', wave: '1' })
    const result = await pilot.addPilot({ email: PILOT, test: false, wave: 'pilot', dryRun: false }, deps)
    expect(result.inviteId).not.toBe(first.inviteId)
    expect(await hashOf(redis, PILOT)).toMatchObject({ kind: 'pilot', inviteId: result.inviteId, status: 'open' })
  })

  it('refuses an address whose invite was already used, and creates no code', async () => {
    const { redis, create, deps } = pilotDeps()
    await addInvite(redis as never, SECRET, { email: PILOT, kind: 'pilot', wave: 'pilot' })
    await redis.hset(inviteKey(emailKey(SECRET, PILOT)), { status: 'used' })
    const err = await pilot.addPilot({ email: PILOT, coupon: 'coupon_100', test: false, wave: 'pilot', dryRun: false }, deps).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain('example.invalid')
    expect(create).not.toHaveBeenCalled()
    expect(await hashOf(redis, PILOT)).toMatchObject({ status: 'used' })
  })

  it('--template stores the community kind on the invite', async () => {
    const { redis, deps } = pilotDeps()
    await pilot.addPilot({ email: PILOT, test: false, wave: 'pilot', dryRun: false, template: 'housing_coop' }, deps)
    expect(await hashOf(redis, PILOT)).toMatchObject({ communityTemplate: 'housing_coop', kind: 'pilot', status: 'open' })
  })

  it('a second run for the same open address without --template clears the old kind', async () => {
    const { redis, deps } = pilotDeps()
    await pilot.addPilot({ email: PILOT, test: false, wave: 'pilot', dryRun: false, template: 'housing_coop' }, deps)
    await pilot.addPilot({ email: PILOT, test: false, wave: 'pilot', dryRun: false, template: '' }, deps)
    expect((await hashOf(redis, PILOT))?.communityTemplate).toBe('')
  })

  it('--dry-run writes nothing and creates no code', async () => {
    const { redis, create, deps } = pilotDeps()
    const result = await pilot.addPilot({ email: PILOT, coupon: 'coupon_100', test: true, wave: 'pilot', dryRun: true }, deps)
    expect(redis.keys()).toEqual([])
    expect(create).not.toHaveBeenCalled()
    expect(result.dryRun).toBe(true)
  })

  it('a Stripe failure after the invite exists is reported, with no promotion code stored', async () => {
    const { redis, deps } = pilotDeps()
    deps.stripe.promotionCodes.create = vi.fn(async () => { throw Object.assign(new Error(`No such coupon for ${PILOT}`), { statusCode: 404 }) })
    const err = await pilot.addPilot({ email: PILOT, coupon: 'coupon_missing', test: false, wave: 'pilot', dryRun: false }, deps).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain('example.invalid')
    const h = await hashOf(redis, PILOT)
    expect(h?.promoCode).toBeUndefined()
  })
})

describe('add-pilot: what it prints', () => {
  const env = { INVITE_HASH_SECRET: SECRET, UPSTASH_REDIS_REST_URL: 'https://redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'upstash-test-token' }
  const withStripe = { ...env, STRIPE_SECRET_KEY: 'sk_test_fake_key' }

  const run = async (argv: string[], e: Record<string, string>, over: Record<string, unknown> = {}) => {
    const { redis, create, deps } = pilotDeps(over)
    const out = io()
    const makeDeps = vi.fn(async () => deps)
    const code = await pilot.main(argv, e, out, makeDeps)
    return { code, out, redis, create, makeDeps }
  }

  it('prints the created code and counts, never the address or a key', async () => {
    const { code, out } = await run(['--email', PILOT, '--coupon', 'coupon_100', '--test'], withStripe)
    expect(code).toBe(0)
    expect(out.text()).toContain('PILOTCODE123')
    expect(out.text()).toMatch(/1 pilot invite added/)
    expect(out.text()).toMatch(/test/i)
    expect(out.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
    expect(out.text()).not.toMatch(/sk_test_fake_key|upstash-test-token|test-invite-hash-secret/)
  })

  it('prints no address without a coupon either', async () => {
    const { code, out } = await run(['--email', PILOT], env)
    expect(code).toBe(0)
    expect(out.text()).toMatch(/1 pilot invite added/)
    expect(out.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
  })

  it('--dry-run prints what it would do, no code and no address', async () => {
    const { code, out, redis } = await run(['--email', PILOT, '--coupon', 'coupon_100', '--dry-run'], withStripe)
    expect(code).toBe(0)
    expect(out.text()).toMatch(/dry run/i)
    expect(out.text()).not.toContain('PILOTCODE123')
    expect(out.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
    expect(redis.keys()).toEqual([])
  })

  it('a real run with --template prints the community kind, never the address', async () => {
    const { code, out } = await run(['--email', PILOT, '--template', 'housing_coop'], env)
    expect(code).toBe(0)
    expect(out.text().split('\n')).toContain('Community template: housing_coop.')
    expect(out.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
  })

  it('a dry run with --template says what a real run would store, never the address', async () => {
    const { code, out, redis } = await run(['--email', PILOT, '--template', 'housing_coop', '--dry-run'], env)
    expect(code).toBe(0)
    expect(out.text().split('\n')).toContain('A real run would store the community template housing_coop.')
    expect(out.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
    expect(redis.keys()).toEqual([])
  })

  it('a refusal and a Stripe error print no address', async () => {
    const used = pilotDeps()
    await addInvite(used.redis as never, SECRET, { email: PILOT, kind: 'pilot', wave: 'pilot' })
    await used.redis.hset(inviteKey(emailKey(SECRET, PILOT)), { status: 'used' })
    const out1 = io()
    expect(await pilot.main(['--email', PILOT], env, out1, async () => used.deps)).not.toBe(0)
    expect(out1.text()).not.toMatch(/example\.invalid|pilot\.person|@/)

    const broken = pilotDeps()
    broken.deps.stripe.promotionCodes.create = vi.fn(async () => { throw Object.assign(new Error(`bad ${PILOT}`), { statusCode: 404 }) })
    const out2 = io()
    expect(await pilot.main(['--email', PILOT, '--coupon', 'x'], withStripe, out2, async () => broken.deps)).not.toBe(0)
    expect(out2.text()).toContain('404')
    expect(out2.text()).not.toMatch(/example\.invalid|pilot\.person|@/)
  })

  it('--coupon needs STRIPE_SECRET_KEY, and every missing variable is named', async () => {
    const { code, out, makeDeps } = await run(['--email', PILOT, '--coupon', 'coupon_100'], env)
    expect(code).not.toBe(0)
    expect(makeDeps).not.toHaveBeenCalled()
    expect(out.text()).toContain('STRIPE_SECRET_KEY')
    const none = await run(['--email', PILOT], {})
    expect(none.code).not.toBe(0)
    for (const k of ['INVITE_HASH_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) expect(none.out.text()).toContain(k)
    expect(none.out.text()).not.toMatch(/example\.invalid|pilot\.person/)
  })

  it('--dry-run with --coupon needs no Stripe key', async () => {
    const { code } = await run(['--email', PILOT, '--coupon', 'coupon_100', '--dry-run'], env)
    expect(code).toBe(0)
  })

  it('a bad email prints usage without the address', async () => {
    const { code, out, makeDeps } = await run(['--email', 'broken@@x'], env)
    expect(code).not.toBe(0)
    expect(makeDeps).not.toHaveBeenCalled()
    expect(out.text()).not.toContain('broken@@x')
  })
})
