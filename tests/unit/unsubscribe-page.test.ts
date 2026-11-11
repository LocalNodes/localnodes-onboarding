// The /unsubscribe page (fresh3 23-19 follow-up; ruling R5, RFC 8058;
// 23-UI-SPEC.md "Unsubscribe page"). A mail's footer link opens it. Opening it
// removes nothing: mail scanners prefetch links, so only the button's POST (or
// the mail client's RFC 8058 one-click POST) takes the address off the list.
// The words are the UI-SPEC rows, word for word. The states are mounted with
// Vue's server renderer and small Nuxt UI stand-ins (the 23-19 and 23-20
// pattern). Resend is never called: $fetch is a spy.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { UNSUBSCRIBE_COPY, postUnsubscribe, tokenFromQuery, type UnsubscribeFetcher } from '~/utils/unsubscribe-flow'
import { UNSUBSCRIBE_TOKEN_RE } from '#shared/unsubscribe'
import { gateDecision, GATED_PAGES } from '#shared/launch'
import { sealUnsubscribeToken } from '../../server/utils/unsubscribe'
import UnsubscribePanel from '../../app/components/UnsubscribePanel.vue'
import UnsubscribePage from '../../app/pages/unsubscribe.vue'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')
const PAGE = 'app/pages/unsubscribe.vue'
const PANEL = 'app/components/UnsubscribePanel.vue'
const FLOW = 'app/utils/unsubscribe-flow.ts'
const EMAIL = 'organizer@example.org'
const TOKEN = sealUnsubscribeToken(EMAIL, 'test-invite-hash-secret')

describe('the words (23-UI-SPEC "Unsubscribe page", word for word)', () => {
  it('every string is its UI-SPEC row', () => {
    expect(UNSUBSCRIBE_COPY).toEqual({
      title: 'Unsubscribe',
      intro: 'Stop getting LocalNodes early-access emails at this address.',
      button: 'Unsubscribe',
      buttonWorking: 'Unsubscribing…',
      done: 'You\'re unsubscribed. We won\'t send you early-access emails anymore.',
      refused: 'This unsubscribe link doesn\'t work. Reply to any of our emails, or write to hello@localnodes.xyz, and we\'ll take you off the list.',
      serverError: 'Something went wrong on our side. Try again in a minute.'
    })
  })

  it('no line says a link expired: links never expire (orchestrator, 2026-11-08)', () => {
    for (const line of Object.values(UNSUBSCRIBE_COPY)) expect(line).not.toMatch(/expire/i)
  })
})

describe('tokenFromQuery', () => {
  it('takes a token-shaped t and nothing else', () => {
    expect(tokenFromQuery(TOKEN)).toBe(TOKEN)
    expect(tokenFromQuery([TOKEN])).toBeNull()
    for (const bad of [undefined, null, '', 'short', 'x'.repeat(2000), 'has spaces in it and is long enough to pass the length check', 42]) {
      expect(tokenFromQuery(bad as never)).toBeNull()
    }
  })

  it('uses the server\'s token shape, from one shared place', () => {
    expect(UNSUBSCRIBE_TOKEN_RE.test(TOKEN)).toBe(true)
    expect(read('server/utils/unsubscribe.ts')).toMatch(/UNSUBSCRIBE_TOKEN_RE/)
    expect(read(FLOW)).toMatch(/UNSUBSCRIBE_TOKEN_RE/)
    // The page bundle must not pull in node:crypto (23-20 found the dev server 500s on it).
    expect(read(FLOW) + read(PAGE) + read(PANEL)).not.toMatch(/server\/utils|node:crypto|byo-key/)
  })
})

describe('postUnsubscribe (the button\'s POST)', () => {
  const calls: Array<{ url: string, opts: unknown }> = []
  const answering = (fail?: { statusCode?: number }): UnsubscribeFetcher => async (url, opts) => {
    calls.push({ url, opts })
    if (fail) throw Object.assign(new Error('x'), fail)
    return { ok: true }
  }
  beforeEach(() => { calls.length = 0 })

  it('POSTs to /unsubscribe with the token as t and reads 200 as done', async () => {
    expect(await postUnsubscribe(answering(), TOKEN)).toBe('done')
    expect(calls).toEqual([{ url: '/unsubscribe', opts: { method: 'POST', query: { t: TOKEN } } }])
  })

  it('reads 400 as the link not working', async () => {
    expect(await postUnsubscribe(answering({ statusCode: 400 }), TOKEN)).toBe('refused')
  })

  it('reads 503, any other status or no answer at all as a server problem', async () => {
    expect(await postUnsubscribe(answering({ statusCode: 503 }), TOKEN)).toBe('server-error')
    expect(await postUnsubscribe(answering({ statusCode: 500 }), TOKEN)).toBe('server-error')
    expect(await postUnsubscribe(answering({}), TOKEN)).toBe('server-error')
  })
})

