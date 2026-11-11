// A real unsubscribe link for early-access mails (fresh3 23-19, ruling R5 (a),
// RFC 8058). The token is AES-256-GCM sealed, keyed by HKDF-SHA256 over the
// existing invite secret with the fixed label "localnodes-unsubscribe-v1". It
// holds the address and the list, and never expires (orchestrator, 2026-11-08:
// CAN-SPAM wants 30 days at least, so links never expire); a token from the
// first format, with an expiry, still works and its expiry is ignored. The
// one-click POST removes the address from the early-access segment in Resend; a
// GET never removes anything. Resend is mocked: no live call.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import {
  BAD_TOKEN_MESSAGE,
  UNSUBSCRIBE_KEY_LABEL,
  UNSUBSCRIBE_LIST,
  handleUnsubscribe,
  openUnsubscribeToken,
  sealUnsubscribeToken,
  unsubscribeHeaders,
  unsubscribeUrl,
  type UnsubscribeDeps
} from '../../server/utils/unsubscribe'
import { sendInviteMail } from '../../server/utils/invites'
import { STOPPED_MAIL, buildInviteMail, renderMail } from '../../server/utils/mail-copy'
import { gateDecision } from '../../shared/launch'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const SECRET = 'test-invite-hash-secret'
const EMAIL = 'organizer@example.org'
const NOW = Date.parse('2026-11-08T12:00:00Z')
const DAY = 86400 * 1000
/** Resend's per-contact placeholder, built from parts so this file never holds it whole. */
const PLACEHOLDER = ['{{{', 'RESEND_UNSUBSCRIBE_URL', '}}}'].join('')

const keyOf = (label = 'localnodes-unsubscribe-v1') => Buffer.from(hkdfSync('sha256', SECRET, '', label, 32))
/** Seals any payload by hand under the unsubscribe key, the way the module does. */
function sealByHand(payload: unknown, label?: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(label), iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')
}
/** Opens a token by hand and returns its payload. */
function openByHand(token: string): Record<string, unknown> {
  const raw = Buffer.from(token, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', keyOf(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'))
}
/** A token in the first 23-19 format: the address and an expiry, as links built before 2026-11-08 carry. */
const firstFormat = (expirySeconds: number) => sealByHand({ e: EMAIL, x: expirySeconds })

