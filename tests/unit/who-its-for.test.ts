// The "Who it's for" page and the home-page row read their words from one data
// file. These tests hold the file to the page's limits, so new words can be
// swapped in without touching a template, and a bad file fails here, never on
// the page.
import { describe, it, expect } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import data from '~/data/who-its-for.json'
import WhoItsForKind from '~/components/WhoItsForKind.vue'
import HomeKinds from '~/components/HomeKinds.vue'
import { gateDecision } from '../../shared/launch'
import { claimsOn, missingClaims } from '../../shared/launch-claims.mjs'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

interface Kind {
  id: string
  heading: string
  who: string
  shape: string
  firstWeek: string[]
  demo: { name: string, url: string } | null
}

const kinds = data.kinds as Kind[]

const ORDER = [
  'housing-co-ops',
  'markets',
  'neighborhood-associations',
  'makerspaces',
  'gatherings-and-conferences',
  'tenant-unions',
  'community-gardens',
  'clubs-and-leagues',
  'arts-collectives',
  'parent-teacher-groups',
  'tool-libraries-and-mutual-aid'
]

/** Sentences in a string: split after . ? or ! followed by a space. */
const sentences = (s: string) => s.trim().split(/(?<=[.?!])\s+/).filter(Boolean)

describe('who-its-for.json', () => {
  it('lists exactly the eleven kinds, in page order', () => {
    expect(kinds.map(k => k.id)).toEqual(ORDER)
  })

  it('has ids of lower-case letters and hyphens, at most 40 characters, all different', () => {
    for (const k of kinds) {
      expect(k.id, k.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      expect(k.id.length, k.id).toBeLessThanOrEqual(40)
    }
    expect(new Set(kinds.map(k => k.id)).size).toBe(kinds.length)
  })

  it('has headings of at most 64 characters, sentence case, with no full stop', () => {
    for (const k of kinds) {
      expect(k.heading.length, k.heading).toBeLessThanOrEqual(64)
      expect(k.heading, k.heading).not.toMatch(/\.$/)
      expect(k.heading[0], k.heading).toBe(k.heading[0]!.toUpperCase())
      // Sentence case: no later word starts with a capital.
      for (const word of k.heading.split(/\s+/).slice(1)) {
        expect(word[0], `${k.heading}: ${word}`).toBe(word[0]!.toLowerCase())
      }
    }
  })

  it('keeps each line inside its limit', () => {
    for (const k of kinds) {
      expect(sentences(k.who), k.who).toHaveLength(1)
      expect(k.who.length, k.who).toBeLessThanOrEqual(110)
      expect(sentences(k.shape), k.shape).toHaveLength(1)
      expect(k.shape.length, k.shape).toBeLessThanOrEqual(100)
      expect(k.firstWeek, k.id).toHaveLength(2)
      for (const line of k.firstWeek) {
        expect(line.length, line).toBeLessThanOrEqual(150)
        expect(sentences(line).length, line).toBeLessThanOrEqual(2)
        expect(line, line).not.toMatch(/^first week/i)
      }
    }
  })

  it('keeps the intro and the closing short, and the closing welcomes a single group', () => {
    expect(data.intro.length).toBeLessThanOrEqual(220)
    expect(sentences(data.intro).length).toBeLessThanOrEqual(2)
    expect(data.closing.length).toBeLessThanOrEqual(140)
    expect(sentences(data.closing).length).toBeLessThanOrEqual(2)
    expect(data.closing).toMatch(/single group/i)
  })

  it('names unconferences among the gatherings, which carry the two gathering promises', () => {
    const g = kinds.find(k => k.id === 'gatherings-and-conferences')!
    expect(g.heading).toMatch(/\bunconferences\b/)
    expect(g.who).toMatch(/\ba gathering or unconference\b/)
    expect(g.firstWeek.join(' ')).toContain('Decide the program together, with every organizer who has a say.')
    expect(g.firstWeek.join(' ')).toContain('Pay session grants from the group fund.')
  })

  it('keeps the gathering-only parts that are not built off the page: proposing a session, a schedule that builds itself, a code at the door', () => {
    const all = JSON.stringify(data)
    expect(all).not.toMatch(/\bpropos\w*\s+(?:a\s+)?sessions?\b/i)
    expect(all).not.toMatch(/\bbuilds?\s+itself\b/i)
    expect(all).not.toMatch(/\bcodes?\s+at\s+the\s+door\b|\bcheck-?in\s+codes?\b/i)
  })

  it('sets a demo only as an empty address or a localnodes.xyz demo site with a name', () => {
    for (const k of kinds) {
      if (k.demo === null) continue
      expect(Object.keys(k.demo).sort(), k.id).toEqual(['name', 'url'])
      expect(k.demo.name.trim(), k.id).not.toBe('')
      if (k.demo.url === '') continue
      const u = new URL(k.demo.url)
      expect(u.protocol, k.id).toBe('https:')
      expect(u.hostname, k.id).toMatch(/^[a-z0-9-]+\.localnodes\.xyz$/)
    }
  })

  it('has a home row whose examples each name a kind on the page', () => {
    expect(data.homeRow.lead).toBe('Built for groups like')
    expect(data.homeRow.examples.length).toBeGreaterThan(0)
    for (const ex of data.homeRow.examples) {
      expect(kinds.some(k => k.heading.toLowerCase().includes(ex.toLowerCase())), ex).toBe(true)
    }
    expect(data.homeRow.linkText.trim()).not.toBe('')
  })
})

const NuxtLink = defineComponent({
  props: ['to'],
  setup: (p, { attrs, slots }) => () => h('a', { ...attrs, href: p.to }, slots.default?.())
})

async function render(component: Component, props: Record<string, unknown> = {}) {
  const app = createSSRApp({ render: () => h(component, props) })
  app.config.warnHandler = () => {}
  app.component('NuxtLink', NuxtLink)
  return renderToString(app)
}

const text = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ').trim()

describe('a kind section', () => {
  const kind = kinds[0]!

  it('is a section with the kind id, an h2, the who line, a two-row description list and two first-week items', async () => {
    const html = await render(WhoItsForKind, { kind })
    expect(html).toMatch(new RegExp(`<section[^>]*id="${kind.id}"`))
    expect(html).toMatch(/class="[^"]*scroll-mt-20/)
    expect(html.match(/<h2\b/g)).toHaveLength(1)
    expect(html).toContain(kind.heading)
    expect(html.match(/<dt\b/g)).toHaveLength(2)
    expect(text(html)).toContain('How it\'s set up')
    expect(text(html)).toContain('In the first week')
    expect(html.match(/<li\b/g)).toHaveLength(2)
    for (const line of [kind.who, kind.shape, ...kind.firstWeek]) expect(text(html)).toContain(line)
    expect(html).not.toMatch(/<h3\b/)
  })

  it('shows no link at all for an empty demo address or no demo', async () => {
    for (const demo of [{ name: 'housing co-op', url: '' }, null]) {
      const html = await render(WhoItsForKind, { kind: { ...kind, demo } })
      expect(html).not.toMatch(/<a\b/)
      expect(text(html)).not.toMatch(/demo|coming/i)
    }
  })

  it('shows one labelled demo link that opens a new tab when an address is set', async () => {
    const html = await render(WhoItsForKind, { kind: { ...kind, demo: { name: 'housing co-op', url: 'https://coop.localnodes.xyz' } } })
    expect(html.match(/<a\b/g)).toHaveLength(1)
    expect(html).toMatch(/<a[^>]*href="https:\/\/coop\.localnodes\.xyz"/)
    expect(html).toMatch(/target="_blank"/)
    expect(html).toMatch(/rel="noopener noreferrer"/)
    expect(text(html)).toContain('Look around the housing co-op demo site (a demo) (opens in a new tab)')
    expect(html).toContain('<span class="sr-only"> (opens in a new tab)</span>')
  })
})