// --- mounted ----------------------------------------------------------------------

const g = globalThis as Record<string, unknown>

const stubs: Record<string, Component> = {
  UContainer: defineComponent((_, { slots }) => () => h('div', slots.default?.())),
  UButton: defineComponent({
    props: ['label', 'loading', 'disabled'],
    setup: (p, { attrs }) => () => h('button', { ...attrs, disabled: p.disabled || undefined }, p.label)
  }),
  UAlert: defineComponent({
    props: ['description', 'color'],
    setup: (p, { attrs }) => () => h('div', { ...attrs, 'data-alert': p.color }, p.description)
  }),
  UIcon: defineComponent(() => () => h('span', { 'aria-hidden': 'true' }))
}

async function mount(component: Component, props: Record<string, unknown> = {}): Promise<string> {
  const app = createSSRApp(component, props)
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  app.component('UnsubscribePanel', UnsubscribePanel)
  return renderToString(app)
}

/** The visible text of rendered HTML, with entities decoded. */
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('mounted: the states', () => {
  it('default: the intro and the Unsubscribe button, and never the address', async () => {
    const html = await mount(UnsubscribePanel, { phase: 'ready' })
    const text = textOf(html)
    expect(text).toContain('Stop getting LocalNodes early-access emails at this address.')
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/)
    expect(text).not.toContain(UNSUBSCRIBE_COPY.done)
    expect(text).not.toContain(UNSUBSCRIBE_COPY.refused)
    expect(text).not.toContain(UNSUBSCRIBE_COPY.serverError)
    expect(html).not.toMatch(/@|example\.org/)
  })

  it('working: the button reads Unsubscribing… and is disabled, and the live region says so', async () => {
    const html = await mount(UnsubscribePanel, { phase: 'working' })
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Unsubscribing…<\/button>/)
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*>Unsubscribing…<\/p>/)
  })

  it('done: the done line, focusable for the move after the POST, and no button', async () => {
    const html = await mount(UnsubscribePanel, { phase: 'done' })
    expect(textOf(html)).toContain('You\'re unsubscribed. We won\'t send you early-access emails anymore.')
    expect(html).toMatch(/tabindex="-1"[^>]*>You&#39;re unsubscribed\./)
    expect(html).not.toMatch(/<button/)
    expect(textOf(html)).not.toContain(UNSUBSCRIBE_COPY.intro)
  })

  // F8 extended to the unsubscribe lines (fresh3 23-39; orchestrator Q1 answer,
  // 2026-11-08): each takes focus and carries no alert role, so the focus move
  // reads it once.
  const focusTargets = (html: string) => html.match(/<[a-z][a-z0-9]*\b[^>]*\stabindex="-1"[^>]*>/g) ?? []

  it('link doesn\'t work: the refused line, focusable, read once by the focus move with no alert role (F8), with no button', async () => {
    const html = await mount(UnsubscribePanel, { phase: 'refused' })
    expect(textOf(html)).toContain('This unsubscribe link doesn\'t work. Reply to any of our emails, or write to hello@localnodes.xyz, and we\'ll take you off the list.')
    const target = focusTargets(html)
    expect(target).toHaveLength(1)
    expect(target[0]).not.toMatch(/\srole=/)
    expect(html).not.toMatch(/role="alert"/)
    expect(html).not.toMatch(/<button/)
  })

  it('server problem: the line, focusable, read once by the focus move with no alert role (F8), and the button stays so it can be tried again', async () => {
    const html = await mount(UnsubscribePanel, { phase: 'server-error' })
    expect(textOf(html)).toContain('Something went wrong on our side. Try again in a minute.')
    const target = focusTargets(html)
    expect(target).toHaveLength(1)
    expect(target[0]).not.toMatch(/\srole=/)
    expect(html).not.toMatch(/role="alert"/)
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/)
  })

  it('the panel still moves focus to the result line when one appears (F8 keeps the focus move)', () => {
    const src = read('app/components/UnsubscribePanel.vue')
    const start = src.indexOf('async function focusResult(')
    expect(start).toBeGreaterThan(-1)
    expect(src.slice(start, src.indexOf('\n}', start))).toMatch(/result\.value\?\.focus\(\)/)
    expect(src.match(/ref="result"/g)).toHaveLength(3)
    expect(src).not.toMatch(/role="alert"/)
  })

  it('every state keeps the one polite live region in the page', async () => {
    for (const phase of ['ready', 'working', 'done', 'refused', 'server-error']) {
      const html = await mount(UnsubscribePanel, { phase })
      expect(html.match(/aria-live="polite"/g), phase).toHaveLength(1)
    }
  })
})

