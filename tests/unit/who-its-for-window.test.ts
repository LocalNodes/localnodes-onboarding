// The example window on the "Who it's for" page: one window that changes with the
// kind of community picked in a row of tabs. These tests hold the tab helper to the
// WAI-ARIA tabs keys, check that every kind's window shows its own question, answer,
// cited page and tile, and check that the /for page really renders the window with
// every kind in the data file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import data from '~/data/who-its-for.json'
import WhoItsForWindow from '~/components/WhoItsForWindow.vue'
import WhoItsForKind from '~/components/WhoItsForKind.vue'
import ForPage from '~/pages/for.vue'
import { tabAfterKey } from '~/utils/tab-keys'

interface Tile {
  type: string
  who?: string
  group?: string
  when?: string
  text?: string
  day?: string
  date?: string
  title?: string
  meta?: string
  going?: number
  options?: { label: string, count: number }[]
}

interface Example {
  chip: string
  site: string
  groups: string[]
  docs: string[]
  hit: number
  q: string
  a: string
  source: string
  p: string[]
  tile: Tile
}

const kinds = data.kinds as unknown as { id: string, example: Example }[]

const decode = (s: string) => s.replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const text = (html: string) => decode(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

async function renderWindow(): Promise<string> {
  const app = createSSRApp({
    render: () => h(WhoItsForWindow, { kinds: data.kinds, label: data.exampleWindow.label, note: data.exampleWindow.note })
  })
  app.config.warnHandler = () => {}
  return renderToString(app)
}

/** The HTML of one kind's panel, from its opening tag to the next panel (or the end). */
function panelOf(html: string, id: string): string {
  const start = html.indexOf(`id="kw-panel-${id}"`)
  expect(start, id).toBeGreaterThan(-1)
  const next = html.indexOf('id="kw-panel-', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

describe('tabAfterKey: the keys of a row of tabs', () => {
  it('steps right and left, wrapping at both ends', () => {
    expect(tabAfterKey('ArrowRight', 0, 11)).toBe(1)
    expect(tabAfterKey('ArrowRight', 10, 11)).toBe(0)
    expect(tabAfterKey('ArrowLeft', 5, 11)).toBe(4)
    expect(tabAfterKey('ArrowLeft', 0, 11)).toBe(10)
  })

  it('goes to the first tab on Home and the last on End', () => {
    expect(tabAfterKey('Home', 7, 11)).toBe(0)
    expect(tabAfterKey('End', 2, 11)).toBe(10)
  })

  it('leaves every other key to the page, and does nothing with no tabs', () => {
    for (const key of ['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'a']) expect(tabAfterKey(key, 3, 11), key).toBeNull()
    expect(tabAfterKey('ArrowRight', 0, 0)).toBeNull()
    expect(tabAfterKey('ArrowRight', 0, 1)).toBe(0)
  })
})

describe('the example window', () => {
  it('is a tablist with one tab per kind, in data order, the first selected and the only one in the tab order', async () => {
    const html = await renderWindow()
    expect(html.match(/role="tablist"/g)).toHaveLength(1)
    expect(html).toMatch(/role="tablist" aria-labelledby="kw-label"/)
    expect(html).toMatch(/id="kw-label"[^>]*>\s*Pick a kind of community/)
    const tabs = [...html.matchAll(/<button\b[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)]
    expect(tabs.map(t => t[1]!.trim())).toEqual(kinds.map(k => k.example.chip))
    tabs.forEach((t, i) => {
      const id = kinds[i]!.id
      expect(t[0], id).toContain(`id="kw-tab-${id}"`)
      expect(t[0], id).toContain(`aria-controls="kw-panel-${id}"`)
      expect(t[0], id).toContain(`aria-selected="${i === 0}"`)
      expect(t[0], id).toContain(`tabindex="${i === 0 ? 0 : -1}"`)
    })
  })

  it('has one panel per kind, labelled by its tab, and only the first showing', async () => {
    const html = await renderWindow()
    const panels = [...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/g)].map(m => m[0])
    expect(panels).toHaveLength(kinds.length)
    panels.forEach((p, i) => {
      expect(p).toContain(`id="kw-panel-${kinds[i]!.id}"`)
      expect(p).toContain(`aria-labelledby="kw-tab-${kinds[i]!.id}"`)
      expect(/class="[^"]*\bis-cur\b/.test(p), kinds[i]!.id).toBe(i === 0)
    })
  })

  // One test per kind: its own panel carries its site, question, answer, cited page and tile.
  it.each(kinds.map(k => [k.id, k] as const))('%s: its window shows its question, its cited answer and its tile', async (_id, kind) => {
    const e = kind.example
    const panel = panelOf(await renderWindow(), kind.id)
    const seen = text(panel)
    // The picture (hidden from screen readers) and the sentence read in its place both carry it.
    for (const words of [e.site, e.q, e.a, e.source, e.p.join(''), ...e.groups, ...e.docs]) expect(seen, words).toContain(words)
    expect(panel).toMatch(/class="home-alt"[^>]*>Made-up example\./)
    expect(panel).toMatch(/class="home-stage kw-stage"[^>]*aria-hidden="true"/)
    expect(text(panel.match(/<p class="home-q"[^>]*>[\s\S]*?<\/p>/)![0])).toBe(e.q)
    expect(text(panel.match(/<p class="home-ans-p"[^>]*>[\s\S]*?<\/p>/)![0])).toBe(e.a)
    expect(text(panel.match(/<span class="home-cite kw-cite"[^>]*>[\s\S]*?<\/span>/)![0])).toBe(`[1] ${e.source}`)
    expect(text(panel.match(/<mark[^>]*>[\s\S]*?<\/mark>/)![0])).toBe(e.p[1])
    const t = e.tile
    if (t.type === 'event') {
      expect(seen).toContain('Coming up')
      expect(seen).toContain(`${t.title} ${t.meta} · ${t.going} going`)
      expect(panel).toMatch(new RegExp(`<small[^>]*>${t.day}</small>${t.date}<`))
    } else if (t.type === 'question') {
      expect(seen).toContain(`${t.who} asked a quick question in ${t.group}`)
      expect(seen).toContain(t.text!)
      for (const o of t.options!) expect(seen).toContain(`${o.label} ${o.count}`)
      expect(seen).toContain(`${t.options!.reduce((n, o) => n + o.count, 0)} answers`)
    } else {
      expect(t.type).toBe('post')
      expect(seen).toContain(`${t.who} posted in ${t.group} ${t.when}`)
      expect(seen).toContain(t.text!)
    }
    // Nothing from another kind's window leaks into this one.
    for (const other of kinds) if (other.id !== kind.id) expect(seen, other.id).not.toContain(other.example.q)
  })

  it('gives every kind a different made-up site, question and tile kind out of event, quick question or post', () => {
    expect(new Set(kinds.map(k => k.example.site)).size).toBe(kinds.length)
    expect(new Set(kinds.map(k => k.example.q)).size).toBe(kinds.length)
    for (const k of kinds) {
      expect(['event', 'question', 'post'], k.id).toContain(k.example.tile.type)
      expect(k.example.p, k.id).toHaveLength(3)
      expect(k.example.hit, k.id).toBeLessThan(k.example.docs.length)
    }
  })
})

describe('the /for page renders the window', () => {
  const g = globalThis as Record<string, unknown>
  beforeEach(() => {
    g.definePageMeta = vi.fn()
    g.useHead = vi.fn()
    g.useSeoMeta = vi.fn()
  })
  afterEach(() => { for (const k of ['definePageMeta', 'useHead', 'useSeoMeta']) delete g[k] })

  async function renderPage(): Promise<string> {
    const app = createSSRApp(ForPage)
    app.config.warnHandler = () => {}
    const UButton = defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) })
    const components: Record<string, Component> = { WhoItsForWindow, WhoItsForKind, UButton }
    for (const [name, c] of Object.entries(components)) app.component(name, c)
    return renderToString(app)
  }

  it('shows the window above the kinds, with a tab and a panel for every kind, and the h1 beside the tabs', async () => {
    const html = await renderPage()
    expect(html.match(/role="tablist"/g)).toHaveLength(1)
    for (const k of kinds) {
      expect(html, k.id).toContain(`id="kw-tab-${k.id}"`)
      expect(html, k.id).toContain(`id="kw-panel-${k.id}"`)
      expect(text(html), k.id).toContain(k.example.q)
    }
    expect(html.match(/role="tab"/g)).toHaveLength(kinds.length)
    expect(html.match(/role="tabpanel"/g)).toHaveLength(kinds.length)
    // The h1 sits in the window's words column, and the window comes before the first kind's section.
    expect(html.indexOf('<h1')).toBeGreaterThan(html.indexOf('class="kw-words"'))
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf(`<section id="${kinds[0]!.id}"`))
    expect(html.match(/<section\b/g)).toHaveLength(kinds.length)
  })
})