describe('the sealed token', () => {
  it('sealUnsubscribeToken then openUnsubscribeToken returns the address', () => {
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    expect(openUnsubscribeToken(token, SECRET)).toBe(EMAIL)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).not.toContain('organizer')
  })

  it('a flipped byte is refused', () => {
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    const raw = Buffer.from(token, 'base64url')
    for (const at of [0, 13, raw.length - 1]) {
      const bad = Buffer.from(raw)
      bad[at] = bad[at]! ^ 0x01
      expect(openUnsubscribeToken(bad.toString('base64url'), SECRET)).toBeNull()
    }
  })

  it('a token from another key is refused', () => {
    const other = sealUnsubscribeToken(EMAIL, 'another-secret')
    expect(openUnsubscribeToken(other, SECRET)).toBeNull()
  })

  it('a token holds the address and the list only: no expiry field', () => {
    expect(UNSUBSCRIBE_LIST).toBe('early-access')
    expect(openByHand(sealUnsubscribeToken(EMAIL, SECRET))).toEqual({ e: EMAIL, s: 'early-access' })
  })

  it('links never expire: a token still opens ten years on', () => {
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(NOW + 3650 * DAY)
      expect(openUnsubscribeToken(token, SECRET)).toBe(EMAIL)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a first-format token (address and expiry) still opens, and its expiry is ignored', () => {
    // Links already built in tests or mails before 2026-11-08 carry {e, x}.
    expect(openUnsubscribeToken(firstFormat(Math.floor(NOW / 1000) + 60 * 86400), SECRET)).toBe(EMAIL)
    expect(openUnsubscribeToken(firstFormat(Math.floor(NOW / 1000) - 61 * 86400), SECRET)).toBe(EMAIL)
  })

  it('a token dated far in the past still works', () => {
    // Expired on 1970-01-02 in the first format.
    expect(openUnsubscribeToken(firstFormat(86400), SECRET)).toBe(EMAIL)
    // And a current-format token sealed on 2000-01-01.
    vi.useFakeTimers()
    let old = ''
    try {
      vi.setSystemTime(Date.parse('2000-01-01T00:00:00Z'))
      old = sealUnsubscribeToken(EMAIL, SECRET)
    } finally {
      vi.useRealTimers()
    }
    expect(openUnsubscribeToken(old, SECRET)).toBe(EMAIL)
  })

  it('a token for another list, or with no address, is refused', () => {
    expect(openUnsubscribeToken(sealByHand({ e: EMAIL, s: 'some-other-list' }), SECRET)).toBeNull()
    expect(openUnsubscribeToken(sealByHand({ s: 'early-access' }), SECRET)).toBeNull()
    expect(openUnsubscribeToken(sealByHand({ e: '', s: 'early-access' }), SECRET)).toBeNull()
    expect(openUnsubscribeToken(sealByHand('just a string'), SECRET)).toBeNull()
  })

  it('garbage, an empty token and a non-string are refused', () => {
    for (const bad of ['', 'abc', 'x'.repeat(200), '!!!', null, undefined, 42]) {
      expect(openUnsubscribeToken(bad as string, SECRET)).toBeNull()
    }
  })

  it('the key is HKDF-SHA256 of the invite secret with the fixed label "localnodes-unsubscribe-v1"', () => {
    expect(UNSUBSCRIBE_KEY_LABEL).toBe('localnodes-unsubscribe-v1')
    // Seal by hand with the derived key: the module must open it.
    expect(openUnsubscribeToken(sealByHand({ e: EMAIL, s: 'early-access' }), SECRET)).toBe(EMAIL)
    // The same secret with another label does not open it.
    expect(openUnsubscribeToken(sealByHand({ e: EMAIL, s: 'early-access' }, 'localnodes-unsubscribe-v2'), SECRET)).toBeNull()
  })

  it('no new config key is added: the secret is the existing inviteHashSecret', () => {
    // runtimeConfig only: the route rules name the /unsubscribe page.
    const config = read('nuxt.config.ts')
    const runtimeConfig = config.slice(config.indexOf('runtimeConfig:'), config.indexOf('routeRules:'))
    expect(runtimeConfig.length).toBeGreaterThan(100)
    expect(runtimeConfig).not.toMatch(/unsubscribe/i)
    expect(read('.env.example')).not.toMatch(/UNSUBSCRIBE/)
    expect(read('server/routes/unsubscribe.post.ts')).toMatch(/secret: config\.inviteHashSecret/)
  })

  it('an empty secret seals nothing', () => {
    expect(() => sealUnsubscribeToken(EMAIL, '')).toThrow()
    expect(openUnsubscribeToken(sealUnsubscribeToken(EMAIL, SECRET), '')).toBeNull()
  })
})

