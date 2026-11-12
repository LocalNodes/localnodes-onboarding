// The homepage copy Tom ruled on 2026-11-09 (positioning), with the
// orchestrator's correction of 2026-11-11 to the Guilds and DAOs card (Phase
// 31, connecting an existing DAO, is parked, so the card no longer promises
// it). The wording is final and goes in word for word: this test holds the
// hero subline, the four "Who it's for" cards in their order with their text,
// and the order of "See it in action" with the pop-up village example.
// It reads the component sources, as the claims check does; the built page is
// checked by scripts/check-landing-claims.mjs after every build.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
/** Template text as a reader sees it: tags dropped, whitespace collapsed. */
const visible = (source: string) => source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
/** The { title, body } pairs of a component's list, in source order. */
function entries(source: string): Array<{ title: string, body: string }> {
  const out: Array<{ title: string, body: string }> = []
  const re = /title: '((?:[^'\\]|\\.)*)',(?:\s*icon: '[^']*',)?\s*body: '((?:[^'\\]|\\.)*)'/g
  for (const m of source.matchAll(re)) out.push({ title: m[1]!.replace(/\\'/g, '\''), body: m[2]!.replace(/\\'/g, '\'') })
  // Every entry in the source must have been read: one written with other quotes or another key
  // order would not match the pattern above and must not be skipped without a word.
  const titles = (source.match(/\btitle:/g) ?? []).length
  if (titles !== out.length) throw new Error(`homepage-copy: read ${out.length} of ${titles} entries; an entry does not match the expected { title, icon?, body } shape`)
  return out
}

const SUBLINE = 'Keep in touch, ask an assistant that answers from what your group has written down, decide fairly, and look after a fund together. Your community owns it, not a platform.'

const CARDS = [
  { title: 'Neighborhoods and civic groups', body: 'Neighborhood associations, tenant groups and civic clubs keep their minutes and decisions where anyone can ask "what did we decide about the garden?", run a mutual aid fund, and vote together.' },
  { title: 'Pop-up villages and gatherings', body: 'Pop-up villages, residencies and conferences keep their talks, notes and decisions, a shared fund for projects, and a way to decide, during the gathering and after everyone goes home.' },
  { title: 'Co-ops and land trusts', body: 'Housing, food and worker co-ops, land trusts and watershed groups keep bylaws, minutes, deeds and plans in one searchable place, and run shared money and votes there too.' },
  { title: 'Guilds and DAOs', body: 'Online guilds and DAOs that already make decisions together: a library for your proposals, docs and history, with a shared fund and votes alongside.' }
]

const POP_UP = 'Residents share talks and session notes as they happen, ask the assistant what was decided last week, pool a fund for village projects, and keep all of it (knowledge, money and votes) when the village ends.'

const EXAMPLES = ['A neighborhood association', 'A pop-up village', 'A housing co-op', 'An online guild', 'A land trust', 'A bioregional network']

/** "Fund what matters" after the orchestrator's answer of 2026-11-11: the item that promised the parked connection is gone. */
const FUND_ITEMS = ['See your group fund.', 'Decide together.', 'Rules only your members can change.', 'Credit for the work people do.', 'Fair moderation and a way to settle disputes.', 'Leave whenever you want.', 'No fees for members.']

/** Ruling point 4: no crypto words in this copy, and no birthday or card-payment example until Phase 25.1 ships. */
const BANNED = /crypto|blockchain|token|wallet|on-?chain|web3|smart contract|birthday|card payment|pay by card/i

describe('homepage copy (Tom\'s ruling of 2026-11-09, the orchestrator\'s correction of 2026-11-11)', () => {
  it('the hero keeps its headline and carries the new subline; the page description matches it', () => {
    const hero = visible(read('app/components/HeroSection.vue'))
    expect(hero).toContain('Where your community shares, decides and funds together.')
    expect(hero).toContain(SUBLINE)
    expect(hero).not.toContain('Share posts, events and conversations')
    const page = read('app/pages/index.vue')
    expect(page).toContain(`const description = '${SUBLINE.replace(/'/g, '\\\'')} Launching soon.'`)
  })

  it('"Who it\'s for" has the four cards in order, word for word, between the kept intro and closing line', () => {
    const source = read('app/components/WhoItsFor.vue')
    expect(entries(source)).toEqual(CARDS)
    const text = visible(source)
    expect(text).toContain('Groups that hold something in common and run it together.')
    expect(text).toContain('Any group that shares a purpose is welcome, online or in one place.')
  })

  it('"See it in action" starts with the neighborhood association, then the pop-up village, then the others in their earlier order', () => {
    const list = entries(read('app/components/SocialProof.vue'))
    expect(list.map(e => e.title)).toEqual(EXAMPLES)
    expect(list[1]!.body).toBe(POP_UP)
  })

  it('no card, example or "Fund what matters" item promises to connect accounts or voting a group already uses (Phase 31 is parked)', () => {
    for (const e of [...entries(read('app/components/WhoItsFor.vue')), ...entries(read('app/components/SocialProof.vue')), ...entries(read('app/components/RoadmapSection.vue'))]) {
      expect(`${e.title} ${e.body}`, e.title).not.toMatch(/already (use|have)|existing|nothing redeployed|redeploy/i)
    }
  })

  it('"Fund what matters" lists seven items, without "Bring what you already have" (orchestrator, 2026-11-11)', () => {
    expect(entries(read('app/components/RoadmapSection.vue')).map(e => e.title)).toEqual(FUND_ITEMS)
  })

  it('the new copy has no crypto word and no birthday or card-payment example', () => {
    for (const text of [SUBLINE, POP_UP, ...CARDS.flatMap(c => [c.title, c.body])]) expect(text).not.toMatch(BANNED)
    const hero = visible(read('app/components/HeroSection.vue').replace(/<script[\s\S]*?<\/script>/, ''))
    expect(hero).not.toMatch(BANNED)
    for (const e of [...entries(read('app/components/WhoItsFor.vue')), ...entries(read('app/components/SocialProof.vue'))]) {
      expect(`${e.title} ${e.body}`, e.title).not.toMatch(BANNED)
    }
  })
})
