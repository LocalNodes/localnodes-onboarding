// The home page. Two kinds of check:
//  - the sources: which sections the page puts in which order, what the header and footer
//    carry, and the things this page must never say or do (fee lines, a second launching-soon
//    statement, a dollar sign glued to a digit in code);
//  - the server-rendered finished states of each section, which is what a reader without
//    scripts, a screen reader and the claims check all see.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSSRApp, defineComponent, h } from 'vue'
import type { Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useHomeDemos, HOME_DEMOS_KEY } from '~/composables/useHomeDemos'
import HomeHero from '~/components/HomeHero.vue'
import HomeScatter from '~/components/HomeScatter.vue'
import HomeDecide from '~/components/HomeDecide.vue'
import HomeFund from '~/components/HomeFund.vue'
import HomeYours from '~/components/HomeYours.vue'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Rendered markup as a reader sees it: tags dropped, entities decoded, whitespace collapsed. */
const seen = (html: string) => flat(html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&'))

async function render(component: Component): Promise<string> {
  const app = createSSRApp(component)
  app.config.warnHandler = () => {}
  app.provide(HOME_DEMOS_KEY, useHomeDemos())
  app.component('UButton', defineComponent({
    props: ['to', 'label', 'size', 'color', 'variant'],
    setup: props => () => h('a', { href: props.to, class: 'ubutton' }, props.label)
  }))
  return renderToString(app)
}

/** The markup inside the first element whose opening tag contains `marker`, found by counting same-name tags. */
function inside(html: string, marker: string): string {
  const at = html.indexOf(marker)
  expect(at, `an element with ${marker}`).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<', at)
  const name = html.slice(open + 1).match(/^[a-z0-9]+/i)![0]
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi')
  tag.lastIndex = open
  let depth = 0
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(open, m.index + m[0].length)
  }
  throw new Error(`no closing </${name}> for ${marker}`)
}

const HOME_COMPONENTS = ['HomeHero', 'HomeScatter', 'HomeDecide', 'HomeFund', 'HomeYours']
const HOME_SOURCES = [...HOME_COMPONENTS.map(n => `app/components/${n}.vue`), 'app/components/LandingCTA.vue', 'app/pages/index.vue', 'app/composables/useHomeDemos.ts']

