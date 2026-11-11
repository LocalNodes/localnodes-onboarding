// Bring your own AI key at sign-up (Phase 23, plan 23-18; ONB-07, D-21,
// T-23-56, T-23-57, T-23-58). Redis is a fake, Stripe and every provider call
// are mocks: nothing here touches a network, and the keys are test strings.
//
// The organizer pastes their own Gemini or OpenRouter key. The app checks it
// once, seals it (AES-256-GCM), keeps it for the invited session, moves it to
// byok:{provisionId} at checkout, hands it only to the workflow's bearer token
// through the manifest, and deletes it on ack, on complete and on the final
// stop. The canary keys below must never show up in a reply, a log, an error,
// the Stripe params or Redis in plain text.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import Stripe from 'stripe'
import { FakeRedis } from './helpers/fake-redis'
import { roomyCapacity } from './helpers/capacity'
import {
  sealKey,
  openKey,
  checkProviderKey,
  storePendingKey,
  attachKeyToProvision,
  deleteProvisionKey,
  releaseSessionKey,
  handleAiKey,
  pendingKeyName,
  provisionKeyName,
  PENDING_TTL_SECONDS,
  PROVISION_KEY_TTL_SECONDS,
  AI_KEY_RATE_LIMIT,
  type AiKeyDeps,
  type ProviderFetch
} from '../../server/utils/byo-key'
import {
  AI_CHOICE_COPY,
  aiChoiceNotes,
  KEY_FAILED_MESSAGE,
  KEY_NOT_CHECKED_MESSAGE,
  GEMINI_BILLING_MESSAGE,
  TOO_MANY_KEY_CHECKS_MESSAGE,
  SERVER_ERROR_MESSAGE,
  isOpenRouterChoiceEnabled
} from '../../shared/ai-choice'
import { handleCreateCheckout, type CheckoutDeps } from '../../server/utils/checkout'
import { handleManifest, handleManifestAck } from '../../server/utils/provision-manifest'
import { callbackToken, handleProvisionCallback } from '../../server/utils/provision-handlers'
import { stopProvision } from '../../server/utils/retry-stop'
import { handleStripeWebhook, type WebhookDeps } from '../../server/utils/stripe-webhook'
import { addInvite, emailKey, sha256, type InviteRecord } from '../../server/utils/invites'
import { voiceHits } from '../../server/utils/voice-check'
import { checkoutMarkerKey, forgetCheckout, markCheckout } from '../../server/utils/checkout-marker'

// --- canaries and fixed test values -------------------------------------------

/** An OpenRouter-shaped test key. Its tail is unique, so a "last few characters" leak is caught too. */
const CANARY = 'sk-or-v1-CANARYc4n4ryC4N4RYc4n4ry0123456789abcdefQZtail77'
/** A Gemini-shaped test key, same idea. */
const GEMINI_CANARY = 'AIzaSyCANARYgeminiKEY0123456789abcdQZgem88'
const CANARIES = [CANARY, GEMINI_CANARY, CANARY.slice(-8), GEMINI_CANARY.slice(-8)]

const SEAL_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'
const CALLBACK_SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const INVITE_SECRET = 'test-invite-hash-secret'
const INVITED = 'organizer@example.test'
const SID = 'S'.repeat(43)
const SESSION_HASH = sha256(SID)
const PID = 'AAAAAAAAAAAAAAAAAAAAAA'
const STATE_SID = 'cs_test_byo_1'
const BODY = { communityName: 'Repair Collective', subdomain: 'repair' }

const FIXED_MESSAGES = new Set([
  KEY_FAILED_MESSAGE,
  KEY_NOT_CHECKED_MESSAGE,
  GEMINI_BILLING_MESSAGE,
  TOO_MANY_KEY_CHECKS_MESSAGE,
  SERVER_ERROR_MESSAGE,
  'Not Found'
])

// --- everything that leaves the code, for the canary check in afterAll ---------

const seen: string[] = []
const record = (label: string, value: unknown) => {
  seen.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}
const logs: string[] = []
const log = (msg: string) => {
  logs.push(msg)
  record('log', msg)
}
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
    record(`console.${method}`, args.map(a => (a instanceof Error ? `${a.message} ${a.stack}` : a)))
  })
}

afterAll(() => {
  const everything = [...seen, ...logs].join('\n')
  for (const c of CANARIES) expect(everything).not.toContain(c)
  vi.restoreAllMocks()
})

/** A provider check mock: answers 200 for the keys in `good`, 401 for anything else. Records the URLs only. */
function providerFetch(good: string[] = [CANARY, GEMINI_CANARY]) {
  const calls: Array<{ url: string, init: Parameters<ProviderFetch>[1] }> = []
  const fn = vi.fn<ProviderFetch>(async (url, init) => {
    calls.push({ url, init })
    const auth = init.headers.Authorization ?? init.headers['x-goog-api-key'] ?? ''
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : auth
    return { status: good.includes(key) ? 200 : 401 }
  })
  return { fn, calls }
}

async function invitedSession(redis: FakeRedis): Promise<InviteRecord> {
  const { inviteId } = await addInvite(redis, INVITE_SECRET, { email: INVITED, kind: 'wave', wave: 'w1' })
  return { inviteId, emailHmac: emailKey(INVITE_SECRET, INVITED), email: INVITED }
}

async function aiKeySetup(over: Partial<AiKeyDeps> = {}) {
  const redis = new FakeRedis()
  const session = await invitedSession(redis)
  const provider = providerFetch()
  const deps: AiKeyDeps = {
    session,
    sessionHash: SESSION_HASH,
    secret: SEAL_SECRET,
    redis,
    fetch: provider.fn,
    log,
    // The OpenRouter choice is hidden by default; these tests run with it on (23-18 follow-up).
    openRouterChoiceEnabled: true,
    ...over
  }
  const call = async (raw: unknown, d: AiKeyDeps = deps) => {
    const out = await handleAiKey(raw, d)
    record('ai-key reply', out)
    return out
  }
  return { redis, session, provider, deps, call }
}

