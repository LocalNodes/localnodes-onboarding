// Plain words on the home page: phrases that read as jargon, or that suggest
// fees or where the money sits, to someone who does not know a blockchain is
// involved. The ids are opaque rule ids. The phrases below must not come back on the home page: not in the sources it renders,
// not in its demo data, not in the built page. The early-access form keeps its
// stored group-kind values (the form fails closed; renaming a value would turn
// sign-ups and the invite-wave import away); only the visible label changes.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GROUP_KINDS } from '../../app/utils/group-kinds'

const path = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const read = (p: string) => readFileSync(path(p), 'utf8')

export const BANNED_HOME_PHRASES: Array<{ id: string, re: RegExp }> = [
  { id: 'H01', re: /no fees? for members/i },
  { id: 'H01', re: /network fees/i },
  { id: 'H02', re: /shared account/i },
  { id: 'H03', re: /holds? the money/i },
  { id: 'H03', re: /money sits in one person/i },
  { id: 'H04', re: /\bDAOs?\b/ },
  { id: 'H05', re: /own the infrastructure/i },
  // The first pilots run the fund and its payment votes with practice money.
  { id: 'H06', re: /off for the first pilots/i },
  { id: 'H06', re: /planned example: back steps repair/i },
  // Plain words for practice money.
  { id: 'H07', re: /\btestnet\b|\btokens?\b|\bsepolia\b|\bblockchain\b/i }
]

/** Text a reader sees in a Vue template or HTML: scripts, styles and tags dropped. */
function visibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, '\'').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
}
/** The <template> block of a single-file component. */
const template = (sfc: string) => sfc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? ''

function hits(text: string): string[] {
  return BANNED_HOME_PHRASES.filter(b => b.re.test(text)).map(b => `${b.id} ${b.re}`)
}

/** Every string value in a JSON tree. */
function strings(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(strings)
  if (node && typeof node === 'object') return Object.values(node).flatMap(strings)
  return []
}

const HOME_SFCS = [
  'app/pages/index.vue',
  'app/components/HomeHero.vue',
  'app/components/HomeScatter.vue',
  'app/components/HomeDecide.vue',
  'app/components/HomeFund.vue',
  'app/components/HomeYours.vue',
  'app/components/LandingCTA.vue',
  'app/components/EarlyAccessForm.vue',
  'app/components/AppHeader.vue',
  'app/components/AppFooter.vue'
]

describe('plain words on the home page', () => {
  it('the banned list fires on each phrase it names (probe)', () => {
    for (const probe of ['No fees for members.', 'Members never pay network fees', 'Link the group\'s shared account', 'One person holds the money', 'The money sits in one person\'s account.', 'Guilds and DAOs', 'Own the infrastructure.', 'Coming later. Off for the first pilots.', 'Planned example: back steps repair paid to Marlow Carpentry', 'Paid in Sepolia test tokens on a blockchain']) {
      expect(hits(probe), probe).not.toEqual([])
    }
    expect(hits('Online community or working group')).toEqual([])
  })

  it.each(HOME_SFCS)('%s template has none of the banned phrases', (file) => {
    expect(hits(visibleText(template(read(file))))).toEqual([])
  })

  it('the demo data has none of the banned phrases in any string', () => {
    const data = JSON.parse(read('app/data/home-demo.json'))
    for (const s of strings(data)) expect(hits(s), s).toEqual([])
  })

  it('no group-kind label carries a banned phrase', () => {
    for (const k of GROUP_KINDS) expect(hits(k.label), k.label).toEqual([])
  })

  const built = ['.output/public/index.html', '.vercel/output/static/index.html'].find(p => existsSync(path(p)))
  it.skipIf(!built)('the built home page has none of the banned phrases in its visible text', () => {
    expect(hits(visibleText(read(built!)))).toEqual([])
  })
})

describe('early-access group kinds: label changed, stored value kept', () => {
  it('the stored values are exactly the ones the form sent before, in the same order', () => {
    expect(GROUP_KINDS.map(k => k.value)).toEqual(['Co-op', 'Online guild or DAO', 'Land trust', 'Neighborhood or tenant group', 'Mutual aid network', 'User group or meetup', 'Network of groups', 'Something else'])
  })

  it('the online-community option shows the new label and still sends "Online guild or DAO"', () => {
    const k = GROUP_KINDS.find(x => x.label === 'Online community or working group')
    expect(k?.value).toBe('Online guild or DAO')
  })

  it('the form binds the select to the stored value, not the label', () => {
    const src = read('app/components/EarlyAccessForm.vue')
    expect(src).toMatch(/GROUP_KINDS\.map\(k => \(\{ label: k\.label, value: k\.value \}\)\)/)
    // USelect's default value-key is "value"; an override would send something else.
    expect(src).not.toMatch(/value-key|valueKey|label-key|labelKey/)
    expect(src).toMatch(/groupKind: groupKind\.value \?\? ''/)
  })
})