describe('the /for page', () => {
  const page = read('app/pages/for.vue')
  const config = read('nuxt.config.ts')

  it('is titled "Who it\'s for" in sentence case, in the h1, the title and the share title', () => {
    expect(page).toMatch(/<h1\b[^>]*>\s*Who it's for\s*<\/h1>/)
    expect(page).toContain('const title = \'Who it\\\'s for - LocalNodes\'')
    expect(page).toMatch(/ogTitle: title/)
    expect(page).not.toMatch(/Who It's [Ff]or/)
  })

  it('reads as a page of the landing: its band and container, its section-heading size, not its margin reset', () => {
    expect(page).toMatch(/<div class="home-band-light[^"]*">\s*<div class="home-wrap/)
    expect(page).toMatch(/<h1 class="home-h2\b/)
    // .home-page zeroes margins and list bullets for the landing's own layout.
    expect(page).not.toMatch(/class="[^"]*\bhome-page\b/)
  })

  it('is a light page that renders every kind from the data file', () => {
    expect(page).toContain('definePageMeta({ colorMode: \'light\' })')
    expect(page).toMatch(/import data from '~\/data\/who-its-for\.json'/)
    expect(page).toMatch(/<WhoItsForKind\s+v-for="kind in data\.kinds"/)
  })

  it('ends with the pre-launch line and one early-access button', () => {
    expect(page).toMatch(/<p\b[^>]*data-prelaunch[^>]*>\s*Launching soon\.\s*<\/p>/)
    expect(page.match(/<UButton\b/g)).toHaveLength(1)
    expect(page).toMatch(/<UButton\b[^>]*to="\/#early-access"/)
  })

  it('renders every one of its promises in the launch claims list word for word', async () => {
    const page = text((await Promise.all(kinds.map(kind => render(WhoItsForKind, { kind })))).join(' '))
    expect(claimsOn('/for').length).toBeGreaterThan(0)
    expect(missingClaims(page, claimsOn('/for')).map(c => c.id)).toEqual([])
  })

  it('is prerendered and never gated', () => {
    expect(config).toMatch(/'\/for': \{ prerender: true \}/)
    expect(gateDecision('/for', false)).toBe('pass')
  })
})

describe('the home row', () => {
  it('reads "Built for groups like" and the examples from the data file, then links to /for', async () => {
    const html = await render(HomeKinds)
    expect(text(html)).toContain('Built for groups like co-ops, markets and gatherings.')
    expect(html.match(/<a\b/g)).toHaveLength(1)
    expect(html).toMatch(/<a[^>]*href="\/for"[^>]*>\s*Find your group\s*<\/a>/)
    expect(html).not.toMatch(/<h[1-6]\b|<section\b/)
  })

  it('is the last strip on the home page, after the dark close', () => {
    const page = read('app/pages/index.vue')
    const at = ['<LandingCTA', '<HomeKinds', '</div>\n</template>'].map(t => page.indexOf(t))
    expect(at.every(i => i > -1)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})
