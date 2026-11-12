// The home page's headline and subline, word for word, and the page description that repeats the
// subline. They are the ruled wording; the built page is also checked by
// scripts/check-landing-claims.mjs after every build.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
/** Template text as a reader sees it: tags dropped, whitespace collapsed. */
const visible = (source: string) => source.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

const HEADLINE = 'Where your community shares, decides and funds together.'
const SUBLINE = 'Keep in touch, ask an assistant that answers from what your group has written down, decide fairly, and look after a fund together. Your community owns it, not a platform.'

/** No crypto words, and no birthday or card-payment example yet. */
const BANNED = /crypto|blockchain|token|wallet|on-?chain|web3|smart contract|birthday|card payment|pay by card/i

describe('homepage headline and subline', () => {
  const hero = visible(read('app/components/HomeHero.vue'))

  it('the hero carries the headline and the subline; the page description matches the subline', () => {
    expect(hero).toContain(HEADLINE)
    expect(hero).toContain(SUBLINE)
    const page = read('app/pages/index.vue')
    expect(page).toContain(`const description = '${SUBLINE.replace(/'/g, '\\\'')} Launching soon.'`)
  })

  it('the hero has no crypto word and no birthday or card-payment example', () => {
    for (const text of [HEADLINE, SUBLINE]) expect(text).not.toMatch(BANNED)
    expect(hero).not.toMatch(BANNED)
  })
})
