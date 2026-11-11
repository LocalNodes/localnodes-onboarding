// The free pilot's continue page and route (fresh3 23, pilot end). The end
// mail links to /pilot/continue. Opening it changes nothing; only the button's
// POST keeps the site. These tests cover the page's logic module, the route's
// wiring and the page's guards. The server's judgement of the token and the
// subscription is in pilot-end.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PILOT_CONTINUE_COPY, callPilotContinue, pilotTokenFromQuery } from '~/utils/pilot-continue-flow'
import { PILOT_CONTINUE_TOKEN_RE } from '#shared/pilot-continue'
import { gateDecision } from '#shared/launch'
import { sealContinueToken } from '../../server/utils/pilot-end'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const PAGE = 'app/pages/pilot/continue.vue'
const FLOW = 'app/utils/pilot-continue-flow.ts'
const ROUTE = 'server/api/pilot-continue.ts'
const TOKEN = sealContinueToken('sub_test_pilot', 1_800_000_000, 'test-invite-hash-secret')

const httpError = (status: number) => Object.assign(new Error('x'), { statusCode: status })

describe('pilotTokenFromQuery', () => {
  it('takes a token-shaped t and nothing else', () => {
    expect(pilotTokenFromQuery(TOKEN)).toBe(TOKEN)
    expect(PILOT_CONTINUE_TOKEN_RE.test(TOKEN)).toBe(true)
    for (const bad of [undefined, null, '', 'short', [TOKEN], 'x'.repeat(2000), 'has spaces in it and is long enough to pass the length check', 42]) {
      expect(pilotTokenFromQuery(bad as never)).toBeNull()
    }
  })

  it('the page bundle pulls in no server code and no node:crypto', () => {
    expect(read(FLOW) + read(PAGE)).not.toMatch(/server\/utils|node:crypto/)
  })
})

describe('callPilotContinue', () => {
  it('GET reads the state with the token in the query, and maps ends to ready', async () => {
    const fetcher = vi.fn().mockResolvedValue({ state: 'ends', date: 'March 12, 2027', price: '$20 a month' })
    expect(await callPilotContinue(fetcher, 'GET', TOKEN)).toEqual({ phase: 'ready', date: 'March 12, 2027', price: '$20 a month' })
    expect(fetcher).toHaveBeenCalledWith('/api/pilot-continue', { method: 'GET', query: { t: TOKEN } })
  })

  it('POST answers continued, and ended stays ended', async () => {
    expect((await callPilotContinue(vi.fn().mockResolvedValue({ state: 'continued', date: 'd', price: 'p' }), 'POST', TOKEN)).phase).toBe('continued')
    expect((await callPilotContinue(vi.fn().mockResolvedValue({ state: 'ended', date: 'd', price: 'p' }), 'POST', TOKEN)).phase).toBe('ended')
  })

  it('400 is invalid; 503, no answer or a body with no known state is a server error, never continued', async () => {
    expect((await callPilotContinue(vi.fn().mockRejectedValue(httpError(400)), 'POST', TOKEN)).phase).toBe('invalid')
    expect((await callPilotContinue(vi.fn().mockRejectedValue(httpError(503)), 'POST', TOKEN)).phase).toBe('server-error')
    expect((await callPilotContinue(vi.fn().mockRejectedValue(new Error('offline')), 'POST', TOKEN)).phase).toBe('server-error')
    for (const body of [null, {}, { state: 'unavailable' }, { state: 'yes' }, { state: '__proto__' }, 'continued']) {
      expect((await callPilotContinue(vi.fn().mockResolvedValue(body), 'POST', TOKEN)).phase).toBe('server-error')
    }
  })
})

describe('the words (draft wording, to be confirmed)', () => {
  it('the page says doing nothing costs nothing, and that keeping the site charges the saved card the full price', () => {
    expect(PILOT_CONTINUE_COPY.ends('March 12, 2027')).toMatch(/If you do nothing, we won't charge you anything\./)
    expect(PILOT_CONTINUE_COPY.cost('March 12, 2027', '$20 a month')).toMatch(/\$20 a month, charged to the card you saved/)
    expect(PILOT_CONTINUE_COPY.cost('March 12, 2027', '')).toMatch(/the full price/)
    expect(PILOT_CONTINUE_COPY.continued('March 12, 2027', '$20 a month')).toMatch(/\$20 a month/)
  })

  it('the button is the mail\'s button', () => {
    expect(PILOT_CONTINUE_COPY.button).toBe('Keep my site')
    expect(read('server/utils/mail-copy.ts')).toMatch(/PILOT_END_BUTTON = 'Keep my site'/)
  })

  it('no line says a link expired', () => {
    for (const line of Object.values(PILOT_CONTINUE_COPY)) {
      const text = typeof line === 'function' ? (line as (a: string, b: string) => string)('d', 'p') : line
      expect(text).not.toMatch(/expire/i)
    }
  })
})

describe('the route and the page', () => {
  it('neither the page nor the API is gated: a pilot answers while the launch is closed', () => {
    expect(gateDecision('/pilot/continue', false)).toBe('pass')
    expect(gateDecision('/api/pilot-continue', false)).toBe('pass')
  })

  it('the route answers GET and POST only, never caches, sends no Referer, and passes the method on', () => {
    const src = read(ROUTE)
    expect(src).toMatch(/method !== 'GET' && method !== 'POST'/)
    expect(src).toMatch(/'Cache-Control', 'no-store'/)
    expect(src).toMatch(/'Referrer-Policy', 'no-referrer'/)
    expect(src).toMatch(/handlePilotContinue\(method,/)
    expect(src).toMatch(/secret: String\(config\.inviteHashSecret/)
  })

  it('the route builds Stripe on first use, so a forged token never builds a client', () => {
    const src = read(ROUTE)
    expect(src).not.toMatch(/stripe: useStripe\(\)/)
    expect(src).toMatch(/retrieve: id => \(useStripe\(\)/)
  })

  it('the page route rule never caches, sends no Referer and is noindex', () => {
    const cfg = read('nuxt.config.ts')
    const rule = cfg.slice(cfg.indexOf('\'/pilot/continue\''))
    expect(rule.slice(0, 300)).toMatch(/'Cache-Control': 'no-store'[\s\S]*'Referrer-Policy': 'no-referrer'[\s\S]*'X-Robots-Tag': 'noindex'/)
  })

  it('the page reads with GET on mount and posts only from the button', () => {
    const src = read(PAGE)
    expect(src).toMatch(/callPilotContinue\(fetcher, 'GET', token\)/)
    expect(src.match(/callPilotContinue\(fetcher, 'POST', token\)/g)).toHaveLength(1)
    expect(src).toMatch(/async function keep\(\)[\s\S]*'POST'/)
    expect(src).toMatch(/@click="keep"/)
    expect(src).toMatch(/onMounted\(\(\) => \{[\s\S]*load\(\)/)
  })

  it('the sign-up claims check scans the page and its words', () => {
    const fixture = JSON.parse(read('tests/fixtures/banned-claims.json')) as { signupSources: string[] }
    expect(fixture.signupSources).toEqual(expect.arrayContaining([PAGE, FLOW]))
  })
})