describe('the page', () => {
  const page = read('app/pages/index.vue')

  it('keeps its title and description lines exactly', () => {
    expect(page).toContain('const title = \'LocalNodes: where your community thinks, decides and funds together\'')
    expect(page).toContain('const description = \'A shared memory with an assistant that knows your group\\\'s history, a shared fund, and a fair way to decide how it\\\'s spent. Your community owns it, not a platform. Launching soon.\'')
  })

  it('is a light page that imports the home stylesheet and sets the home class on <html>', () => {
    expect(page).toContain('definePageMeta({ colorMode: \'light\' })')
    expect(page).toMatch(/import ['"]~\/assets\/css\/home-v5\.css['"]/)
    expect(page).toMatch(/useHead\(\{\s*htmlAttrs: \{ class: 'ln-home' \}/)
  })

  it('provides the one demo controller, mounts it and unmounts it', () => {
    expect(page).toContain('useHomeDemos()')
    expect(page).toContain('provide(HOME_DEMOS_KEY')
    expect(page).toMatch(/onMounted\(\(\) => demos\.mount\(\)\)/)
    expect(page).toMatch(/onBeforeUnmount\(\(\) => demos\.unmount\(\)\)/)
  })

  it('shows hero, six places, decide, fund, yours and the close, in that order, and no old section', () => {
    const order = ['<HomeHero', '<HomeScatter', '<HomeDecide', '<HomeFund', '<HomeYours', '<LandingCTA'].map(t => page.indexOf(t))
    expect(order.every(i => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const old of ['HeroSection', 'ProblemSection', 'WhoItsFor', 'FeaturesSection', 'RoadmapSection', 'SocialProof', 'HowItWorks', 'OpenSourceSection']) {
      expect(page, old).not.toContain(`<${old}`)
    }
  })

  it('is the only file in app/ to name the stylesheet or the html class', () => {
    for (const file of HOME_SOURCES.filter(f => f !== 'app/pages/index.vue')) {
      expect(read(file), file).not.toMatch(/home-v5|ln-home/)
    }
  })
})

describe('header and footer on the home page', () => {
  const header = read('app/components/AppHeader.vue')
  const footer = read('app/components/AppFooter.vue')

  it('puts the three section links in the nav, to the sections that exist', () => {
    expect(header).toMatch(/label: 'How it works', to: '\/#decide'/)
    expect(header).toMatch(/label: 'Open source', to: '\/#yours'/)
    expect(header).toMatch(/label: 'Demo sites', to: '\/#demo'/)
    expect(header).not.toMatch(/who-its-for|see-it-in-action|open-source'/)
  })

  it('is dark on the home page, with the logo left and the nav on the right', () => {
    expect(header).toContain('dark home-dark home-header bg-default border-default')
    expect(header).toMatch(/<template #right>[\s\S]*<UNavigationMenu[^>]*hidden lg:flex/)
    expect(header).toContain('lg:flex-none')
    expect(header).toContain('lg:flex-1 lg:justify-end')
    expect(header).toMatch(/content: 'dark home-dark'/)
  })

  it('keeps the early-access button as it was off the home page', () => {
    expect(header).toContain(`:variant="onLanding ? 'solid' : 'outline'"`)
    expect(header).toContain(`:color="onLanding ? 'primary' : 'neutral'"`)
    expect(header).not.toContain('TODO(22.1-08)')
  })

  it('has a dark footer on the home page only, with its links as they were', () => {
    expect(footer).toContain('home-dark')
    expect(footer).toContain('onLanding')
    expect(footer).toContain('hello@localnodes.xyz')
    expect(footer).toContain('https://github.com/LocalNodes/os-knowledge-garden')
  })
})

describe('words this page must not say, and code it must not hold', () => {
  it('no fee line for members anywhere in the home sources', () => {
    for (const file of HOME_SOURCES) {
      expect(read(file), file).not.toMatch(/Fees paid by members|No fees for members/i)
    }
    expect(read('app/data/home-demo.json')).not.toMatch(/fees paid by members|no fees for members/i)
  })

  it('no dollar sign glued to a digit in a component or the composable (amounts come from the data file)', () => {
    for (const file of HOME_SOURCES) expect(read(file), file).not.toMatch(/\$\d/)
  })

  it('no tab list: the switcher is a group of toggle buttons', () => {
    for (const file of HOME_SOURCES) expect(read(file), file).not.toMatch(/role="tab(list)?"/)
  })

  it('exactly one launching-soon statement, in the hero', () => {
    const count = HOME_SOURCES.map(f => (read(f).match(/data-prelaunch/g) ?? []).length)
    expect(count.reduce((a, b) => a + b, 0)).toBe(1)
    expect((read('app/components/HomeHero.vue').match(/data-prelaunch/g) ?? []).length).toBe(1)
  })

  it('no aria-live inside the animated regions', () => {
    for (const n of HOME_COMPONENTS) expect(read(`app/components/${n}.vue`), n).not.toMatch(/aria-live|role="status"|<output/)
  })
})

describe('the hero as the server renders it', () => {
  it('has the headline, the lines under it, both buttons and the one launching-soon statement', async () => {
    const html = await render(HomeHero)
    const text = seen(html)
    expect(text).toContain('Launching soon. Get early access .')
    expect(text).toContain('Where your community thinks, decides and funds together.')
    expect(text).toContain('A shared memory with an assistant that knows your group\'s history, a shared fund, and a fair way to decide how it\'s spent. Your community owns it, not a platform.')
    expect(html).toMatch(/href="#early-access"[^>]*>Get early access</)
    expect(html).toMatch(/href="#decide"[^>]*>See how it works</)
    expect(text).toContain('Example from a demo library. Every answer shows the page it came from.')
    expect((html.match(/data-prelaunch/g) ?? []).length).toBe(1)
    expect(html).toContain('home-grad')
  })

  it('offers the four examples as toggle buttons, the first pressed, in a labelled group', async () => {
    const html = await render(HomeHero)
    const group = inside(html, 'aria-label="Example community"')
    expect(group).toContain('role="group"')
    expect(seen(group)).toContain('Show me a')
    const buttons = [...group.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)]
    expect(buttons.map(b => b[2])).toEqual(['neighborhood group', 'pop-up village', 'housing co-op', 'guild'])
    expect(buttons.map(b => /aria-pressed="true"/.test(b[1]!))).toEqual([true, false, false, false])
    expect(html).not.toContain('role="tab')
  })

  it('has a real Pause button, kept out of sight until the page is live', async () => {
    const html = await render(HomeHero)
    expect(html).toMatch(/<button[^>]*class="[^"]*home-pause[^"]*home-needs-js[^"]*"[^>]*>Pause<\/button>|<button[^>]*home-needs-js[^>]*>Pause<\/button>/)
  })

  it('shows example 1 finished, and gives a screen reader the same state as text outside the hidden window', async () => {
    const html = await render(HomeHero)
    const alt = inside(html, 'class="home-alt"')
    expect(seen(alt)).toBe('Example for Maple Street Neighbors. Question: What did we decide about the garden? Answer: Four new raised beds along the south fence. The water question goes to the spring meeting. Source: [1] Meeting notes, 12 March. The page says: Agreed: four new raised beds along the south fence. Water access goes to the spring meeting.')
    const window = inside(html, 'class="home-hold" aria-hidden="true"')
    expect(window).not.toContain('home-alt')
    expect(seen(window)).toContain('Read 6 documents')
    expect(window).toMatch(/<aside class="[^"]*\bhome-paper\b[^"]*"/)
    expect(window).toMatch(/<aside class="[^"]*\blit\b[^"]*"/)
    expect(window).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex/)
  })

  it('stacks every example in the same place so a change moves nothing: one visible, the rest hidden', async () => {
    const html = await render(HomeHero)
    const names = inside(html, 'class="home-stk')
    expect((html.match(/is-cur/g) ?? []).length).toBeGreaterThanOrEqual(5)
    expect(names).toContain('Maple Street Neighbors')
    for (const n of ['Juniper Village', 'Willow House', 'Open Docs Guild']) expect(html).toContain(n)
  })
})

describe('the six places', () => {
  it('has the six-places line and the six chips in order', async () => {
    const html = await render(HomeScatter)
    expect(seen(html)).toBe('Right now, what your group knows lives in six places and one person\'s memory. group chat shared drive email threads a paper binder a spreadsheet last year\'s notes')
    expect((html.match(/<li>/g) ?? []).length).toBe(6)
  })
  it('is a dark band, like the hero it follows', async () => {
    const html = await render(HomeScatter)
    expect(html).toMatch(/<section[^>]*class="[^"]*home-scatter home-dark dark/)
  })
})

describe('the decide act as the server renders it', () => {
  it('has the copy, a Play again button and the finished window', async () => {
    const html = await render(HomeDecide)
    const text = seen(html)
    expect(html).toContain('id="decide"')
    expect(text).toContain('Decides')
    expect(text).toContain('Decide in the open, with everyone who has a say.')
    expect(text).toContain('Anyone can put a proposal to the group. Each member agrees, stands aside or blocks, and the result is kept with the count and the date.')
    for (const li of ['One person, one response', 'A clear closing date on every proposal', 'The record stays, so next year\'s members can ask what was decided']) expect(text).toContain(li)
    expect(html).toMatch(/<button[^>]*>Play again<\/button>/)
    const win = inside(html, 'class="home-stage')
    expect(seen(win)).toContain('Willow House')
    expect(seen(win)).toContain('Repair the back steps')
    expect(seen(win)).toContain('Pay for the lowest of three quotes from the repair fund.')
    expect(seen(win)).toContain('Agreed · 11 of 12 responded, no blocks')
    expect(seen(win)).toContain('This records the decision. Paying for it is a separate step, below.')
    expect(win).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex/)
  })

  it('writes the result as a sentence built from the numbers, outside the hidden window', async () => {
    const html = await render(HomeDecide)
    const alt = inside(html, 'class="home-alt"')
    expect(seen(alt)).toBe('Planned example: repair the back steps. Agreed: 9 agree, 2 stand aside, 0 block, 11 of 12 responded.')
  })

  it('draws twelve dots, eleven of them answered', async () => {
    const html = await render(HomeDecide)
    const dots = inside(html, 'class="home-dots"')
    expect((dots.match(/<span/g) ?? []).length).toBe(12)
    expect((dots.match(/class="agree"/g) ?? []).length).toBe(9)
    expect((dots.match(/class="aside"/g) ?? []).length).toBe(2)
  })
})

describe('the fund act as the server renders it', () => {
  it('has the copy and the two list items, nothing about fees', async () => {
    const html = await render(HomeFund)
    const text = seen(html)
    expect(html).toContain('id="fund"')
    expect(text).toContain('Funds')
    expect(text).toContain('A fund the group controls, and can see.')
    expect(text).toContain('The money moves only when the approvers your group chose sign off. Every payment shows who approved it and what it was for.')
    expect(text).toContain('No single person holds the purse')
    expect(text).toContain('Optional: turn the fund on when your group is ready')
    expect(text).not.toMatch(/fees? paid by members|no fees/i)
    expect(html).toMatch(/<button[^>]*>Play again<\/button>/)
  })

  it('writes every amount in a box and from the data file: the balance after, the payment and nothing else', async () => {
    const html = await render(HomeFund)
    const boxes = [...html.matchAll(/<(div|p|dd|td|li)\b[^>]*data-demo-amount-box[^>]*>([\s\S]*?)<\/\1>/g)]
    expect(boxes.length).toBeGreaterThanOrEqual(2)
    for (const b of boxes) {
      expect(b[2]).toMatch(/^<span data-demo-amount="fund\.(balanceBefore|balanceAfter|payment)">\$[\d,]+<\/span>$/)
    }
    const shown = boxes.map(b => seen(b[2]!))
    expect(shown).toContain('$10,600')
    expect(shown).toContain('$1,800')
    // every dollar amount on the rendered section is inside a box
    const outside = html.replace(/<(div|p|dd|td|li)\b[^>]*data-demo-amount-box[^>]*>[\s\S]*?<\/\1>/g, '')
    expect(outside).not.toMatch(/\$\s?\d/)
  })

  it('shows the paid state with the sticky note, and a list of facts for a screen reader outside the window', async () => {
    const html = await render(HomeFund)
    const win = inside(html, 'class="home-hold home-holdnote home-note"')
    const text = seen(win)
    expect(text).toContain('Repair fund balance')
    expect(text).toContain('Back steps repair')
    expect(text).toContain('To Marlow Carpentry, the lowest quote')
    expect(text).toContain('2 of 3 approved')
    expect(text).toContain('Paid')
    expect(text).toContain('Approved by AK and JS, payment sent')
    expect(win).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex/)
    const alt = inside(html, 'class="home-alt"')
    expect(alt.startsWith('<dl')).toBe(true)
    expect(alt).toContain('data-demo-amount-box')
    expect(seen(alt)).not.toMatch(/\b(price|cost|costs|from|only)\b\s*\$|\$[\d,]+\s*(\/|per|each|monthly)/i)
  })
})

describe('the yours act as the server renders it', () => {
  it('has the copy, the finished export window and an alternative outside it', async () => {
    const html = await render(HomeYours)
    const text = seen(html)
    expect(html).toContain('id="yours"')
    expect(text).toContain('Yours')
    expect(text).toContain('It\'s your site. Take it with you.')
    expect(text).toContain('LocalNodes is open source (GPL and AGPL). Run it with us or on your own server. If you ever want to move, one button will give you everything your community has put here.')
    for (const li of ['Your pages, files, members and settings in one download', 'A step-by-step guide to setting it up somewhere else', 'The same software anyone can install for a new community']) expect(text).toContain(li)
    const win = inside(html, 'class="home-stage')
    const w = seen(win)
    expect(w).toContain('Site settings')
    expect(w).toContain('Export this site')
    expect(w).toContain('One download with everything here, and a guide to setting it up somewhere else.')
    expect(w).toContain('willow-house-export.tar.gz')
    expect(w).toContain('Ready')
    expect(win).not.toMatch(/<(button|a|input|select|textarea)\b|tabindex/)
    expect((win.match(/<li class="ok">/g) ?? []).length).toBe(4)
    expect(inside(html, 'class="home-alt"')).toBeTruthy()
  })
})

describe('the close', () => {
  const cta = read('app/components/LandingCTA.vue')

  it('is the dark close with the early-access id, heading and lead', () => {
    expect(cta).toMatch(/<section[^>]*id="early-access"[^>]*home-dark dark|<section[^>]*home-dark dark[^>]*id="early-access"/)
    expect(flat(cta)).toContain('Be one of the first communities in.')
    expect(flat(cta)).toContain('Leave an email address and we\'ll write when sign-up opens. You can also look around a demo site first.')
    expect(cta).toContain('<EarlyAccessForm')
  })

  it('links the Boulder demo, labelled a demo, in a new tab, where the nav\'s Demo sites goes', () => {
    expect(cta).toMatch(/id="demo"[^>]*href="https:\/\/boulder\.localnodes\.xyz"|href="https:\/\/boulder\.localnodes\.xyz"[^>]*id="demo"/)
    expect(flat(cta)).toContain('Look around the Boulder demo site (a demo)')
    expect(cta).toContain('target="_blank"')
    expect(cta).toContain('rel="noopener noreferrer"')
    expect(flat(cta)).toContain('<span class="sr-only"> (opens in a new tab)</span>')
  })

  it('keeps the privacy block, says no launching-soon statement of its own and has no oversize text class', () => {
    expect(cta).toContain('id="privacy"')
    expect(flat(cta)).toContain('a scrambled form of each address')
    const markup = cta.replace(/<script[\s\S]*?<\/script>/, '')
    expect(markup).not.toMatch(/encrypt/i)
    expect(cta).not.toContain('data-prelaunch')
    expect(cta).not.toMatch(/\btext-(3xl|lg|xs|4xl)\b|text-\[(30|36|18|12)px\]/)
  })

  it('passes the dark band to the group-kind list, so its popup is dark too', () => {
    const form = read('app/components/EarlyAccessForm.vue')
    expect(form).toContain('popupClass')
    expect(form).toMatch(/:ui="\{ content: popupClass \}"/)
    expect(cta).toMatch(/popup-class="dark home-dark"/)
  })
})

describe('each window says what the first pilots get', () => {
  const TAGS: Array<[string, Component, string]> = [
    ['hero', HomeHero, 'In the first pilots'],
    ['decide', HomeDecide, 'Coming. Not in the first pilots.'],
    ['fund', HomeFund, 'Coming later. Off for the first pilots.'],
    ['yours', HomeYours, 'Export button coming. The archive works today.']
  ]
  for (const [name, comp, words] of TAGS) {
    it(`${name}: shows "${words}" as visible text, read before the picture and its description`, async () => {
      const html = await render(comp)
      const tag = html.match(/<p class="home-tag"><span class="home-pill">([^<]*)<\/span><\/p>/)
      expect(tag?.[1]).toBe(words)
      const at = html.indexOf('class="home-tag"')
      expect(at).toBeLessThan(html.indexOf('class="home-alt"'))
      expect(at).toBeLessThan(html.indexOf('aria-hidden="true"'))
      // Not hidden from sight or from a screen reader.
      expect(html.slice(html.lastIndexOf('<', at), at + 60)).not.toMatch(/aria-hidden|sr-only|hidden/)
    })
  }

  it('the fund description names its payment as a planned example', async () => {
    const html = await render(HomeFund)
    expect(seen(inside(html, 'class="home-alt"'))).toContain('Planned example: back steps repair paid to Marlow Carpentry, the lowest quote')
  })

  it('the export description names its screen as a planned example', async () => {
    const html = await render(HomeYours)
    expect(seen(inside(html, 'class="home-alt"'))).toMatch(/^Planned example of the export screen for Willow House\./)
  })
})