// --- seal and open -------------------------------------------------------------

describe('byo-key: sealKey and openKey (T-23-56, T-23-58)', () => {
  it('sealKey then openKey returns the same key, and the sealed text holds no part of it', () => {
    const sealed = sealKey(SEAL_SECRET, CANARY)
    expect(openKey(SEAL_SECRET, sealed)).toBe(CANARY)
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/)
    for (const c of CANARIES) expect(sealed).not.toContain(c)
  })

  it('two seals of the same key differ (a fresh 12-byte IV each time)', () => {
    expect(sealKey(SEAL_SECRET, CANARY)).not.toBe(sealKey(SEAL_SECRET, CANARY))
  })

  it('a flipped byte in the ciphertext makes openKey throw, and the error holds no key', () => {
    const sealed = Buffer.from(sealKey(SEAL_SECRET, CANARY), 'base64url')
    const last = sealed.length - 1
    sealed[last] = sealed[last]! ^ 0x01
    let message = ''
    expect(() => {
      try {
        openKey(SEAL_SECRET, sealed.toString('base64url'))
      } catch (err) {
        message = String((err as Error).message)
        throw err
      }
    }).toThrow()
    for (const c of CANARIES) expect(message).not.toContain(c)
  })

  it('a flipped byte in the tag or the IV makes openKey throw', () => {
    for (const index of [0, 13]) {
      const sealed = Buffer.from(sealKey(SEAL_SECRET, CANARY), 'base64url')
      sealed[index] = sealed[index]! ^ 0x80
      expect(() => openKey(SEAL_SECRET, sealed.toString('base64url'))).toThrow()
    }
  })

  it('the wrong secret cannot open it', () => {
    expect(() => openKey(OTHER_SECRET, sealKey(SEAL_SECRET, CANARY))).toThrow()
  })

  it('a missing or malformed secret is refused, and the error holds no key', () => {
    for (const bad of ['', 'abc', 'zz'.repeat(32)]) {
      let message = ''
      try {
        sealKey(bad, CANARY)
      } catch (err) {
        message = String((err as Error).message)
      }
      expect(message).not.toBe('')
      for (const c of CANARIES) expect(message).not.toContain(c)
    }
  })
})

// --- the provider check -----------------------------------------------------------