describe('the link and the RFC 8058 headers', () => {
  it('the link is https://localnodes.xyz/unsubscribe?t=‹token›', () => {
    const url = unsubscribeUrl(EMAIL, { secret: SECRET })
    expect(url).toMatch(/^https:\/\/localnodes\.xyz\/unsubscribe\?t=[A-Za-z0-9_-]+$/)
    expect(openUnsubscribeToken(new URL(url).searchParams.get('t')!, SECRET)).toBe(EMAIL)
  })

  it('unsubscribeHeaders returns List-Unsubscribe and List-Unsubscribe-Post', () => {
    const url = 'https://localnodes.xyz/unsubscribe?t=abc'
    expect(unsubscribeHeaders(url)).toEqual({
      'List-Unsubscribe': '<https://localnodes.xyz/unsubscribe?t=abc>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    })
  })
})

// --- the one-click POST ----------------------------------------------------------------

function setup(overrides: Partial<UnsubscribeDeps> = {}) {
  const calls: Array<{ url: string, opts: { method: string, headers: Record<string, string> } }> = []
  const removed = new Set<string>()
  const logs: string[] = []
  const deps: UnsubscribeDeps = {
    secret: SECRET,
    apiKey: 're_test',
    segmentId: 'seg_early',
    log: m => logs.push(m),
    fetch: async (url, opts) => {
      calls.push({ url, opts })
      if (removed.has(url)) throw Object.assign(new Error('not found'), { statusCode: 404 })
      removed.add(url)
      return { object: 'contact_segment', deleted: true }
    },
    ...overrides
  }
  return { deps, calls, logs }
}

describe('handleUnsubscribe (POST /unsubscribe?t=‹token›)', () => {
  it('removes the address from the early-access segment once and answers 200 with no page', async () => {
    const { deps, calls } = setup()
    const out = await handleUnsubscribe(sealUnsubscribeToken(EMAIL, SECRET), deps)
    expect(out).toEqual({ status: 200, body: { ok: true } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.resend.com/contacts/organizer%40example.org/segments/seg_early')
    expect(calls[0]!.opts.method).toBe('DELETE')
    expect(calls[0]!.opts.headers.Authorization).toBe('Bearer re_test')
  })

  it('a repeat POST answers 200 and changes nothing', async () => {
    const { deps, calls } = setup()
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    await handleUnsubscribe(token, deps)
    expect(await handleUnsubscribe(token, deps)).toEqual({ status: 200, body: { ok: true } })
    expect(calls.every(c => c.opts.method === 'DELETE')).toBe(true)
  })

  it('a bad token answers 400 with one fixed message and calls nothing', async () => {
    const { deps, calls } = setup()
    const foreign = sealUnsubscribeToken(EMAIL, 'another-secret')
    const otherList = sealByHand({ e: EMAIL, s: 'some-other-list' })
    for (const token of ['', 'garbage', foreign, otherList]) {
      expect(await handleUnsubscribe(token, deps)).toEqual({ status: 400, body: { ok: false, message: BAD_TOKEN_MESSAGE } })
    }
    expect(calls).toHaveLength(0)
  })

  it('a first-format token long past its expiry still unsubscribes (200, one DELETE)', async () => {
    const { deps, calls } = setup()
    expect(await handleUnsubscribe(firstFormat(86400), deps)).toEqual({ status: 200, body: { ok: true } })
    expect(calls.map(c => `${c.opts.method} ${c.url}`)).toEqual(['DELETE https://api.resend.com/contacts/organizer%40example.org/segments/seg_early'])
  })

  it('Resend down or no list configured answers 503 and says nothing about the address', async () => {
    const down = setup({ fetch: async () => { throw Object.assign(new Error(`failed for ${EMAIL}`), { statusCode: 500 }) } })
    const out = await handleUnsubscribe(sealUnsubscribeToken(EMAIL, SECRET), down.deps)
    expect(out.status).toBe(503)
    expect(JSON.stringify(out)).not.toContain('organizer')
    const bare = setup({ segmentId: '' })
    expect((await handleUnsubscribe(sealUnsubscribeToken(EMAIL, SECRET), bare.deps)).status).toBe(503)
    expect(bare.calls).toHaveLength(0)
  })

  it('logs the outcome word only, never the address', async () => {
    const { deps, logs } = setup()
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    await handleUnsubscribe(token, deps)
    await handleUnsubscribe(token, deps)
    await handleUnsubscribe('garbage', deps)
    expect(logs).toEqual(['unsubscribe: removed', 'unsubscribe: already removed', 'unsubscribe: refused'])
    expect(logs.join(' ')).not.toMatch(/organizer|example\.org/)
  })
})

describe('the route (server/routes/unsubscribe.post.ts)', () => {
  const g = globalThis as Record<string, unknown>
  let deleted: string[]

  beforeEach(() => {
    deleted = []
    g.useRuntimeConfig = () => ({ inviteHashSecret: SECRET, resendApiKey: 're_test', resendSegmentId: 'seg_early', launchOpen: false })
    g.$fetch = async (url: string, opts: { method: string }) => { deleted.push(`${opts.method} ${url}`); return { deleted: true } }
  })
  afterEach(() => { delete g.useRuntimeConfig; delete g.$fetch })

  async function handler() {
    vi.resetModules()
    const { default: gate } = await import('../../server/middleware/launch-gate')
    const { default: route } = await import('../../server/routes/unsubscribe.post')
    const a = createApp()
    a.use(gate)
    const r = createRouter()
    r.post('/unsubscribe', route)
    r.get('/unsubscribe', defineEventHandler(() => 'page'))
    a.use(r)
    return toWebHandler(a)
  }

  it('an RFC 8058 one-click POST (form body List-Unsubscribe=One-Click) answers 200 and removes the address', async () => {
    const token = sealUnsubscribeToken(EMAIL, SECRET)
    const res = await (await handler())(new Request(`http://localhost/unsubscribe?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click'
    }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(deleted).toEqual(['DELETE https://api.resend.com/contacts/organizer%40example.org/segments/seg_early'])
  })

  it('a bad token answers 400', async () => {
    const res = await (await handler())(new Request('http://localhost/unsubscribe?t=garbage', { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))
    expect(res.status).toBe(400)
    expect(deleted).toEqual([])
  })

  it('/unsubscribe passes the launch gate while NUXT_LAUNCH_OPEN is closed, for GET and POST', async () => {
    expect(gateDecision('/unsubscribe', false)).toBe('pass')
    const h = await handler()
    const get = await h(new Request('http://localhost/unsubscribe?t=x'))
    expect(get.status).toBe(200)
    expect(await get.text()).toBe('page')
    const post = await h(new Request('http://localhost/unsubscribe?t=x', { method: 'POST' }))
    expect(post.status).toBe(400)
  })

  it('a GET never removes anything: only the POST route calls Resend', async () => {
    const h = await handler()
    await h(new Request(`http://localhost/unsubscribe?t=${sealUnsubscribeToken(EMAIL, SECRET)}`))
    expect(deleted).toEqual([])
    const routes = readdirSync(join(root, 'server/routes'))
    expect(routes.filter(f => f.startsWith('unsubscribe'))).toEqual(['unsubscribe.post.ts'])
  })
})

// --- the invite mail ----------------------------------------------------------------------

describe('the invite mail carries the real link and headers', () => {
  it('List-Unsubscribe <https://localnodes.xyz/unsubscribe?t=…>, List-Unsubscribe-Post, and the same URL as the body\'s Unsubscribe link', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = []
    await sendInviteMail(
      { to: EMAIL, link: `https://localnodes.xyz/invite/verify#t=${'a'.repeat(43)}`, inviteId: 'inv1' },
      { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', unsubscribeSecret: SECRET },
      async (_url, opts) => { calls.push({ body: opts.body as Record<string, unknown> }) }
    )
    const body = calls[0]!.body
    const headers = body.headers as Record<string, string>
    const m = /^<(https:\/\/localnodes\.xyz\/unsubscribe\?t=[A-Za-z0-9_-]+)>$/.exec(headers['List-Unsubscribe']!)
    expect(m).not.toBeNull()
    const url = m![1]!
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(String(body.text)).toContain(`Unsubscribe: ${url}`)
    expect(String(body.html)).toContain(`href="${url}"`)
    expect(openUnsubscribeToken(new URL(url).searchParams.get('t')!, SECRET)).toBe(EMAIL)
  })

  it('will not send an invite mail without the unsubscribe secret', async () => {
    const fetcher = vi.fn()
    await expect(sendInviteMail(
      { to: EMAIL, link: 'https://localnodes.xyz/invite/verify#t=x', inviteId: 'inv1' },
      { apiKey: 're_test', from: 'LocalNodes <hello@localnodes.xyz>', unsubscribeSecret: '' },
      fetcher
    )).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('Resend\'s per-contact placeholder is never in a POST /emails mail (ruling R5)', () => {
  it('no transactional mail builder\'s output contains it', () => {
    const outputs = [
      buildInviteMail({ link: 'https://localnodes.xyz/invite/verify#t=x', unsubscribeUrl: 'https://localnodes.xyz/unsubscribe?t=x' }),
      STOPPED_MAIL,
      renderMail({ subject: 's', before: ['b'], after: [] })
    ]
    for (const m of outputs) {
      expect(m.subject + m.text + m.html).not.toContain(PLACEHOLDER)
      expect(m.text + m.html).not.toContain('RESEND_UNSUBSCRIBE_URL')
    }
  })

  it('no file in mailSources and no mail sender contains it', () => {
    const fixture = JSON.parse(read('tests/fixtures/banned-claims.json')) as { mailSources: string[] }
    for (const file of [...fixture.mailSources, 'server/utils/invites.ts', 'server/utils/retry-stop.ts', 'server/utils/unsubscribe.ts']) {
      expect(read(file), file).not.toContain(PLACEHOLDER)
      expect(read(file), file).not.toContain('RESEND_UNSUBSCRIBE_URL')
    }
  })

  it('the stopped mail carries no unsubscribe link at all', () => {
    expect(STOPPED_MAIL.text + STOPPED_MAIL.html).not.toMatch(/unsubscribe/i)
  })
})
