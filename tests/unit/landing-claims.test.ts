// Landing-page claims guard (fresh3 22.1-04, D-16).
// Proves the check fires: a planted banned claim, a missing licence and a
// GPL-only licence line each make the script exit 1; a clean page exits 0.
// The coverage case uses probes hard-coded here (the earlier page's words, as
// D-16 names them), not read from LANDING.md or the fixture, so it isn't
// circular.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error plain .mjs script, no type declarations
import { findBannedHits } from '../../scripts/check-landing-claims.mjs'

const repo = resolve(__dirname, '../..')
const script = join(repo, 'scripts/check-landing-claims.mjs')
const fixture = JSON.parse(readFileSync(join(repo, 'tests/fixtures/banned-claims.json'), 'utf8'))

interface Feature { title: string, status: 'today' | 'coming', badge?: string }
const features: Feature[] = fixture.features.items

// One list item per inventory feature, each with its expected badge, so the
// clean page always matches the fixture (LANDING.md section 5).
// The real page repeats a title earlier ("Fund what matters. Decide together.
// Own the infrastructure." heads the band that lists "Decide together."), so
// the heading goes before the list here to pin that case.
const featureList = '<h2>Fund what matters. Decide together. Own the infrastructure.</h2>' + features
  .map(f => `<li><span>${f.title}</span> <span>Some words about it.</span>${f.status === 'coming' ? ` <span class="chip" data-badge>${f.badge}</span>` : ''}</li>`)
  .join('\n')

const CLEAN_BODY = `
  <h1>LocalNodes: your community's library, treasury and decisions, run by its members.</h1>
  <ul>${featureList}</ul>
  <a href="https://cascadia.localnodes.xyz">Cascadia (demo)</a>
  <a href="/onboarding">Set up your community's site</a>
`

function page(body: string, licence = '<p>LocalNodes is open source (GPL and AGPL).</p>') {
  return `<!DOCTYPE html><html><head><title>LocalNodes</title>
<meta name="description" content="A library your members can search and ask.">
<style>.w{width:100%}</style></head>
<body><div class="w-[90%]" style="width:100%">${body}${licence}</div></body></html>`
}

let root: string

const STAMP = '.claims-build-start'

/** Write the page at `at` (default the node-server output) and run the CLI. */
function run(html: string, opts: { at?: string, stamp?: boolean, stale?: boolean } = {}) {
  const at = opts.at ?? '.output/public/index.html'
  if (opts.stamp) writeFileSync(join(root, STAMP), String(Date.now()))
  mkdirSync(join(root, dirname(at)), { recursive: true })
  writeFileSync(join(root, at), html)
  if (opts.stale) {
    const old = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(join(root, at), old, old)
  }
  return runCli()
}