describe('mounted: the page', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let query: Record<string, unknown>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true }))
    query = {}
    g.definePageMeta = vi.fn()
    g.useSeoMeta = vi.fn()
    g.useRoute = () => ({ query })
    g.$fetch = fetchSpy
  })
  afterEach(() => { for (const k of ['definePageMeta', 'useSeoMeta', 'useRoute', '$fetch']) delete g[k] })

  it('GET /unsubscribe?t=<valid> renders the h1, the intro and the button, and sends nothing: the address stays subscribed', async () => {
    query = { t: TOKEN }
    const html = await mount(UnsubscribePage)
    expect(html).toMatch(/<h1[^>]*>\s*Unsubscribe\s*<\/h1>/)
    expect(textOf(html)).toContain(UNSUBSCRIBE_COPY.intro)
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(g.definePageMeta).toHaveBeenCalledWith({ colorMode: 'light' })
    expect(g.useSeoMeta).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unsubscribe - LocalNodes' }))
  })

  it('a link with no token, or a malformed one, shows the link-doesn\'t-work line straight away and sends nothing', async () => {
    for (const t of [undefined, 'garbage']) {
      query = t === undefined ? {} : { t }
      const text = textOf(await mount(UnsubscribePage))
      expect(text).toContain(UNSUBSCRIBE_COPY.refused)
      expect(text).not.toContain(UNSUBSCRIBE_COPY.intro)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the page never prints the token or the address', async () => {
    query = { t: TOKEN }
    const html = await mount(UnsubscribePage)
    expect(html).not.toContain(TOKEN)
    expect(html).not.toMatch(/organizer|example\.org/)
  })
})

describe('the page source: only the button posts', () => {
  const script = () => read(PAGE).split('</script>')[0]!

  it('postUnsubscribe is called once, inside the button handler, never at setup or in onMounted', () => {
    expect(script().match(/postUnsubscribe\(/g)).toHaveLength(1)
    const handler = script().slice(script().indexOf('async function confirm'))
    expect(handler).toMatch(/postUnsubscribe\(/)
    expect(script()).not.toMatch(/onMounted|watchEffect|useFetch|useAsyncData/)
    expect(read(PAGE)).toMatch(/@confirm="confirm"/)
  })

  it('is forced light, has one h1 and a 640px column, and moves focus to the result line', () => {
    const page = read(PAGE)
    expect(page).toMatch(/definePageMeta\(\{ colorMode: 'light' \}\)/)
    expect(page.match(/<h1\b/g)).toHaveLength(1)
    expect(page).toMatch(/max-w-2xl/)
    expect(read(PANEL)).toMatch(/\.focus\(\)/)
  })

  it('uses token classes only: no raw colours', () => {
    const src = read(PAGE) + read(PANEL)
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|(?:text|bg|border)-(?:red|green|blue|gray|slate|zinc|neutral|white|black)-?\d*/)
  })
})

describe('route rules and the launch gate', () => {
  it('/unsubscribe is server-rendered, never cached and sends no Referer, so the token in the link can\'t leak', () => {
    const rule = read('nuxt.config.ts').match(/'\/unsubscribe':\s*\{[\s\S]*?\n\s{4}\}/)
    expect(rule, 'a /unsubscribe route rule').not.toBeNull()
    expect(rule![0]).toMatch(/ssr:\s*true/)
    expect(rule![0]).toMatch(/'Cache-Control':\s*'no-store'/)
    expect(rule![0]).toMatch(/'Referrer-Policy':\s*'no-referrer'/)
    expect(rule![0]).toMatch(/'X-Robots-Tag':\s*'noindex'/)
  })

  it('the page passes the closed launch gate', () => {
    expect(GATED_PAGES).not.toContain('/unsubscribe')
    expect(gateDecision('/unsubscribe', false)).toBe('pass')
    expect(gateDecision(`/unsubscribe?t=${TOKEN}`, false)).toBe('pass')
  })

  it('the wording check scans the page, the panel and the words', () => {
    const fixture = JSON.parse(read('tests/fixtures/banned-claims.json')) as { signupSources: string[] }
    expect(fixture.signupSources).toEqual(expect.arrayContaining([PAGE, PANEL, FLOW]))
  })
})
