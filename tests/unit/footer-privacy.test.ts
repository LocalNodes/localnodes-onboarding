// The sign-up site's footer and the landing page's Privacy section
// (fresh3 23-28 Task 3; rulings T-1, T-5 and TA-2 in 23-RULINGS-1108.md).
//
// Read from source, the way tokens.test.ts does: nothing in tests/ mounts a
// component (no jsdom, no @vue/test-utils, and a new package is not allowed),
// so the footer's nav is parsed out of AppFooter.vue and the privacy text is
// read out of LandingCTA.vue.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

/** Collapse whitespace and the common entities, so a line wrap in the template doesn't matter. */
const flat = (s: string) => s
  .replace(/&nbsp;/g, ' ')
  .replace(/&#39;|&apos;/g, '\'')
  .replace(/\s+/g, ' ')
  .trim()

interface NavItem { tag: string, target: string, attrs: string, text: string, html: string }

/** The links inside the footer's <nav>, in order: tag, href or to, attributes, visible-plus-hidden text. */
function footerNav(): NavItem[] {
  const src = read('app/components/AppFooter.vue')
  const nav = src.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/)
  expect(nav, 'a <nav> in AppFooter.vue').not.toBeNull()
  const items: NavItem[] = []
  for (const m of nav![1]!.matchAll(/<(a|NuxtLink)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const attrs = m[2]!
    const target = (attrs.match(/\b(?:href|to)="([^"]*)"/) ?? [])[1] ?? ''
    items.push({ tag: m[1]!, target, attrs, text: flat(m[3]!.replace(/<[^>]+>/g, '')), html: m[3]! })
  }
  return items
}

const byText = (items: NavItem[], text: string) => items.find(i => i.text.startsWith(text))

describe('sign-up footer: "Open source" (T-5)', () => {
  it('has a link with the text "Open source" to the public repository', () => {
    const link = byText(footerNav(), 'Open source')
    expect(link, 'an "Open source" link').toBeDefined()
    expect(link!.tag).toBe('a')
    expect(link!.target).toBe('https://github.com/LocalNodes/os-knowledge-garden')
  })

  it('opens in a new tab, with the hidden words " (opens in a new tab)" and a safe rel', () => {
    const link = byText(footerNav(), 'Open source')!
    expect(link.attrs).toMatch(/target="_blank"/)
    expect(link.attrs).toMatch(/rel="noopener noreferrer"/)
    expect(link.html).toMatch(/<span class="sr-only"> \(opens in a new tab\)<\/span>/)
    expect(link.text).toBe('Open source (opens in a new tab)')
  })

  it('has no "Code on GitHub" link and no link to the organization page alone', () => {
    const src = read('app/components/AppFooter.vue')
    expect(src).not.toContain('Code on GitHub')
    for (const item of footerNav()) {
      expect(item.target.replace(/\/+$/, '')).not.toBe('https://github.com/LocalNodes')
    }
  })

  it('links to the repository exactly once in the footer', () => {
    expect(footerNav().filter(i => i.target.includes('github.com'))).toHaveLength(1)
  })
})

describe('sign-up footer: "Get help" (T-1, SC 3.2.6 help in the same place on every screen)', () => {
  it('has a link "Get help" to mailto:hello@localnodes.xyz', () => {
    const link = byText(footerNav(), 'Get help')
    expect(link, 'a "Get help" link').toBeDefined()
    expect(link!.target).toBe('mailto:hello@localnodes.xyz')
    expect(link!.text).toBe('Get help')
  })

  it('sits right after "Privacy" and before "Get early access"', () => {
    const texts = footerNav().map(i => i.text)
    const privacy = texts.indexOf('Privacy')
    expect(privacy).toBeGreaterThanOrEqual(0)
    expect(texts[privacy + 1]).toBe('Get help')
    expect(texts.indexOf('Get early access')).toBeGreaterThan(privacy + 1)
  })

  it('looks like the other footer links (same classes)', () => {
    const items = footerNav()
    const privacy = items.find(i => i.text === 'Privacy')!
    const help = items.find(i => i.text === 'Get help')!
    const classOf = (i: NavItem) => (i.attrs.match(/class="([^"]*)"/) ?? [])[1]
    expect(classOf(help)).toBeDefined()
    expect(classOf(help)).toBe(classOf(privacy))
  })

  it('the layout every sign-up page uses carries this footer', () => {
    expect(read('app/layouts/default.vue')).toContain('<AppFooter')
  })

  it('has no "Open source" or help link in the mail copy: mail footers get neither link (T-5)', () => {
    const mail = read('server/utils/mail-copy.ts')
    expect(mail).not.toContain('github.com')
  })
})

describe('landing Privacy section says what the sign-in and sign-up code keeps, word for word', () => {
  // The link and sign-in times must match TOKEN_TTL_SECONDS and SESSION_TTL_SECONDS in server/utils/invites.ts (checked below).
  const TA2 = 'When you ask for a sign-in link, we keep your email on Upstash so the link only works for you: the link lasts 15 minutes, and once you sign in, you stay signed in for two hours. Our invite list keeps only a scrambled form of each address. If you set up a site, its setup and payment records are kept separately, with us and with Stripe. Stripe handles your card details at checkout; LocalNodes never sees or stores them.'

  it('names the same link and sign-in times as the code', async () => {
    const { TOKEN_TTL_SECONDS, SESSION_TTL_SECONDS } = await import('../../server/utils/invites')
    expect(TOKEN_TTL_SECONDS).toBe(15 * 60)
    expect(SESSION_TTL_SECONDS).toBe(2 * 60 * 60)
    expect(TA2).toContain('the link lasts 15 minutes')
    expect(TA2).toContain('you stay signed in for two hours')
  })

  const privacy = () => {
    const src = flat(read('app/components/LandingCTA.vue'))
    const start = src.indexOf('id="privacy"')
    expect(start, 'the #privacy section').toBeGreaterThan(-1)
    return src.slice(start)
  }

  it('contains the sentence exactly, inside the #privacy section', () => {
    expect(privacy()).toContain(TA2)
  })

  it('puts it in the "Where:" item, after the existing sentence about Resend', () => {
    const where = privacy().slice(privacy().indexOf('Where:'))
    const resend = where.indexOf('the email service we use to send launch news.')
    expect(resend).toBeGreaterThan(-1)
    expect(where.indexOf(TA2)).toBeGreaterThan(resend)
    // Still in the same list item, before the next one.
    expect(where.indexOf(TA2)).toBeLessThan(where.indexOf('Spam protection:'))
  })

  it('says "scrambled form", not "encrypted": the invite list is a keyed hash', () => {
    expect(privacy()).toContain('a scrambled form of each address')
    expect(privacy()).not.toMatch(/encrypt/i)
  })

  it('the file no longer calls the privacy wording a draft awaiting approval', () => {
    expect(read('app/components/LandingCTA.vue')).not.toMatch(/draft for Tom/i)
  })
})
