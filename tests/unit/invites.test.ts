// Invited sign-up (Phase 23, plan 23-02, D-01 to D-05): the invite list, the
// one-time sign-in link, the invited session, and the gate that trusts only a
// server-side session. Redis is a fake, mail is a mock: no network, no secrets.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FakeRedis } from './helpers/fake-redis'
import {
  emailKey, sha256, newToken, addInvite, issueToken, consumeToken,
  createInvitedSession, getInvitedSession, handleInviteRequest, handleInviteVerify,
  sendInviteMail, INVITE_COOKIE, INVITE_RATE_LIMIT, UNIFORM_MESSAGE, type InviteMail, type RequestDeps
} from '../../server/utils/invites'
import { buildInviteMail } from '../../server/utils/mail-copy'

const SECRET = 'test-invite-hash-secret'
const EMAIL = 'organizer@example.com'
const REFUSAL = 'This link has expired or was already used. Ask for a new one.'

function setup(over: Partial<RequestDeps> = {}) {
  const redis = new FakeRedis()
  const sent: InviteMail[] = []
  const background: Promise<void>[] = []
  const deps: RequestDeps = {
    redis,
    secret: SECRET,
    sendMail: vi.fn(async (m: InviteMail) => { sent.push(m) }),
    keepAlive: (w: Promise<void>) => { background.push(w) },
    // The real floor is a second; tests that don't time the reply skip it.
    floorMs: 0,
    ...over
  }
  const settle = () => Promise.all(background)
  return { redis, sent, deps, settle }
}

const tokenOf = (link: string) => link.split('#t=')[1]!

describe('invite keys and tokens', () => {
  it('keys an address by HMAC of the trimmed, lower-cased email', () => {
    const k = emailKey(SECRET, '  Organizer@Example.com ')
    expect(k).toBe(emailKey(SECRET, EMAIL))
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(k).not.toContain('organizer')
    expect(emailKey('another-secret', EMAIL)).not.toBe(k)
    // Not a plain SHA-256, which could be reversed from a list of addresses.
    expect(k).not.toBe(createHash('sha256').update(EMAIL).digest('hex'))
  })

  it('makes 32-byte base64url tokens (43 characters) that differ every time', () => {
    const a = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newToken()).not.toBe(a)
    expect(sha256('x')).toBe(createHash('sha256').update('x').digest('hex'))
  })

  it('refuses to key an address when the secret is missing', () => {
    expect(() => emailKey('', EMAIL)).toThrow()
  })
})

describe('invite list', () => {
  it('stores an invite under the HMAC key, with no plain address anywhere in Redis', async () => {
    const { redis } = setup()
    const { inviteId } = await addInvite(redis, SECRET, { email: EMAIL, kind: 'pilot', wave: '1', promoCode: 'PILOT-ONE' })
    expect(redis.keys()).toEqual([`invite:e:${emailKey(SECRET, EMAIL)}`])
    const rec = await redis.hgetall<Record<string, unknown>>(`invite:e:${emailKey(SECRET, EMAIL)}`)
    expect(rec).toMatchObject({ inviteId, kind: 'pilot', status: 'open', promoCode: 'PILOT-ONE' })
    expect(redis.dump()).not.toContain('organizer')
  })
})

