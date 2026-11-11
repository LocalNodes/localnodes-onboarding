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

describe('a pilot whose price cannot be read', () => {
  it('GET with no price is its own phase, so the page offers no Keep button', async () => {
    for (const price of ['', undefined, null]) {
      const fetcher = vi.fn().mockResolvedValue({ state: 'ends', date: 'March 12, 2027', price })
      expect((await callPilotContinue(fetcher, 'GET', TOKEN)).phase).toBe('price-missing')
    }
  })

  it('a price that reads again turns it back into the ready phase', async () => {
    const fetcher = vi.fn().mockResolvedValue({ state: 'ends', date: 'March 12, 2027', price: '$49 a month' })
    expect((await callPilotContinue(fetcher, 'GET', TOKEN)).phase).toBe('ready')
  })

  it('the other states do not need a price', async () => {
    expect((await callPilotContinue(vi.fn().mockResolvedValue({ state: 'continued', date: 'd', price: '' }), 'POST', TOKEN)).phase).toBe('continued')
    expect((await callPilotContinue(vi.fn().mockResolvedValue({ state: 'ended', date: 'd', price: '' }), 'GET', TOKEN)).phase).toBe('ended')
  })

  it('the page shows no Keep button without a price, and Try again reads (GET) again', () => {
    const src = read(PAGE)
    expect(src).toMatch(/const canKeep = computed\(\(\) => Boolean\(known\.value\.date && known\.value\.price\)\)/)
    expect(src).toMatch(/v-if="canKeep"/)
    expect(src).toMatch(/if \(canKeep\.value\) keep\(\)\s*else load\(\)/)
    expect(src).toMatch(/copy\.priceMissing/)
  })
})

describe('the words', () => {
  it('the page says doing nothing costs nothing, then names the price, the card and the date to choose by', () => {
    expect(PILOT_CONTINUE_COPY.ends('March 12, 2027')).toBe('Your free pilot ends on March 12, 2027. If you do nothing, we won\'t charge you anything.')
    const cost = PILOT_CONTINUE_COPY.cost('March 12, 2027', '$49 a month')
    expect(cost).toContain('Continuing costs $49 a month for one community site, including all its groups and members, after your free period and only if you choose it.')
    expect(cost).toContain('We charge the card you saved when you signed up.')
    expect(cost).toContain('To continue, choose "Keep my site" before March 12, 2027.')
  })

  it('with no price the page promises nothing about cost and asks to try again', () => {
    expect(PILOT_CONTINUE_COPY.priceMissing).toBe('We cannot confirm the continuation price right now; please try again before choosing to continue.')
    expect(PILOT_CONTINUE_COPY.cost('March 12, 2027', '')).not.toMatch(/costs|Keep my site/)
  })

  it('the done line names the rate and the card, gives no date, and has a version without a price', () => {
    expect(PILOT_CONTINUE_COPY.continued('$49 a month')).toBe('Done. Your site stays open. It costs $49 a month, charged to the card you saved, starting with the first bill after your free months. Questions? Write to hello@localnodes.xyz.')
    expect(PILOT_CONTINUE_COPY.continued('')).toBe('Done. Your site stays open. Questions? Write to hello@localnodes.xyz.')
  })

  it('a pilot that ended any way gets the same sentence, which says nothing about how long ago', () => {
    expect(PILOT_CONTINUE_COPY.ended).toBe('Your free pilot has already ended, so we can\'t keep the site from this link. Write to hello@localnodes.xyz and we\'ll help.')
  })

  it('no line says "full price", a bracket, or a link expired', () => {
    for (const line of Object.values(PILOT_CONTINUE_COPY)) {
      const text = typeof line === 'function' ? (line as (a: string, b: string) => string)('d', 'p') + (line as (a: string, b: string) => string)('d', '') : line
      expect(text).not.toMatch(/expire/i)
      expect(text).not.toMatch(/full price/i)
      expect(text).not.toMatch(/[\[\]]/)
    }
  })

  it('the button is the mail\'s button', () => {
    expect(PILOT_CONTINUE_COPY.button).toBe('Keep my site')
    expect(read('server/utils/mail-copy.ts')).toMatch(/PILOT_END_BUTTON = 'Keep my site'/)
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
