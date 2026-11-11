// The site-wide error page: a missing page and every other error each read in
// plain words, and neither shows the status code or the server's message.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { computed, createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { ERROR_COPY, errorCopy } from '~/utils/error-copy'
import ErrorPage from '../../app/error.vue'

const root = resolve(__dirname, '../..')
const g = globalThis as Record<string, unknown>

const stubs: Record<string, Component> = {
  UApp: defineComponent((_, { slots }) => () => h('div', slots.default?.())),
  UPageHero: defineComponent({
    props: ['title', 'description', 'links'],
    setup: p => () => h('section', [
      h('h1', p.title),
      h('p', p.description),
      ...(p.links as Array<{ label: string, to: string }>).map(l => h('a', { href: l.to }, l.label))
    ])
  })
}

async function mount(error: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(ErrorPage, { error })
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  return renderToString(app)
}

const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('the error page words', () => {
  beforeEach(() => {
    g.computed = computed
    g.useHead = () => {}
  })
  afterEach(() => { delete g.computed; delete g.useHead })

  it('a missing page reads "Page Not Found" and says the page was not found', async () => {
    const html = await mount({ statusCode: 404, statusMessage: 'Page not found: /secret/admin' })
    expect(html).toContain('<h1>Page Not Found</h1>')
    expect(textOf(html)).toContain('We couldn\'t find this page.')
  })

  it('any other error reads "Something Went Wrong" with one calm sentence', async () => {
    for (const statusCode of [500, 503, 403, undefined]) {
      const html = await mount({ statusCode, statusMessage: 'Internal error at db.connect' })
      expect(html).toContain('<h1>Something Went Wrong</h1>')
      expect(textOf(html)).toContain('We couldn\'t open this page. Try again, or return to LocalNodes.')
    }
  })

  it('the button says where it goes, and the code and the server message never show', async () => {
    for (const error of [
      { statusCode: 404, statusMessage: 'Page not found: /secret/admin' },
      { statusCode: 500, statusMessage: 'Internal error at db.connect' }
    ]) {
      const html = await mount(error)
      expect(html).toContain(`href="/">${ERROR_COPY.home}</a>`)
      expect(ERROR_COPY.home).toBe('Back to the LocalNodes home page')
      const text = textOf(html)
      expect(text).not.toContain(String(error.statusCode))
      expect(text).not.toContain(error.statusMessage)
      expect(text).not.toContain('Go Home')
    }
  })

  it('errorCopy treats only 404 as a missing page', () => {
    expect(errorCopy(404)).toBe(ERROR_COPY.notFound)
    for (const code of [500, 403, 410, '404', null, undefined]) expect(errorCopy(code)).toBe(ERROR_COPY.other)
  })

  it('the page source never reads the server message', () => {
    const src = readFileSync(join(root, 'app/error.vue'), 'utf8')
    expect(src).not.toMatch(/statusMessage|\.message\b/)
  })
})
