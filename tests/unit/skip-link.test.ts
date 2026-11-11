// The skip link on the sign-up site (fresh3 23-39; C2 in 23-A11Y-EVIDENCE.md;
// orchestrator rule C, 2026-11-08; 23-UI-SPEC "Skip link").
//
// The default layout is rendered on the server with a stub header (one link),
// a stub footer (one link) and a page slot (one button). The skip link must be
// the first focusable element, before the header, and point at main, which
// takes focus without joining the Tab order. Source checks cover the click
// handler (it focuses main itself, so the address never changes) and the pages
// (none leaves the default layout, so every page gets the link).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import DefaultLayout from '../../app/layouts/default.vue'

const ROOT = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const WORDS = 'Skip to main content'

const AppHeader = defineComponent(() => () => h('header', [h('a', { href: '/' }, 'LocalNodes home')]))
const AppFooter = defineComponent(() => () => h('footer', [h('a', { href: '/terms' }, 'Terms')]))

async function renderLayout(): Promise<string> {
  const Wrapper = defineComponent(() => () => h(DefaultLayout, null, {
    default: () => h('button', { type: 'button' }, 'Page button')
  }))
  const app = createSSRApp(Wrapper)
  app.component('AppHeader', AppHeader)
  app.component('AppFooter', AppFooter)
  return renderToString(app)
}

// An a with href, a button, input, select or textarea, or anything with tabindex 0.
const FOCUSABLE = /<a\b[^>]*\shref=[^>]*>|<(?:button|input|select|textarea)\b[^>]*>|<[a-z][a-z0-9-]*\b[^>]*\stabindex="0"[^>]*>/i

/** Every .vue file under a folder, recursively. */
function vueFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return vueFiles(path)
    return path.endsWith('.vue') ? [path] : []
  })
}

describe('the skip link, server-rendered in the default layout', () => {
  it('is the first focusable element: href #main-content, the words "Skip to main content", once', async () => {
    const html = await renderLayout()
    const first = html.match(FOCUSABLE)
    expect(first, 'the layout renders a focusable element').not.toBeNull()
    expect(first![0]).toMatch(/^<a\b/)
    expect(first![0]).toContain('href="#main-content"')
    const after = html.slice(first!.index! + first![0].length)
    expect(after.slice(0, after.indexOf('</a>')).trim()).toBe(WORDS)
    expect(html.split(WORDS)).toHaveLength(2)
  })

  it('comes before the header', async () => {
    const html = await renderLayout()
    const link = html.indexOf(WORDS)
    expect(link).toBeGreaterThan(-1)
    expect(link).toBeLessThan(html.indexOf('<header'))
  })

  it('main carries id main-content and tabindex -1, so it takes focus but is not a Tab stop', async () => {
    const html = await renderLayout()
    const main = html.match(/<main\b[^>]*>/)
    expect(main).not.toBeNull()
    expect(main![0]).toContain('id="main-content"')
    expect(main![0]).toContain('tabindex="-1"')
    // The page itself still renders inside main.
    expect(html.indexOf('Page button')).toBeGreaterThan(html.indexOf('<main'))
    expect(html.indexOf('Page button')).toBeLessThan(html.indexOf('</main>'))
  })

  it('is hidden until focused, then fixed above the sticky header', async () => {
    const html = await renderLayout()
    const link = html.match(/<a\b[^>]*href="#main-content"[^>]*>/)![0]
    const classes = (link.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/)
    expect(classes).toContain('sr-only')
    expect(classes).toContain('focus:not-sr-only')
    expect(classes).toContain('focus:fixed')
    // The header is z-50 (Nuxt UI's header theme); the focused link sits above it.
    expect(classes.some((c) => /^focus:z-\[\d+\]$/.test(c) && Number(c.match(/\d+/)![0]) > 50)).toBe(true)
  })
})

describe('the skip link, source checks', () => {
  it('the click handler prevents the fragment jump and focuses main through its ref', () => {
    const src = read('app/layouts/default.vue')
    const handler = src.match(/<a\b[^>]*href="#main-content"[^>]*@click="(\w+)"/)?.[1]
    expect(handler, 'the link has a click handler').toBeTruthy()
    const mainRef = src.match(/<main\b[^>]*\sref="(\w+)"/)?.[1]
    expect(mainRef, 'main has a template ref').toBeTruthy()
    const body = src.match(new RegExp(`function ${handler}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
    expect(body).toMatch(/\.preventDefault\(\)/)
    expect(body).toMatch(new RegExp(`${mainRef}\\.value\\??\\.focus\\(`))
  })

  it('no page sets a layout, so every page gets the default layout and its skip link', () => {
    const pages = vueFiles(join(ROOT, 'app/pages'))
    expect(pages.length).toBeGreaterThanOrEqual(7)
    for (const page of pages) {
      expect(readFileSync(page, 'utf8'), page).not.toMatch(/\blayout\s*:/)
    }
    // app.vue renders NuxtLayout with no name, so the default layout is used.
    expect(read('app/app.vue')).toMatch(/<NuxtLayout>/)
  })

  it('the error page has no layout and no header, so it needs no skip link: its own content is the first focusable region', () => {
    // Orchestrator Q4 answer, 2026-11-08.
    const src = read('app/error.vue')
    expect(src).not.toMatch(/<NuxtLayout|<AppHeader|<AppFooter|<UHeader/)
    const template = src.slice(src.indexOf('<template>'), src.indexOf('</template>'))
    const hero = template.indexOf('<UPageHero')
    expect(hero).toBeGreaterThan(-1)
    // Nothing focusable comes before the page's own content.
    expect(template.slice(0, hero)).not.toMatch(/<(?:a|button|input|select|textarea|ULink|UButton|NuxtLink)\b|tabindex="0"/)
  })
})