describe('tracer: invite, request, token, verify, session', () => {
  it('mails one sign-in link with a 43-character token in the fragment, and keeps only the token hash', async () => {
    const { redis, sent, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })

    const res = await handleInviteRequest({ email: EMAIL }, '203.0.113.7', deps)
    await settle()

    expect(res.status).toBe(200)
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    expect(sent[0]!.to).toBe(EMAIL)
    expect(sent[0]!.link).toMatch(/^https:\/\/localnodes\.xyz\/invite\/verify#t=[A-Za-z0-9_-]{43}$/)
    const token = tokenOf(sent[0]!.link)
    expect(redis.keys()).toContain(`invite:t:${sha256(token)}`)
    // Only the hash is stored: the raw token is nowhere in Redis.
    expect(redis.dump()).not.toContain(token)
    expect(await redis.ttl(`invite:t:${sha256(token)}`)).toBe(900)
  })

  it('verify turns the token into a session once; a second try gets the refusal', async () => {
    const { redis, sent, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1', promoCode: 'PILOT-ONE' })
    await handleInviteRequest({ email: EMAIL }, '203.0.113.7', deps)
    await settle()
    const token = tokenOf(sent[0]!.link)

    const ok = await handleInviteVerify({ token }, { redis, secret: SECRET })
    expect(ok.status).toBe(200)
    expect(ok.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const session = await getInvitedSession(redis, ok.sessionId!)
    expect(session).toMatchObject({ email: EMAIL, promoCode: 'PILOT-ONE' })
    expect(await redis.ttl(`invite:s:${sha256(ok.sessionId!)}`)).toBe(7200)
    expect(redis.dump()).not.toContain(ok.sessionId!)

    const again = await handleInviteVerify({ token }, { redis, secret: SECRET })
    expect(again.status).toBe(400)
    expect(again.sessionId).toBeUndefined()
    expect(again.body).toEqual({ ok: false, message: REFUSAL })
  })

  it('consumeToken reads and deletes in one step', async () => {
    const { redis } = setup()
    const token = await issueToken(redis, { inviteId: 'i1', emailHmac: 'h1', email: EMAIL })
    expect(await consumeToken(redis, token)).toMatchObject({ inviteId: 'i1', emailHmac: 'h1' })
    expect(await consumeToken(redis, token)).toBeNull()
  })

  it('getInvitedSession finds nothing for a missing, malformed or expired id', async () => {
    const { redis } = setup()
    const sid = await createInvitedSession(redis, { inviteId: 'i1', emailHmac: 'h1', email: EMAIL })
    expect(await getInvitedSession(redis, sid)).toMatchObject({ inviteId: 'i1' })
    expect(await getInvitedSession(redis, 'nope')).toBeNull()
    expect(await getInvitedSession(redis, undefined)).toBeNull()
    redis.advance(7201)
    expect(await getInvitedSession(redis, sid)).toBeNull()
  })

  it('sends nothing for an address that is not on the list', async () => {
    const { redis, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: 'someone-else@example.com', kind: 'wave', wave: '1' })
    const res = await handleInviteRequest({ email: EMAIL }, '203.0.113.7', deps)
    await settle()
    expect(res.status).toBe(200)
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(redis.keys().some(k => k.startsWith('invite:t:'))).toBe(false)
  })
})

// The real gate middleware and the real verify route, in an h3 app, in front of
// a stand-in checkout that would create a Stripe session.
describe('tracer: the closed gate lets an invited session through', () => {
  const g = globalThis as Record<string, unknown>
  let redis: FakeRedis
  let reached = 0

  async function app() {
    redis = new FakeRedis()
    g.useRuntimeConfig = () => ({ launchOpen: false, inviteHashSecret: SECRET })
    g.useRedis = () => redis
    const { default: gate } = await import('../../server/middleware/launch-gate')
    const { default: verify } = await import('../../server/api/invite/verify.post')
    const { defineEventHandler } = await import('h3')
    const a = createApp()
    a.use(gate)
    const r = createRouter()
    r.post('/api/create-checkout', defineEventHandler(() => { reached++; return { url: 'https://checkout.stripe.com/x' } }))
    r.get('/onboarding', defineEventHandler(() => { reached++; return 'onboarding page' }))
    r.post('/api/invite/verify', verify)
    return toWebHandler(a.use(r))
  }

  afterEach(() => {
    delete g.useRuntimeConfig
    delete g.useRedis
    reached = 0
  })

  const checkout = (cookie?: string) => new Request('http://localhost/api/create-checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: '{}'
  })

  it('404s checkout with no cookie, a made-up cookie, or an expired session', async () => {
    const h = await app()
    expect((await h(checkout())).status).toBe(404)
    expect((await h(checkout(`${INVITE_COOKIE}=${newToken()}`))).status).toBe(404)
    const sid = await createInvitedSession(redis, { inviteId: 'i1', emailHmac: 'h1', email: EMAIL })
    redis.advance(7201)
    expect((await h(checkout(`${INVITE_COOKIE}=${sid}`))).status).toBe(404)
    expect(reached).toBe(0)
  })

  it('passes checkout and the onboarding page for a live session cookie', async () => {
    const h = await app()
    const sid = await createInvitedSession(redis, { inviteId: 'i1', emailHmac: 'h1', email: EMAIL })
    expect((await h(checkout(`${INVITE_COOKIE}=${sid}`))).status).toBe(200)
    const page = await h(new Request('http://localhost/onboarding', { headers: { cookie: `${INVITE_COOKIE}=${sid}` } }))
    expect(page.status).toBe(200)
    expect(reached).toBe(2)
  })

  it('an uninvited page request still redirects to the early-access form', async () => {
    const h = await app()
    const res = await h(new Request('http://localhost/onboarding'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/#early-access')
  })

  it('never asks Redis about a request with no invite cookie', async () => {
    const h = await app()
    const spy = vi.spyOn(redis, 'get')
    await h(checkout())
    expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed (404) when Redis is down', async () => {
    const h = await app()
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('down'))
    expect((await h(checkout(`${INVITE_COOKIE}=${newToken()}`))).status).toBe(404)
  })

  it('verify sets the session cookie HttpOnly, Secure, SameSite=Lax, Path=/, 2 hours, and the cookie then opens the gate', async () => {
    const h = await app()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    const { inviteId, ...rest } = (await redis.hgetall<Record<string, string>>(`invite:e:${emailKey(SECRET, EMAIL)}`))!
    expect(rest.status).toBe('open')
    const token = await issueToken(redis, { inviteId, emailHmac: emailKey(SECRET, EMAIL), email: EMAIL })

    const res = await h(new Request('http://localhost/api/invite/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token })
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toMatch(new RegExp(`^${INVITE_COOKIE}=[A-Za-z0-9_-]{43};`))
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=7200']) expect(cookie).toContain(part)
    // The session id is only in the cookie, never in the body.
    const body = await res.text()
    expect(body).not.toContain(cookie.split(';')[0]!.split('=')[1]!)

    const sid = cookie.split(';')[0]!.split('=')[1]!
    expect((await h(checkout(`${INVITE_COOKIE}=${sid}`))).status).toBe(200)
  })

  it('verify answers a forged token with the refusal and no cookie', async () => {
    const h = await app()
    const res = await h(new Request('http://localhost/api/invite/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: newToken() })
    }))
    expect(res.status).toBe(400)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(await res.json()).toEqual({ ok: false, message: REFUSAL })
  })
})


// --- Task 2: request hardening, refusal cases, mail ---------------------------

describe('the request reply reveals nothing about the list', () => {
  const FLOOR = 80

  it('gives an invited, an unknown and a used address the same status and body', async () => {
    const { redis, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    await addInvite(redis, SECRET, { email: 'used@example.com', kind: 'wave', wave: '1' })
    await redis.hset(`invite:e:${emailKey(SECRET, 'used@example.com')}`, { status: 'used' })

    const invited = await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    const unknown = await handleInviteRequest({ email: 'nobody@example.com' }, '198.51.100.2', deps)
    const used = await handleInviteRequest({ email: 'used@example.com' }, '198.51.100.3', deps)
    await settle()

    expect(invited).toEqual({ status: 200, body: { ok: true, message: UNIFORM_MESSAGE } })
    expect(unknown).toEqual(invited)
    expect(used).toEqual(invited)
    // Mail went only to the open invite.
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    expect(UNIFORM_MESSAGE).toBe('If this address is invited, we\'ve sent a sign-in link. It works once, for 15 minutes.')
  })

  it('holds every valid reply until the floor: invited, unknown, used, honeypot, rate limited', async () => {
    const { redis, deps } = setup({ floorMs: FLOOR })
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    await addInvite(redis, SECRET, { email: 'used@example.com', kind: 'wave', wave: '1' })
    await redis.hset(`invite:e:${emailKey(SECRET, 'used@example.com')}`, { status: 'used' })
    const timed = async (raw: unknown, ip: string) => {
      const t = performance.now()
      await handleInviteRequest(raw, ip, deps)
      return performance.now() - t
    }
    const times = [
      await timed({ email: EMAIL }, '198.51.100.1'),
      await timed({ email: 'nobody@example.com' }, '198.51.100.2'),
      await timed({ email: 'used@example.com' }, '198.51.100.3'),
      await timed({ email: EMAIL, hpField: 'bot' }, '198.51.100.4')
    ]
    for (let i = 0; i < INVITE_RATE_LIMIT.max; i++) await handleInviteRequest({ email: EMAIL }, '198.51.100.9', deps)
    times.push(await timed({ email: EMAIL }, '198.51.100.9'))
    for (const t of times) expect(t).toBeGreaterThanOrEqual(FLOOR - 5)
  })

  it('does not make the reply wait for a slow mail send', async () => {
    const slow = vi.fn(async () => { await new Promise(r => setTimeout(r, 300)) })
    const { redis, deps, settle } = setup({ floorMs: FLOOR, sendMail: slow })
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    const t = performance.now()
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    expect(performance.now() - t).toBeLessThan(250)
    await settle()
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('still refuses a malformed address with a plain 400 (it says nothing about the list)', async () => {
    const { deps } = setup()
    expect((await handleInviteRequest({ email: 'not-an-email' }, '198.51.100.1', deps)).status).toBe(400)
    expect((await handleInviteRequest(null, '198.51.100.1', deps)).status).toBe(400)
  })
})

describe('the per-IP limit', () => {
  it('limits to 5 requests per 15 minutes per IP hash, and the 6th gets the uniform reply and no mail', async () => {
    expect(INVITE_RATE_LIMIT).toEqual({ max: 5, windowSeconds: 900 })
    const { redis, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    const replies = []
    for (let i = 0; i < 6; i++) replies.push(await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps))
    await settle()
    expect(deps.sendMail).toHaveBeenCalledTimes(5)
    expect(replies[5]).toEqual(replies[0])
    // The key is the early-access limiter with an invite prefix, on a hash of the IP.
    const limiterKeys = redis.keys().filter(k => k.startsWith('rl:early-access:invite:'))
    expect(limiterKeys).toHaveLength(1)
    expect(limiterKeys[0]).toMatch(/^rl:early-access:invite:[0-9a-f]{32}$/)
    expect(limiterKeys[0]).not.toContain('198.51.100.1')
  })

  it('counts each IP on its own, and lets the same IP in again when the window ends', async () => {
    const { redis, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    for (let i = 0; i < 6; i++) await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await handleInviteRequest({ email: EMAIL }, '198.51.100.2', deps)
    await settle()
    expect(deps.sendMail).toHaveBeenCalledTimes(6)
    redis.advance(901)
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await settle()
    expect(deps.sendMail).toHaveBeenCalledTimes(7)
  })

  it('fails closed when the limiter is down: uniform reply, no mail, and the log has no address', async () => {
    const logs: string[] = []
    const { redis, deps, settle } = setup({ log: m => logs.push(m) })
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    vi.spyOn(redis, 'incr').mockRejectedValue(new Error(`down for ${EMAIL}`))
    const res = await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await settle()
    expect(res).toEqual({ status: 200, body: { ok: true, message: UNIFORM_MESSAGE } })
    expect(deps.sendMail).not.toHaveBeenCalled()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain('organizer')
  })
})

describe('the honeypot', () => {
  it('a filled honeypot gets the uniform reply and no mail, token or session', async () => {
    const { redis, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    const clean = await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    const trap = await handleInviteRequest({ email: EMAIL, hpField: 'http://spam.example' }, '198.51.100.2', deps)
    await settle()
    expect(trap).toEqual(clean)
    expect(deps.sendMail).toHaveBeenCalledTimes(1)
    expect(redis.keys().filter(k => k.startsWith('invite:t:'))).toHaveLength(1)
  })
})

describe('one refusal for every bad link', () => {
  it('a forged, a reused and an expired token get the identical status and body', async () => {
    const { redis, sent, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await settle()
    const [first, second] = sent.map(m => tokenOf(m.link))

    const forged = await handleInviteVerify({ token: newToken() }, { redis, secret: SECRET })
    expect((await handleInviteVerify({ token: first! }, { redis, secret: SECRET })).status).toBe(200)
    const reused = await handleInviteVerify({ token: first! }, { redis, secret: SECRET })
    redis.advance(901)
    const expired = await handleInviteVerify({ token: second! }, { redis, secret: SECRET })

    expect(forged.status).toBe(400)
    expect(forged.body).toEqual({ ok: false, message: REFUSAL })
    expect(reused).toEqual(forged)
    expect(expired).toEqual(forged)
    expect(forged.sessionId).toBeUndefined()
    // A body that is not a token at all gets it too.
    expect(await handleInviteVerify({ token: 'short' }, { redis, secret: SECRET })).toEqual(forged)
    expect(await handleInviteVerify(undefined, { redis, secret: SECRET })).toEqual(forged)
  })

  it('refuses a good token when the invite has been used since the link was sent', async () => {
    const { redis, sent, deps, settle } = setup()
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await settle()
    await redis.hset(`invite:e:${emailKey(SECRET, EMAIL)}`, { status: 'used' })
    const res = await handleInviteVerify({ token: tokenOf(sent[0]!.link) }, { redis, secret: SECRET })
    expect(res).toMatchObject({ status: 400, body: { ok: false, message: REFUSAL } })
  })
})

describe('the sign-in mail', () => {
  const mail: InviteMail = { to: EMAIL, link: `https://localnodes.xyz/invite/verify#t=${'a'.repeat(43)}`, inviteId: 'inv123' }

  it('has the subject, the link, the 15-minute note and the ignore line', () => {
    const m = buildInviteMail({ link: mail.link, unsubscribeUrl: 'https://localnodes.xyz/unsubscribe?t=x' })
    expect(m.subject).toBe('Your LocalNodes sign-in link')
    expect(m.text).toContain(mail.link)
    expect(m.text).toContain('15 minutes')
    expect(m.text).toContain('If you didn\'t ask for this, you can ignore this email.')
    expect(m.text).not.toContain('promo')
  })

  it('carries no pilot code, even when the invite has one: the sign-up form fills it in (23-19)', async () => {
    const calls: Array<{ opts: { body: Record<string, unknown> } }> = []
    await sendInviteMail({ ...mail, promoCode: 'PILOT-ONE' }, { apiKey: 're_test', from: 'LocalNodes <hello@example.com>', unsubscribeSecret: SECRET }, async (_url: string, opts: any) => { calls.push({ opts }) })
    expect(String(calls[0]!.opts.body.text)).not.toContain('PILOT-ONE')
    expect(String(calls[0]!.opts.body.html)).not.toContain('PILOT-ONE')
  })

  it('goes out through Resend with the sender, reply-to, an html part, an idempotency key per invite and minute, and List-Unsubscribe', async () => {
    const calls: Array<{ url: string, opts: { method: string, headers: Record<string, string>, body: Record<string, unknown> } }> = []
    const fetcher = async (url: string, opts: any) => { calls.push({ url, opts }) }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T10:00:30Z'))
    try {
      await sendInviteMail({ ...mail, promoCode: 'PILOT-ONE' }, { apiKey: 're_test', from: 'LocalNodes <hello@example.com>', unsubscribeSecret: SECRET }, fetcher)
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toHaveLength(1)
    const { url, opts } = calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer re_test')
    const minute = Math.floor(Date.parse('2026-11-08T10:00:30Z') / 60000)
    expect(opts.headers['Idempotency-Key']).toBe(`invite-inv123-${minute}`)
    expect(opts.body.from).toBe('LocalNodes <hello@example.com>')
    expect(opts.body.to).toEqual([EMAIL])
    expect(opts.body.subject).toBe('Your LocalNodes sign-in link')
    expect(opts.body.reply_to).toBe('hello@localnodes.xyz')
    expect(String(opts.body.html)).toContain('Open my sign-in link')
    expect(String(opts.body.text)).toContain(mail.link)
    expect((opts.body.headers as Record<string, string>)['List-Unsubscribe']).toMatch(/^<https:\/\/localnodes\.xyz\/unsubscribe\?t=[A-Za-z0-9_-]+>$/)
    expect((opts.body.headers as Record<string, string>)['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('will not send without an API key or a sender', async () => {
    const fetcher = vi.fn()
    await expect(sendInviteMail(mail, { apiKey: '', from: 'x <x@example.com>', unsubscribeSecret: SECRET }, fetcher)).rejects.toThrow()
    await expect(sendInviteMail(mail, { apiKey: 're_test', from: '', unsubscribeSecret: SECRET }, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('no address in logs', () => {
  it('a failed send logs a status code and nothing else, whatever the error says', async () => {
    const logs: string[] = []
    const failing = vi.fn(async () => { throw Object.assign(new Error(`Resend refused ${EMAIL}`), { statusCode: 422 }) })
    const { redis, deps, settle } = setup({ sendMail: failing, log: m => logs.push(m) })
    await addInvite(redis, SECRET, { email: EMAIL, kind: 'wave', wave: '1' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await handleInviteRequest({ email: EMAIL }, '198.51.100.1', deps)
    await settle()
    expect(logs).toEqual(['invite: sign-in link not sent (status 422)'])
    const all = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls].flat().join(' ')
    expect(all).not.toContain('organizer')
    expect(logs.join(' ')).not.toContain('organizer')
    vi.restoreAllMocks()
  })
})

describe('runtime config keys', () => {
  const root = resolve(__dirname, '../..')
  const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')
  const KEYS: Array<[string, string]> = [
    ['inviteHashSecret', 'NUXT_INVITE_HASH_SECRET'],
    ['mailFrom', 'NUXT_MAIL_FROM'],
    ['provisionImageTag', 'NUXT_PROVISION_IMAGE_TAG'],
    ['stripeCurrency', 'NUXT_STRIPE_CURRENCY'],
    ['capacityReportSecret', 'NUXT_CAPACITY_REPORT_SECRET'],
    ['capacityMaxSites', 'NUXT_CAPACITY_MAX_SITES'],
    ['capacityPerSiteMb', 'NUXT_CAPACITY_PER_SITE_MB'],
    ['capacityHeadroomMb', 'NUXT_CAPACITY_HEADROOM_MB'],
    ['capacityMinDockerFreeGb', 'NUXT_CAPACITY_MIN_DOCKER_FREE_GB'],
    ['coolifyServerUuid', 'NUXT_COOLIFY_SERVER_UUID'],
    ['geminiApiKey', 'NUXT_GEMINI_API_KEY'],
    ['geminiModel', 'NUXT_GEMINI_MODEL'],
    ['byoKeySecret', 'NUXT_BYO_KEY_SECRET'],
    // The QStash-signed sweep (23-38).
    ['qstashCurrentSigningKey', 'NUXT_QSTASH_CURRENT_SIGNING_KEY'],
    ['qstashNextSigningKey', 'NUXT_QSTASH_NEXT_SIGNING_KEY'],
    ['cronSweepUrl', 'NUXT_CRON_SWEEP_URL'],
    // The paid-sign-up gate (23-32, B-2 Phase 23 part).
    ['paidSignupsEnabled', 'NUXT_PAID_SIGNUPS_ENABLED'],
    // The hidden OpenRouter choice (23-18 follow-up): server-only, copied to page state by a server plugin.
    ['openRouterChoiceEnabled', 'NUXT_OPENROUTER_CHOICE_ENABLED']
  ]
  // The part of nuxt.config.ts before `public:` holds the private keys.
  const privateBlock = config.slice(config.indexOf('runtimeConfig'), config.indexOf('public: {'))
  const publicBlock = config.slice(config.indexOf('public: {'), config.indexOf('routeRules'))

  it.each(KEYS)('%s is a server-only runtime config key documented as %s', (key, envName) => {
    expect(privateBlock).toMatch(new RegExp(`\\b${key}\\b`))
    expect(publicBlock).not.toMatch(new RegExp(`\\b${key}\\b`))
    expect(env).toMatch(new RegExp(`^${envName}=`, 'm'))
  })

  it('keeps launchOpen as the only public key', () => {
    const body = publicBlock.slice(publicBlock.indexOf('{') + 1, publicBlock.indexOf('}'))
    const keys = body.split('\n').map(l => l.replace(/\/\/.*$/, '').trim()).filter(Boolean).map(l => l.replace(/[:,].*$/, ''))
    expect(keys).toEqual(['launchOpen'])
  })

  it('has no pilot card-collection setting (ruling P(a): every sign-up saves a card)', () => {
    expect(config).not.toMatch(/pilotPaymentMethodCollection/)
    expect(env).not.toMatch(/PILOT_PAYMENT_METHOD_COLLECTION/)
  })

  it('sets the defaults the plan fixes', () => {
    expect(config).toMatch(/stripeCurrency:\s*''/)
    expect(config).toMatch(/capacityPerSiteMb:\s*2048/)
    expect(config).toMatch(/capacityHeadroomMb:\s*1024/)
    expect(config).toMatch(/capacityMinDockerFreeGb:\s*10/)
  })
})

describe('the OpenRouter choice setting (23-18 follow-up)', () => {
  const root = resolve(__dirname, '../..')
  const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')

  it('defaults to false and names NUXT_OPENROUTER_CHOICE_ENABLED', () => {
    expect(config).toMatch(/^\s+openRouterChoiceEnabled: false,\s+\/\/ NUXT_OPENROUTER_CHOICE_ENABLED/m)
    expect(env).toMatch(/^NUXT_OPENROUTER_CHOICE_ENABLED=false$/m)
  })
})

describe('the paid-sign-up gate setting (23-32)', () => {
  const root = resolve(__dirname, '../..')
  const config = readFileSync(join(root, 'nuxt.config.ts'), 'utf8')
  const env = readFileSync(join(root, '.env.example'), 'utf8')

  it('defaults to false and names NUXT_PAID_SIGNUPS_ENABLED and the B-2 gate', () => {
    expect(config).toMatch(/^\s+paidSignupsEnabled: false,\s+\/\/ NUXT_PAID_SIGNUPS_ENABLED.*B-2/m)
    expect(env).toMatch(/^NUXT_PAID_SIGNUPS_ENABLED=false$/m)
    expect(env).toMatch(/set to true only after B-2 \(pause and removal\) ships/)
  })
})