function runCli() {
  const r = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'landing-claims-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('check-landing-claims guard fires', () => {
  it('passes a clean page that says "open source (GPL and AGPL)"', () => {
    const r = run(page(CLEAN_BODY))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('exits 1 naming a planted banned claim', () => {
    const r = run(page(CLEAN_BODY + '<p>Trusted by 127 Communities worldwide.</p>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*127 Communities/m)
    expect(r.out).toContain('RESULT: FAIL')
  })

  it('exits 1 on a banned claim in the meta description', () => {
    const r = run(page(CLEAN_BODY).replace('A library your members', 'Only $29/month. A library your members'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*meta/m)
  })

  it('exits 1 when the licence is missing', () => {
    const r = run(page(CLEAN_BODY, ''))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/licence missing/)
  })

  it('exits 1 on a GPL-only licence line with no AGPL anywhere', () => {
    const r = run(page(CLEAN_BODY, '<p>Licensed under the GPL.</p>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/GPL without AGPL/)
  })

  it('exits 1 on a demo-site link that does not say demo', () => {
    const r = run(page(CLEAN_BODY + '<a href="https://boulder.localnodes.xyz">Visit Boulder</a>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/demo link not labelled/)
  })

  it('exits 1 on the frame word', () => {
    const r = run(page(CLEAN_BODY + '<p>Join the Network Nations.</p>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Network Nations/)
  })

  it('exits 1 when a coming feature is relabelled as available', () => {
    const r = run(page(CLEAN_BODY.replace('Decide together.</span> <span>Some words about it.</span> <span class="chip" data-badge>Coming</span>', 'Decide together.</span> <span>Some words about it.</span> <span class="chip" data-badge>Available now</span>')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Decide together\..*expected the badge "Coming", found "Available now"/m)
  })

  it('exits 1 when a coming feature loses its badge', () => {
    const r = run(page(CLEAN_BODY.replace('Bring in many files at once.</span> <span>Some words about it.</span> <span class="chip" data-badge>Coming</span>', 'Bring in many files at once.</span> <span>Some words about it.</span>')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Bring in many files at once\..*no badge/m)
  })

  it('exits 1 when a today feature gains a Coming badge', () => {
    const r = run(page(CLEAN_BODY.replace('Search that finds what you mean.</span> <span>Some words about it.</span>', 'Search that finds what you mean.</span> <span>Some words about it.</span> <span data-badge>Coming</span>')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Search that finds what you mean\..*badge "Coming"/m)
  })

  it('does not police wording: prose mentioning "coming" or "rung" next to a today feature passes', () => {
    const r = run(page(CLEAN_BODY.replace('Search that finds what you mean.</span> <span>Some words about it.</span>', 'Search that finds what you mean.</span> <span>Coming up: more filters, in the next rung. Shared funds are on the way.</span>')))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('exits 1 when an inventory feature is missing from the page', () => {
    const r = run(page(CLEAN_BODY.replace('Leave whenever you want.', 'Take it with you.')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Leave whenever you want\..*missing/m)
  })

  it('exits 2 when the built page is missing', () => {
    const r = runCli()
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/run npm run build first/)
  })

  it('checks the Vercel preset output (.vercel/output/static)', () => {
    const clean = run(page(CLEAN_BODY), { at: '.vercel/output/static/index.html', stamp: true })
    expect(clean.out).toContain('RESULT: PASS')
    expect(clean.code).toBe(0)
    const dirty = run(page(CLEAN_BODY + '<p>127 Communities</p>'), { at: '.vercel/output/static/index.html', stamp: true })
    expect(dirty.code).toBe(1)
    expect(dirty.out).toMatch(/^FAIL \.vercel\/output\/static\/index\.html: 127 Communities/m)
  })

  it('exits 2 when the only built page is older than this build (stale)', () => {
    const r = run(page(CLEAN_BODY), { stamp: true, stale: true })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/not written during this build/)
  })

  it('checks the fresh output, not a stale one from another preset', () => {
    // A stale node-server page with a banned claim, and a fresh Vercel page.
    run(page(CLEAN_BODY + '<p>127 Communities</p>'), { stale: true })
    const r = run(page(CLEAN_BODY), { at: '.vercel/output/static/index.html', stamp: true })
    expect(r.out).not.toMatch(/127 Communities/)
    expect(r.code).toBe(0)
  })

  it('ignores CSS percentages in classes, styles and <style> blocks', () => {
    const r = run(page(CLEAN_BODY + '<div class="w-[100%]" style="height:90%"></div>'))
    expect(r.code).toBe(0)
  })
})

describe('banned-claims.json covers every item D-16 names', () => {
  // The earlier page's words, hard-coded (D-16).
  const probes = [
    'Climate Tech Collective',
    'Neighborhood Housing Trust',
    'Open Source Maintainers Guild',
    'Disaster Response Network',
    'Urban Farm Collective - Oakland',
    'Design Justice Node - Boston',
    'Watershed DAO - Colorado',
    'Solar Cooperative - Puerto Rico',
    'Permaculture Guild - Vermont',
    'Mutual Aid Network - Detroit',
    'Seed Library - Portland',
    'Food Forest Collective - Austin',
    'Regenerative Ranch - Montana',
    'Community Land Trust - Atlanta',
    '127 Communities',
    '$3.2M',
    '$1.2M',
    '$2M',
    '8,400 Decisions Made Collectively',
    '423 Projects Funded',
    '90% of community value lost to platforms',
    '100% community-owned infrastructure',
    '+423%',
    'Security audited',
    'IPFS',
    'Local LLMs',
    'Open source under MIT License.',
    '$29/month'
  ]

  it.each(probes)('"%s" hits at least one entry', (probe) => {
    expect(findBannedHits(probe, fixture.banned).length).toBeGreaterThan(0)
  })

  // Every kept ban still fires (D-16 as revised, Tom 2026-11-06): each row in
  // the fixture is hit by at least one of these hard-coded probes.
  const rowProbes = [
    ...probes,
    '$3.2M Under Community Control',
    '€5 a seat',
    '29 / mo',
    '290/yr',
    '29 per month',
    '290 per year',
    '29 USD',
    '29 EUR',
    'Not GoFundMe taking 8% of every gift',
    'Built for groups of 10 or 10,000.',
    'Draft a proposal in 60 seconds',
    'Trusted by Communities That Build',
    'Communities Already Building'
  ]

  it.each(fixture.banned.map((r: { pattern: string }) => [r.pattern, r]))('ban %s still fires on a probe', (_p, row) => {
    expect(rowProbes.some(probe => findBannedHits(probe, [row]).length > 0)).toBe(true)
  })

  const nearMisses = [
    'Submit',
    'emit',
    'commitment',
    'a community land trust',
    'an online guild or DAO',
    'a housing co-op',
    'open source (GPL and AGPL)',
    // Not honesty bans since D-16 as revised (Tom, 2026-11-06); these are in
    // the separate voice and product rules list (tested below).
    'a passed proposal can execute automatically',
    'Immutable, censorship-resistant records',
    'Find groups near you'
  ]

  it.each(nearMisses)('near miss "%s" hits nothing', (word) => {
    expect(findBannedHits(word, fixture.banned)).toEqual([])
  })
})

describe('voice and product rules (a separate list from the honesty bans)', () => {
  const rules = fixture.voiceRules.rules as { pattern: string, rule: string }[]

  // Hard-coded probes, one or more per rule list entry.
  const probes: [string, string][] = [
    ['PLACE-01', 'Find groups near you'],
    ['PLACE-01', 'Meet the people near me'],
    ['PLACE-01', 'Everything happening in your town'],
    ['PLACE-01', 'Groups in your area'],
    ['PLACE-01', 'Built for local residents'],
    ['AI-advisory', 'Passed proposals execute automatically'],
    ['AI-advisory', 'The treasury executes automatically'],
    ['AI-advisory', 'Payments automatically execute once approved'],
    ['AI-advisory', 'Proposals auto-execute'],
    ['AI-advisory', 'with autoexecution'],
    ['Voice', 'A censorship-resistant record'],
    ['Voice', 'Immutable history'],
    ['Voice', 'An unstoppable community'],
    ['Voice', 'A revolutionary platform'],
    ['Voice', 'Seamlessly connected'],
    ['Voice', 'An AI-powered library'],
    ['Voice', 'We empower communities']
  ]

  it.each(probes)('%s fires on "%s" and the output names the list', (rule, probe) => {
    const hits = findBannedHits(probe, rules)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h: { rule: string }) => h.rule === rule)).toBe(true)
    expect(findBannedHits(probe, fixture.banned)).toEqual([])
  })

  it.each(rules.map(r => [r.pattern, r]))('rule %s fires on a probe', (_p, row) => {
    expect(probes.some(([, probe]) => findBannedHits(probe, [row]).length > 0)).toBe(true)
  })

  const nearMisses = [
    'Any group that shares a purpose is welcome, online or in one place.',
    'Meet near the river',
    'Your area of work',
    'An executive summary',
    'Powered by Gemini',
    'a member panel settles disputes'
  ]

  it.each(nearMisses)('near miss "%s" fires no voice or product rule', (text) => {
    expect(findBannedHits(text, rules)).toEqual([])
  })

  it('a planted voice-rule hit fails the CLI and names the list and rule', () => {
    const r = run(page(CLEAN_BODY + '<p>Find groups near you, with seamless sync.</p>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*near \(\?:you\|me\).*voice and product rules, PLACE-01/m)
    expect(r.out).toMatch(/^FAIL .*seamless.*voice and product rules, Voice/m)
  })

  it('an honesty hit names the honesty list', () => {
    const r = run(page(CLEAN_BODY + '<p>127 Communities</p>'))
    expect(r.out).toMatch(/^FAIL .*127 Communities \(honesty bans:/m)
  })

  it('the clean page passes both lists', () => {
    const r = run(page(CLEAN_BODY + '<p>Any group that shares a purpose is welcome, online or in one place.</p>'))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })
})