describe('byo-key: checkProviderKey (one cheap call, 5-second limit)', () => {
  it('OpenRouter: GET https://openrouter.ai/api/v1/key with a bearer; true on 200', async () => {
    const { fn, calls } = providerFetch()
    expect(await checkProviderKey('openrouter', CANARY, fn)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/key')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers.Authorization).toBe(`Bearer ${CANARY}`)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('Gemini: GET the v1beta models list with the key in the x-goog-api-key header, never in the URL', async () => {
    const { fn, calls } = providerFetch()
    expect(await checkProviderKey('gemini', GEMINI_CANARY, fn)).toBe(true)
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(calls[0]!.url).not.toContain(GEMINI_CANARY)
    expect(calls[0]!.init.headers['x-goog-api-key']).toBe(GEMINI_CANARY)
  })

  it('anything but 200 is false: 401, 403, 429, 500 and a redirect', async () => {
    for (const status of [401, 403, 429, 500, 302]) {
      const fn = vi.fn<ProviderFetch>(async () => ({ status }))
      expect(await checkProviderKey('openrouter', CANARY, fn)).toBe(false)
    }
  })

  it('a fetch that throws is false, never an error that could carry the key', async () => {
    const fn = vi.fn<ProviderFetch>(async () => {
      throw new Error(`network down for ${CANARY}`)
    })
    await expect(checkProviderKey('openrouter', CANARY, fn)).resolves.toBe(false)
  })

  it('a provider that does not answer in time is false (the limit aborts the call)', async () => {
    const fn = vi.fn<ProviderFetch>((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    await expect(checkProviderKey('openrouter', CANARY, fn, 20)).resolves.toBe(false)
  })
})

// --- POST /api/ai-key ----------------------------------------------------------------

describe('POST /api/ai-key (handleAiKey)', () => {
  it('an OpenRouter key the check accepts is sealed at byok:pending:{sha256(sid)} for 7200 seconds; the reply is only {ok: true}', async () => {
    const { redis, call } = await aiKeySetup()
    const out = await call({ kind: 'openrouter', key: CANARY })
    expect(out).toEqual({ status: 200, body: { ok: true } })
    const slot = await redis.hgetall<Record<string, unknown>>(pendingKeyName(SESSION_HASH))
    expect(slot?.kind).toBe('openrouter')
    expect(openKey(SEAL_SECRET, String(slot?.sealed))).toBe(CANARY)
    expect(await redis.ttl(pendingKeyName(SESSION_HASH))).toBe(PENDING_TTL_SECONDS)
    expect(PENDING_TTL_SECONDS).toBe(7200)
    expect(pendingKeyName(SESSION_HASH)).toBe(`byok:pending:${SESSION_HASH}`)
    for (const c of CANARIES) expect(redis.dump()).not.toContain(c)
  })

  it('a key pasted with spaces around it is trimmed before the check', async () => {
    const { provider, call } = await aiKeySetup()
    const out = await call({ kind: 'openrouter', key: `  ${CANARY}\n` })
    expect(out.status).toBe(200)
    expect(provider.calls[0]!.init.headers.Authorization).toBe(`Bearer ${CANARY}`)
  })

  it('an own Gemini key needs billingConfirmed true (G8): without it, the UI-SPEC message, no check, nothing stored', async () => {
    for (const billingConfirmed of [undefined, false]) {
      const { redis, provider, call } = await aiKeySetup()
      const out = await call({ kind: 'gemini', key: GEMINI_CANARY, billingConfirmed })
      expect(out).toEqual({ status: 400, body: { ok: false, message: GEMINI_BILLING_MESSAGE } })
      expect(provider.fn).not.toHaveBeenCalled()
      expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
    }
  })

  it('an own Gemini key with billingConfirmed true is checked against Gemini and kept', async () => {
    const { redis, provider, call } = await aiKeySetup()
    const out = await call({ kind: 'gemini', key: GEMINI_CANARY, billingConfirmed: true })
    expect(out).toEqual({ status: 200, body: { ok: true } })
    expect(provider.calls[0]!.url).toContain('generativelanguage.googleapis.com')
    const slot = await redis.hgetall<Record<string, unknown>>(pendingKeyName(SESSION_HASH))
    expect(slot?.kind).toBe('gemini')
  })

  it('an empty key is refused with the plain message, no check is made and nothing is stored', async () => {
    for (const key of ['', '     ', 'short']) {
      const { redis, provider, call } = await aiKeySetup()
      const out = await call({ kind: 'openrouter', key })
      expect(out).toEqual({ status: 400, body: { ok: false, message: KEY_FAILED_MESSAGE } })
      expect(provider.fn).not.toHaveBeenCalled()
      expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
    }
  })

  it('a key that fails the provider check is refused with the plain message and nothing is stored', async () => {
    const { redis, call } = await aiKeySetup({ fetch: providerFetch([]).fn })
    const out = await call({ kind: 'openrouter', key: CANARY })
    expect(out).toEqual({ status: 400, body: { ok: false, message: KEY_FAILED_MESSAGE } })
    expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
  })

  it('a malformed body carrying a key (unknown kind, a key with a line break, too long) never echoes it', async () => {
    const { redis, provider, call } = await aiKeySetup()
    for (const body of [
      { kind: 'bogus', key: CANARY },
      { kind: 'openrouter', key: `${CANARY}\nX-Other: 1` },
      { kind: 'openrouter', key: CANARY.repeat(8) },
      { kind: 'openrouter', key: 42 },
      null
    ]) {
      const out = await call(body)
      expect(out.status).toBe(400)
      expect(out.body).toEqual({ ok: false, message: KEY_FAILED_MESSAGE })
      for (const c of CANARIES) expect(JSON.stringify(out)).not.toContain(c)
    }
    expect(provider.fn).not.toHaveBeenCalled()
    expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
  })

  it('without an invited session it answers 404, makes no check and stores nothing', async () => {
    for (const over of [{ session: null }, { sessionHash: null }]) {
      const { redis, provider, call } = await aiKeySetup(over)
      const out = await call({ kind: 'openrouter', key: CANARY })
      expect(out).toEqual({ status: 404, body: { ok: false, message: 'Not Found' } })
      expect(provider.fn).not.toHaveBeenCalled()
      expect(redis.keys().filter(k => k.startsWith('byok:') || k.startsWith('rl:'))).toEqual([])
    }
  })

  it('is rate limited per invite: 10 checks an hour at rl:aikey:inv:{inviteId}, the 11th makes no provider call', async () => {
    const { redis, session, provider, call } = await aiKeySetup({ fetch: providerFetch([]).fn })
    expect(AI_KEY_RATE_LIMIT).toEqual({ max: 10, windowSeconds: 3600 })
    for (let i = 0; i < 10; i++) {
      expect((await call({ kind: 'openrouter', key: CANARY })).body).toEqual({ ok: false, message: KEY_FAILED_MESSAGE })
    }
    const before = (provider.fn as ReturnType<typeof vi.fn>).mock.calls.length
    const out = await call({ kind: 'openrouter', key: CANARY })
    expect(out).toEqual({ status: 429, body: { ok: false, message: TOO_MANY_KEY_CHECKS_MESSAGE } })
    expect(await redis.ttl(`rl:aikey:inv:${session.inviteId}`)).toBe(3600)
    expect((provider.fn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before)
  })

  it('a limiter that cannot answer means no provider call (fails closed)', async () => {
    const { redis, provider, call } = await aiKeySetup()
    redis.incr = async () => {
      throw new Error('redis down')
    }
    const out = await call({ kind: 'openrouter', key: CANARY })
    expect(out).toEqual({ status: 503, body: { ok: false, message: SERVER_ERROR_MESSAGE } })
    expect(provider.fn).not.toHaveBeenCalled()
  })

  it('a missing seal secret refuses before the provider call, and stores nothing', async () => {
    const { redis, provider, call } = await aiKeySetup({ secret: '' })
    const out = await call({ kind: 'openrouter', key: CANARY })
    expect(out).toEqual({ status: 503, body: { ok: false, message: SERVER_ERROR_MESSAGE } })
    expect(provider.fn).not.toHaveBeenCalled()
    expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
  })

  it('a new check replaces the kept key, and a new key that fails leaves no key at all', async () => {
    const { redis, deps, call } = await aiKeySetup()
    await call({ kind: 'openrouter', key: CANARY })
    await call({ kind: 'gemini', key: GEMINI_CANARY, billingConfirmed: true })
    const slot = await redis.hgetall<Record<string, unknown>>(pendingKeyName(SESSION_HASH))
    expect(openKey(SEAL_SECRET, String(slot?.sealed))).toBe(GEMINI_CANARY)
    const failing = await call({ kind: 'openrouter', key: `${CANARY}x` }, { ...deps, fetch: providerFetch([]).fn })
    expect(failing.status).toBe(400)
    expect(await redis.exists(pendingKeyName(SESSION_HASH))).toBe(0)
  })

  it('logs carry no key and no part of one, on success and on every refusal', async () => {
    const { call, deps } = await aiKeySetup()
    logs.length = 0
    await call({ kind: 'openrouter', key: CANARY })
    await call({ kind: 'openrouter', key: CANARY }, { ...deps, fetch: providerFetch([]).fn })
    await call({ kind: 'openrouter', key: CANARY }, { ...deps, fetch: vi.fn<ProviderFetch>(async () => { throw new Error(CANARY) }) })
    for (const c of CANARIES) expect(logs.join('\n')).not.toContain(c)
  })
})

// --- pending key helpers --------------------------------------------------------------

describe('byo-key: storePendingKey, attachKeyToProvision, deleteProvisionKey', () => {
  it('attach moves the pending slot to byok:{provisionId} (RENAME then EXPIRE 86400)', async () => {
    const redis = new FakeRedis()
    await storePendingKey(redis, SESSION_HASH, 'openrouter', sealKey(SEAL_SECRET, CANARY))
    expect(await attachKeyToProvision(redis, SESSION_HASH, PID)).toBe(true)
    expect(await redis.exists(pendingKeyName(SESSION_HASH))).toBe(0)
    expect(provisionKeyName(PID)).toBe(`byok:${PID}`)
    expect(await redis.ttl(provisionKeyName(PID))).toBe(PROVISION_KEY_TTL_SECONDS)
    expect(PROVISION_KEY_TTL_SECONDS).toBe(86400)
  })

  it('attach with no pending slot is false and writes nothing', async () => {
    const redis = new FakeRedis()
    expect(await attachKeyToProvision(redis, SESSION_HASH, PID)).toBe(false)
    expect(redis.keys()).toEqual([])
  })

  it('deleteProvisionKey removes byok:{provisionId} only', async () => {
    const redis = new FakeRedis()
    await redis.hset(provisionKeyName(PID), { kind: 'openrouter', sealed: 'x' })
    await redis.hset(provisionKeyName('BBBBBBBBBBBBBBBBBBBBBB'), { kind: 'openrouter', sealed: 'y' })
    await deleteProvisionKey(redis, PID)
    expect(redis.keys()).toEqual([provisionKeyName('BBBBBBBBBBBBBBBBBBBBBB')])
  })
})

// --- create-checkout with the AI choice ---------------------------------------------------

async function checkoutSetup(over: Partial<CheckoutDeps> = {}) {
  const redis = new FakeRedis()
  const session = await invitedSession(redis)
  const create = vi.fn(async (_params: unknown) => ({ url: 'https://checkout.stripe.com/c/pay_1' as string | null }))
  const deps: CheckoutDeps = {
    open: false,
    session,
    sessionHash: SESSION_HASH,
    stripe: { checkout: { sessions: { create } } },
    redis,
    priceId: 'price_test_123', paidSignupsEnabled: true,
    openRouterChoiceEnabled: true,
    currency: 'usd',
    origin: 'https://localnodes.xyz',
    newProvisionId: () => PID,
    log,
    capacity: roomyCapacity(),
    ...over
  }
  const call = async (raw: unknown, d: CheckoutDeps = deps) => {
    const out = await handleCreateCheckout(raw, d)
    record('checkout reply', out)
    for (const c of create.mock.calls) record('stripe params', c[0])
    return out
  }
  const params = () => create.mock.calls[0]![0] as Record<string, unknown>
  return { redis, session, create, deps, call, params }
}

const pendKey = async (redis: FakeRedis, kind: 'gemini' | 'openrouter', key: string) =>
  storePendingKey(redis, SESSION_HASH, kind, sealKey(SEAL_SECRET, key))

describe('create-checkout: aiChoice default, gemini or openrouter (T-3: the Stripe params do not change)', () => {
  it('aiChoice openrouter moves the pending key to byok:{provisionId} for 86400 seconds and records openrouter / organizer', async () => {
    const { redis, call } = await checkoutSetup()
    await pendKey(redis, 'openrouter', CANARY)
    const out = await call({ ...BODY, aiChoice: 'openrouter' })
    expect(out.status).toBe(200)
    expect(await redis.exists(pendingKeyName(SESSION_HASH))).toBe(0)
    expect(await redis.ttl(provisionKeyName(PID))).toBe(86400)
    const slot = await redis.hgetall<Record<string, unknown>>(provisionKeyName(PID))
    expect(openKey(SEAL_SECRET, String(slot?.sealed))).toBe(CANARY)
    const rec = await redis.hgetall<Record<string, unknown>>(`signup:${PID}`)
    expect(rec).toMatchObject({ aiProvider: 'openrouter', aiKeySource: 'organizer' })
    for (const c of CANARIES) expect(JSON.stringify(rec)).not.toContain(c)
  })

  it('aiChoice gemini with a pending Gemini key records gemini / organizer', async () => {
    const { redis, call } = await checkoutSetup()
    await pendKey(redis, 'gemini', GEMINI_CANARY)
    expect((await call({ ...BODY, aiChoice: 'gemini' })).status).toBe(200)
    expect(await redis.hgetall(`signup:${PID}`)).toMatchObject({ aiProvider: 'gemini', aiKeySource: 'organizer' })
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })

  it('the Stripe session params are the same with an own key as with the default, and hold no key', async () => {
    const a = await checkoutSetup()
    await a.call({ ...BODY })
    const b = await checkoutSetup()
    await pendKey(b.redis, 'openrouter', CANARY)
    await b.call({ ...BODY, aiChoice: 'openrouter' })
    // Each setup has its own invite id; everything else must match exactly.
    const same = (x: ReturnType<typeof checkoutSetup> extends Promise<infer T> ? T : never) =>
      JSON.parse(JSON.stringify(x.params()).split(x.session.inviteId).join('INVITE'))
    expect(same(b)).toEqual(same(a))
    for (const c of CANARIES) expect(JSON.stringify(b.params())).not.toContain(c)
    expect(JSON.stringify(b.params())).not.toMatch(/ai_?key|byok|openrouter/i)
  })

  it('an own-key choice with no checked key for this session is refused with the UI-SPEC message: no hold, no record, no Stripe call', async () => {
    const { redis, create, call } = await checkoutSetup()
    const before = redis.keys()
    const out = await call({ ...BODY, aiChoice: 'openrouter' })
    expect(out).toEqual({ status: 400, body: { message: KEY_NOT_CHECKED_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
    expect(redis.keys()).toEqual(before)
  })

  it('a pending key of the other kind does not count: openrouter chosen, a Gemini key checked', async () => {
    const { redis, create, call } = await checkoutSetup()
    await pendKey(redis, 'gemini', GEMINI_CANARY)
    const out = await call({ ...BODY, aiChoice: 'openrouter' })
    expect(out).toEqual({ status: 400, body: { message: KEY_NOT_CHECKED_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
    expect(await redis.exists(`signup:${PID}`)).toBe(0)
  })

  it('an own-key choice with no session hash is refused the same way', async () => {
    const { redis, create, call } = await checkoutSetup({ sessionHash: undefined })
    await pendKey(redis, 'openrouter', CANARY)
    const out = await call({ ...BODY, aiChoice: 'openrouter' })
    expect(out).toEqual({ status: 400, body: { message: KEY_NOT_CHECKED_MESSAGE } })
    expect(create).not.toHaveBeenCalled()
  })

  it('the default choice (given or left out) stores no key, records gemini / platform, and forgets a key checked earlier', async () => {
    for (const body of [{ ...BODY }, { ...BODY, aiChoice: 'default' }]) {
      const { redis, call } = await checkoutSetup()
      await pendKey(redis, 'openrouter', CANARY)
      expect((await call(body)).status).toBe(200)
      expect(redis.keys().filter(k => k.startsWith('byok:'))).toEqual([])
      expect(await redis.hgetall(`signup:${PID}`)).toMatchObject({ aiProvider: 'gemini', aiKeySource: 'platform' })
    }
  })

  it('an unknown aiChoice is a 400 with the general message', async () => {
    const { create, call } = await checkoutSetup()
    const out = await call({ ...BODY, aiChoice: 'anthropic' })
    expect(out).toEqual({ status: 400, body: { message: 'Please check the sign-up details and try again.' } })
    expect(create).not.toHaveBeenCalled()
  })

  it('when Stripe fails the key goes back to the session, so a second try needs no new check', async () => {
    const { redis, create, call } = await checkoutSetup()
    await pendKey(redis, 'openrouter', CANARY)
    create.mockRejectedValueOnce(new Error('stripe down'))
    await expect(call({ ...BODY, aiChoice: 'openrouter' })).rejects.toThrow('stripe down')
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
    expect(await redis.exists(pendingKeyName(SESSION_HASH))).toBe(1)
    create.mockResolvedValueOnce({ url: null })
    expect((await call({ ...BODY, aiChoice: 'openrouter' })).status).toBe(500)
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
    expect(await redis.exists(pendingKeyName(SESSION_HASH))).toBe(1)
    expect((await call({ ...BODY, aiChoice: 'openrouter' })).status).toBe(200)
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })
})

// --- the OpenRouter choice flag (23-18 follow-up, 2026-11-08) -------------------------------
// No OpenRouter model passed the re-score under Tom's rule, so the choice is
// hidden until one does: runtimeConfig openRouterChoiceEnabled
// (NUXT_OPENROUTER_CHOICE_ENABLED), on only for true or 'true'. While off, the
// key route and checkout refuse openrouter through their existing bad-request
// replies (no new copy), before any Redis write, rate-limit count, hold,
// record or Stripe call. The OpenRouter code stays.

/** The four settings the flag is tested at: off, unset, "1" and on. */
const FLAG_CASES: Array<[string, unknown, boolean]> = [
  ['off (false)', false, false],
  ['unset', undefined, false],
  ['"1"', '1', false],
  ['on (true)', true, true]
]

describe('the OpenRouter choice flag (23-18 follow-up)', () => {
  it('is on only for true or the string "true"', () => {
    expect(isOpenRouterChoiceEnabled(true)).toBe(true)
    expect(isOpenRouterChoiceEnabled('true')).toBe(true)
    for (const v of [false, undefined, null, '', '1', 1, 'yes', 'on', 'false', 'TRUE ']) {
      expect(isOpenRouterChoiceEnabled(v), String(v)).toBe(false)
    }
  })

  it.each(FLAG_CASES)('POST /api/ai-key with the flag %s (%s): kind openrouter accepted: %s', async (_name, value, on) => {
    const { redis, provider, deps, call } = await aiKeySetup({ openRouterChoiceEnabled: isOpenRouterChoiceEnabled(value) })
    await storePendingKey(redis, SESSION_HASH, 'gemini', sealKey(SEAL_SECRET, GEMINI_CANARY))
    const before = redis.keys().sort()
    const out = await call({ kind: 'openrouter', key: CANARY }, deps)
    if (on) {
      expect(out).toEqual({ status: 200, body: { ok: true } })
      expect(await pendingKeyKindOf(redis)).toBe('openrouter')
      return
    }
    // The malformed-body reply, word for word: no provider call, no rate-limit
    // count, and the key kept earlier is left as it was.
    expect(out).toEqual({ status: 400, body: { ok: false, message: KEY_FAILED_MESSAGE } })
    expect(provider.fn).not.toHaveBeenCalled()
    expect(redis.keys().sort()).toEqual(before)
    expect(await pendingKeyKindOf(redis)).toBe('gemini')
  })

  it.each(FLAG_CASES)('POST /api/ai-key with the flag %s (%s) still checks a Gemini key', async (_name, value) => {
    const { call, deps } = await aiKeySetup({ openRouterChoiceEnabled: isOpenRouterChoiceEnabled(value) })
    expect(await call({ kind: 'gemini', key: GEMINI_CANARY, billingConfirmed: true }, deps)).toEqual({ status: 200, body: { ok: true } })
  })

  it.each(FLAG_CASES)('create-checkout with the flag %s (%s): aiChoice openrouter accepted: %s', async (_name, value, on) => {
    const { redis, create, call, deps } = await checkoutSetup({ openRouterChoiceEnabled: isOpenRouterChoiceEnabled(value) })
    await pendKey(redis, 'openrouter', CANARY)
    const before = redis.keys().sort()
    const out = await call({ ...BODY, aiChoice: 'openrouter' }, deps)
    if (on) {
      expect(out.status).toBe(200)
      expect(await redis.hgetall(`signup:${PID}`)).toMatchObject({ aiProvider: 'openrouter', aiKeySource: 'organizer' })
      return
    }
    // The existing bad-request reply, word for word: no hold, no record, no
    // Stripe session, and the checked key stays with the session.
    expect(out).toEqual({ status: 400, body: { message: 'Please check the sign-up details and try again.' } })
    expect(create).not.toHaveBeenCalled()
    expect(redis.keys().sort()).toEqual(before)
    expect(await redis.exists(`signup:${PID}`)).toBe(0)
    expect(await pendingKeyKindOf(redis)).toBe('openrouter')
  })

  it.each(FLAG_CASES)('create-checkout with the flag %s (%s) still takes the default and an own Gemini key', async (_name, value) => {
    const a = await checkoutSetup({ openRouterChoiceEnabled: isOpenRouterChoiceEnabled(value) })
    expect((await a.call({ ...BODY })).status).toBe(200)
    const b = await checkoutSetup({ openRouterChoiceEnabled: isOpenRouterChoiceEnabled(value) })
    await pendKey(b.redis, 'gemini', GEMINI_CANARY)
    expect((await b.call({ ...BODY, aiChoice: 'gemini' })).status).toBe(200)
  })

  it('both deps carry the flag as a required boolean, and both routes read it through isOpenRouterChoiceEnabled', () => {
    const root = new URL('../../', import.meta.url)
    const src = (p: string) => readFileSync(new URL(p, root), 'utf8')
    expect(src('server/utils/byo-key.ts')).toMatch(/^\s+openRouterChoiceEnabled: boolean$/m)
    expect(src('server/utils/checkout.ts')).toMatch(/^\s+openRouterChoiceEnabled: boolean$/m)
    for (const route of ['server/api/ai-key.post.ts', 'server/api/create-checkout.post.ts']) {
      expect(src(route), route).toMatch(/openRouterChoiceEnabled: isOpenRouterChoiceEnabled\(config\.openRouterChoiceEnabled\)/)
    }
  })
})

/** The kind of the key kept for the test session, or null. */
async function pendingKeyKindOf(redis: FakeRedis): Promise<string | null> {
  const slot = await redis.hgetall<Record<string, unknown>>(pendingKeyName(SESSION_HASH))
  return slot && typeof slot.kind === 'string' ? slot.kind : null
}

// --- the manifest ---------------------------------------------------------------------

const bearer = (pid: string) => `Bearer ${callbackToken(CALLBACK_SECRET, pid)}`
const MANIFEST_CONFIG = { provisionCallbackSecret: CALLBACK_SECRET, byoKeySecret: SEAL_SECRET }

async function seedOrganizerSignup(redis: FakeRedis, extra: Record<string, unknown> = {}) {
  await redis.hset(`signup:${PID}`, {
    subdomain: 'repair',
    communityName: 'Repair Collective',
    email: INVITED,
    inviteId: 'inv_internal_1',
    topicTypes: [],
    aiProvider: 'openrouter',
    aiKeySource: 'organizer',
    ...extra
  })
}

async function manifest(redis: FakeRedis, header = bearer(PID), config = MANIFEST_CONFIG) {
  const out = await handleManifest({ provision_id: PID }, header, { config, redis })
  record('manifest reply (status)', out.status)
  // The 200 body holds the key on purpose (to the bearer only); every other reply must not.
  if (out.status !== 200) record('manifest refusal', out.body)
  return out
}

describe('manifest: ai_key only for the workflow bearer, deleted on ack (D-21, T-3)', () => {
  let redis: FakeRedis
  beforeEach(async () => {
    redis = new FakeRedis()
    await seedOrganizerSignup(redis)
    await storePendingKey(redis, SESSION_HASH, 'openrouter', sealKey(SEAL_SECRET, CANARY))
    await attachKeyToProvision(redis, SESSION_HASH, PID)
  })

  it('with the right token the manifest includes ai_key equal to the original, never cached', async () => {
    const out = await manifest(redis)
    expect(out.status).toBe(200)
    expect(out.headers['Cache-Control']).toBe('no-store')
    expect(out.body.ai_key).toBe(CANARY)
    expect(out.body).toMatchObject({ ai_provider: 'openrouter', ai_key_source: 'organizer' })
  })

  it('two manifest reads before ack return the same key', async () => {
    const one = await manifest(redis)
    const two = await manifest(redis)
    expect(one.body.ai_key).toBe(CANARY)
    expect(two.body.ai_key).toBe(CANARY)
  })

  it('after ack the slot is gone; a retry\'s manifest is 200 with ai_key_source organizer and no ai_key', async () => {
    const ack = await handleManifestAck({ provision_id: PID }, bearer(PID), { config: MANIFEST_CONFIG, redis })
    expect(ack.status).toBe(200)
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
    const retry = await manifest(redis)
    record('manifest after ack', retry.body)
    expect(retry.status).toBe(200)
    expect(retry.body.ai_key_source).toBe('organizer')
    expect('ai_key' in retry.body).toBe(false)
  })

  it('a wrong token gets 401 with no key, and the slot stays', async () => {
    const out = await manifest(redis, bearer('BBBBBBBBBBBBBBBBBBBBBB'))
    expect(out.status).toBe(401)
    expect('ai_key' in out.body).toBe(false)
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })

  it('a platform record never gets ai_key, even if a slot exists', async () => {
    await seedOrganizerSignup(redis, { aiProvider: 'gemini', aiKeySource: 'platform' })
    const out = await manifest(redis)
    expect(out.status).toBe(200)
    expect('ai_key' in out.body).toBe(false)
  })

  it('a tampered slot gets a 500 with a fixed body and no detail (T-23-58)', async () => {
    const slot = await redis.hgetall<Record<string, unknown>>(provisionKeyName(PID))
    const bytes = Buffer.from(String(slot?.sealed), 'base64url')
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01
    await redis.hset(provisionKeyName(PID), { sealed: bytes.toString('base64url') })
    const out = await manifest(redis)
    expect(out.status).toBe(500)
    expect(out.body).toEqual({ message: 'Manifest unavailable' })
  })

  it('a slot sealed for the other provider gets the same 500', async () => {
    await redis.hset(provisionKeyName(PID), { kind: 'gemini' })
    const out = await manifest(redis)
    expect(out.status).toBe(500)
    expect(out.body).toEqual({ message: 'Manifest unavailable' })
  })

  it('no seal secret configured: the same 500, never a guess', async () => {
    const out = await manifest(redis, bearer(PID), { provisionCallbackSecret: CALLBACK_SECRET, byoKeySecret: '' })
    expect(out.status).toBe(500)
    expect(out.body).toEqual({ message: 'Manifest unavailable' })
  })
})

// --- deletion on complete and on the final stop -------------------------------------------

async function seedProvision(redis: FakeRedis, state: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, STATE_SID)
  await redis.hset(`provision:${STATE_SID}`, {
    status: 'provisioning',
    provisionId: PID,
    subdomain: 'repair',
    attempt: 1,
    ...state
  })
  await seedOrganizerSignup(redis)
  await redis.hset(provisionKeyName(PID), { kind: 'openrouter', sealed: sealKey(SEAL_SECRET, CANARY) })
}

describe('the key is forgotten on complete and on the final stop', () => {
  it('a ready callback deletes byok:{provisionId} (23-32 moved it from complete)', async () => {
    const redis = new FakeRedis()
    await seedProvision(redis)
    const out = await handleProvisionCallback(
      bearer(PID),
      { provision_id: PID, attempt: 1, status: 'ready', site_url: 'https://repair.localnodes.xyz' },
      { provisionCallbackSecret: CALLBACK_SECRET },
      redis,
      { log }
    )
    expect(out).toEqual({ updated: true })
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
  })

  it('a progress callback (installing) leaves the key for the build to copy', async () => {
    const redis = new FakeRedis()
    await seedProvision(redis)
    await handleProvisionCallback(
      bearer(PID),
      { provision_id: PID, attempt: 1, status: 'installing' },
      { provisionCallbackSecret: CALLBACK_SECRET },
      redis,
      { log }
    )
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })

  it('stopProvision deletes byok:{provisionId} as its own step (stopAiKey) before stopped is set', async () => {
    const redis = new FakeRedis()
    await seedProvision(redis, { status: 'failed', failedAttempts: 2 })
    const mailFetch = vi.fn(async () => ({}))
    const out = await stopProvision(STATE_SID, { redis, teardown: async () => {}, mail: { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', fetch: mailFetch }, log })
    expect(out).toEqual({ stopped: true })
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
    expect(await redis.hgetall(`provision:${STATE_SID}`)).toMatchObject({
      stopHold: true, stopLock: true, stopCard: true, stopMail: true, stopCapacity: true, stopAiKey: true, stopped: true
    })
  })

  it('a stop cut short before the key step deletes the key on the next trigger', async () => {
    const redis = new FakeRedis()
    await seedProvision(redis, { status: 'failed', failedAttempts: 2 })
    const failing = vi.fn(async () => {
      throw new Error('resend down')
    })
    await expect(stopProvision(STATE_SID, { redis, teardown: async () => {}, mail: { apiKey: 're_test', from: 'x', fetch: failing }, log })).rejects.toThrow()
    const ok = vi.fn(async () => ({}))
    expect(await stopProvision(STATE_SID, { redis, teardown: async () => {}, mail: { apiKey: 're_test', from: 'x', fetch: ok }, log })).toEqual({ stopped: true })
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
  })
})

// --- an expired checkout forgets the key (Rule 2: the sign-up stopped) -----------------------

describe('the Stripe webhook: an expired checkout forgets its key', () => {
  const WH_SECRET = 'whsec_test_secret'
  const stripeLib = new Stripe('sk_test_not_used')

  function signed(type: string, metadata: Record<string, string> = { provision_id: PID }) {
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type, data: { object: { id: STATE_SID, object: 'checkout.session', metadata } } })
    return { payload, sig: stripeLib.webhooks.generateTestHeaderString({ payload, secret: WH_SECRET }) }
  }

  const deps = (redis: FakeRedis, open: boolean): WebhookDeps => ({
    open,
    constructEvent: (body, sig) => stripeLib.webhooks.constructEvent(body, sig, WH_SECRET),
    onCheckoutCompleted: vi.fn(async () => {}),
    releaseAiKey: session => releaseSessionKey(redis, session),
    releaseCheckoutMarker: session => forgetCheckout(redis, session),
    log
  })

  // 23-20 follow-up: an expired session's id shows the empty state on /success.
  it.each([['closed', false], ['open', true]])('checkout.session.expired deletes checkout:{sessionId} while %s', async (_l, open) => {
    const redis = new FakeRedis()
    await markCheckout(redis, STATE_SID)
    const { payload, sig } = signed('checkout.session.expired')
    expect((await handleStripeWebhook(payload, sig, deps(redis, open))).status).toBe(200)
    expect(await redis.exists(checkoutMarkerKey(STATE_SID))).toBe(0)
  })

  it('the webhook route wires the marker release to forgetCheckout', () => {
    expect(readFileSync(new URL('../../server/api/stripe-webhook.post.ts', import.meta.url), 'utf8'))
      .toMatch(/releaseCheckoutMarker: session => forgetCheckout\(useRedis\(\), session\)/)
  })

  it.each([['closed', false], ['open', true]])('checkout.session.expired deletes byok:{provisionId} while %s', async (_l, open) => {
    const redis = new FakeRedis()
    await redis.hset(provisionKeyName(PID), { kind: 'openrouter', sealed: sealKey(SEAL_SECRET, CANARY) })
    const { payload, sig } = signed('checkout.session.expired')
    expect((await handleStripeWebhook(payload, sig, deps(redis, open))).status).toBe(200)
    expect(await redis.exists(provisionKeyName(PID))).toBe(0)
  })

  it('an expired session with no or a malformed provision id deletes nothing', async () => {
    const redis = new FakeRedis()
    await redis.hset(provisionKeyName(PID), { kind: 'openrouter', sealed: 'x' })
    for (const metadata of [{}, { provision_id: 'pending:anything' }]) {
      const { payload, sig } = signed('checkout.session.expired', metadata)
      expect((await handleStripeWebhook(payload, sig, deps(redis, true))).status).toBe(200)
    }
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })

  it('a deletion that fails is logged with a fixed line and the event is still answered 200', async () => {
    const redis = new FakeRedis()
    redis.del = async () => {
      throw new Error('upstash down')
    }
    logs.length = 0
    const { payload, sig } = signed('checkout.session.expired')
    expect((await handleStripeWebhook(payload, sig, deps(redis, false))).status).toBe(200)
    expect(logs.join('\n')).toContain('could not forget an AI key')
  })

  it('a completed checkout keeps the key for the build', async () => {
    const redis = new FakeRedis()
    await redis.hset(provisionKeyName(PID), { kind: 'openrouter', sealed: 'x' })
    const { payload, sig } = signed('checkout.session.completed')
    await handleStripeWebhook(payload, sig, deps(redis, true))
    expect(await redis.exists(provisionKeyName(PID))).toBe(1)
  })
})

// --- the AI choice copy (UI-SPEC, D-21, orchestrator ruling 2026-11-08) -----------------------

const RECALL_LINE = 'Works with your own OpenRouter key; answers may find fewer members-only notes than the default for now.'
const ZDR_LINE = 'Turn on Zero Data Retention in your OpenRouter privacy settings, so the companies that run the AI don\'t keep your community\'s text.'

describe('AI choice copy, word for word from the UI-SPEC', () => {
  it('the OpenRouter recall line is the UI-SPEC row, word for word', () => {
    expect(AI_CHOICE_COPY.openRouterRecallLine).toBe(RECALL_LINE)
    expect(AI_CHOICE_COPY.openRouterZdrLine).toBe(ZDR_LINE)
  })

  it('with Option 3 (own OpenRouter key) the lines shown are the ZDR line and the recall line', () => {
    expect(aiChoiceNotes('openrouter')).toEqual([ZDR_LINE, RECALL_LINE])
  })

  it('Option 1 and Option 2 never show the recall line', () => {
    expect(aiChoiceNotes('default')).toEqual([])
    expect(aiChoiceNotes('gemini')).not.toContain(RECALL_LINE)
    expect(aiChoiceNotes('gemini')).not.toContain(ZDR_LINE)
  })

  it('the options, legend and messages are the UI-SPEC rows', () => {
    expect(AI_CHOICE_COPY.legend).toBe('Which AI should your site use?')
    expect(AI_CHOICE_COPY.options.map(o => [o.value, o.label, o.description])).toEqual([
      ['default', 'The LocalNodes default', 'No setup. We cover the cost, with a limit per site.'],
      ['gemini', 'Your own Gemini key', 'Use a key from your own Google Cloud project.'],
      ['openrouter', 'Your own OpenRouter key', 'Use a key from your own OpenRouter account.']
    ])
    expect(KEY_FAILED_MESSAGE).toBe('That key didn\'t work. Check you copied all of it, then try again.')
    expect(TOO_MANY_KEY_CHECKS_MESSAGE).toBe('Too many checks. Wait a few minutes, then try again.')
    expect(KEY_NOT_CHECKED_MESSAGE).toBe('Check your key before continuing.')
    expect(GEMINI_BILLING_MESSAGE).toBe('Confirm the key\'s project has billing turned on.')
    expect(SERVER_ERROR_MESSAGE).toBe('Something went wrong on our side. Try again in a minute.')
  })

  it('every AI choice string passes the copy check: the voice and banned-claims rows, frame words and buyer words', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/banned-claims.json', import.meta.url), 'utf8')) as {
      frameWords: string[]
      buyerWords: string[]
      signupSources: string[]
    }
    const strings = [
      AI_CHOICE_COPY.legend,
      AI_CHOICE_COPY.help,
      ...AI_CHOICE_COPY.options.flatMap(o => [o.label, o.description]),
      AI_CHOICE_COPY.keyLabel.gemini,
      AI_CHOICE_COPY.keyLabel.openrouter,
      AI_CHOICE_COPY.keyHelp,
      AI_CHOICE_COPY.geminiCheckbox,
      ...aiChoiceNotes('openrouter'),
      KEY_FAILED_MESSAGE,
      TOO_MANY_KEY_CHECKS_MESSAGE,
      KEY_NOT_CHECKED_MESSAGE,
      GEMINI_BILLING_MESSAGE
    ]
    for (const s of strings) {
      expect(voiceHits(s), s).toEqual([])
      for (const w of fixture.buyerWords) expect(new RegExp(w, 'i').test(s), `${w} in ${s}`).toBe(false)
      for (const w of fixture.frameWords) expect(s.toLowerCase()).not.toContain(w.toLowerCase())
    }
    // npm run check:claims scans this file with the sign-up rules too.
    expect(fixture.signupSources).toContain('shared/ai-choice.ts')
  })

  it('every refusal from the key route and checkout is one of the fixed messages', () => {
    const replies = seen.filter(s => s.startsWith('ai-key reply') || s.startsWith('checkout reply'))
    expect(replies.length).toBeGreaterThan(0)
    for (const line of replies) {
      const body = JSON.parse(line.slice(line.indexOf(': ') + 2)).body as { message?: string }
      if (body.message) expect(FIXED_MESSAGES.has(body.message) || body.message === 'Please check the sign-up details and try again.' || body.message === 'Failed to create checkout session', body.message).toBe(true)
    }
  })
})
