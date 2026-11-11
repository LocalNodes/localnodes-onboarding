// Landing-page claims guard (fresh3 22.1-04, D-16).
// Proves the check fires: a planted banned claim, a missing licence and a
// GPL-only licence line each make the script exit 1; a clean page exits 0.
// The coverage case uses probes hard-coded here (the earlier page's words, as
// D-16 names them), not read from LANDING.md or the fixture, so it isn't
// circular.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error plain .mjs script, no type declarations
import { findBannedHits, prelaunchProblems } from '../../scripts/check-landing-claims.mjs'

const repo = resolve(__dirname, '../..')
const script = join(repo, 'scripts/check-landing-claims.mjs')
const fixture = JSON.parse(readFileSync(join(repo, 'tests/fixtures/banned-claims.json'), 'utf8'))

// The pre-launch statement every page must carry (Tom, 2026-11-06, PR #9).
const PRELAUNCH = '<p data-prelaunch class="band"><span>Launching soon.</span> <a href="#demo">See the demo</a> or <a href="#early-access">get early access</a>.</p>'

const CLEAN_BODY = `
  ${PRELAUNCH}
  <h1>Where your community thinks, decides and funds together.</h1>
  <p>Share posts, events and conversations, keep a library every member can ask, run a group fund, and vote on what happens next.</p>
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
    ['Voice', 'We empower communities'],
    ['Third-party title', 'Inspired by Building a Second Brain'],
    ['Plain words', 'Then the full price applies'],
    ['Plain words', 'This usually takes about 4 minutes']
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
    'a member panel settles disputes',
    'The second brain for your community.',
    'Your community\'s second brain, ready from the first day.'
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

describe('pre-launch statement (Tom, 2026-11-06, PR #9)', () => {
  it('passes a page with the statement', () => {
    const r = run(page(CLEAN_BODY))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('fails a page with no pre-launch statement, naming the rule', () => {
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, '')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Pre-launch statement \(no pre-launch statement/m)
  })

  it('fails when the words are there but not marked as the statement', () => {
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, '<p>Launching soon. See the demo.</p>')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Pre-launch statement/)
  })

  it('fails when the marked element says something else', () => {
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, '<p data-prelaunch>Available now.</p>')))
    expect(r.code).toBe(1)
  })

  it('fails when the statement is only in a hidden template or script', () => {
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, '<template><p data-prelaunch>Launching soon.</p></template>')))
    expect(r.code).toBe(1)
  })

  // Codex P2: each way a statement can be in the HTML but not seen.
  const rule = { attribute: 'data-prelaunch', phrase: 'Launching soon' }
  it.each([
    ['an HTML comment', '<!-- <p data-prelaunch>Launching soon.</p> -->'],
    ['the hidden attribute', '<p data-prelaunch hidden>Launching soon.</p>'],
    ['aria-hidden', '<p data-prelaunch aria-hidden="true">Launching soon.</p>'],
    ['a hidden ancestor', '<div hidden><section><p data-prelaunch>Launching soon.</p></section></div>'],
    ['an aria-hidden ancestor', '<div aria-hidden="true"><p data-prelaunch>Launching soon.</p></div>'],
    ['inline display:none', '<p data-prelaunch style="display: none">Launching soon.</p>'],
    ['inline visibility:hidden on an ancestor', '<div style="color:red;visibility:hidden"><p data-prelaunch>Launching soon.</p></div>'],
    ['the hidden class', '<p data-prelaunch class="text-sm hidden">Launching soon.</p>'],
    ['the sr-only class', '<p data-prelaunch class="sr-only">Launching soon.</p>'],
    ['the invisible class on an ancestor', '<div class="invisible"><p data-prelaunch>Launching soon.</p></div>'],
    ['a hidden child holding the phrase', '<p data-prelaunch>Welcome. <span class="sr-only">Launching soon.</span></p>'],
    ['a responsive md:hidden ancestor', '<div class="md:hidden"><p data-prelaunch>Launching soon.</p></div>'],
    ['inline opacity:0', '<p data-prelaunch style="opacity: 0">Launching soon.</p>'],
    ['inline opacity:0.0 on an ancestor', '<div style="color:red; opacity:0.0;"><p data-prelaunch>Launching soon.</p></div>'],
    ['inline opacity:0%', '<p data-prelaunch style="opacity:0%">Launching soon.</p>'],
    ['the opacity-0 class', '<p data-prelaunch class="text-sm opacity-0">Launching soon.</p>'],
    ['a responsive md:opacity-0 class', '<p data-prelaunch class="md:opacity-0">Launching soon.</p>'],
    ['an opacity-0 ancestor', '<div class="opacity-0"><section><p data-prelaunch>Launching soon.</p></section></div>']
  ])('fails a statement hidden by %s', (_why, html) => {
    expect(prelaunchProblems(`<body>${html}</body>`, rule)).not.toEqual([])
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, html)))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Pre-launch statement/)
  })

  it('does not take opacity 0.5, opacity-50 or hover:opacity-100 for hidden', () => {
    for (const html of ['<p data-prelaunch style="opacity: 0.5">Launching soon.</p>', '<p data-prelaunch class="opacity-50 hover:opacity-100">Launching soon.</p>', '<p data-prelaunch style="opacity:1">Launching soon.</p>']) {
      expect(prelaunchProblems(`<body>${html}</body>`, rule)).toEqual([])
    }
  })

  it('passes a visible statement next to hidden siblings and void tags', () => {
    const html = '<div class="flex"><p data-prelaunch class="inline-flex">Launching <b>soon</b>.<span class="sr-only">(banner)</span></p></div><div hidden>x</div><img src="a.png"><br>'
    expect(prelaunchProblems(`<body>${html}</body>`, rule)).toEqual([])
  })

  it('reads the statement through nested tags and any case', () => {
    expect(prelaunchProblems('<div data-prelaunch=""><b>LAUNCHING</b> soon.</div>', { attribute: 'data-prelaunch', phrase: 'Launching soon' })).toEqual([])
  })

  it('still bans invented numbers, testimonials, customer names and prices on a pre-launch page', () => {
    for (const planted of ['<p>Trusted by 127 Communities worldwide.</p>', '<p>Climate Tech Collective</p>', '<p>Only $29/month</p>']) {
      const r = run(page(CLEAN_BODY + planted))
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/honesty bans/)
    }
  })

  it('reads the <title> as meta only, not as visible text', () => {
    const r = run(page(CLEAN_BODY.replace(PRELAUNCH, '')).replace('<title>LocalNodes</title>', '<title data-prelaunch>Launching soon</title>'))
    expect(r.code).toBe(1)
  })
})

// Sign-up pages and mail copy (fresh3 23-28, D-22, PLACE-01): the voice and
// buyer-word rules run over every file in signupSources and mailSources, and
// the failing line names the list and the file. The temp root holds a copy of
// each file the fixture lists; the CLI reads the repo's own fixture and joins
// each listed path to --root, so a planted file lands where the CLI looks.
describe('sign-up pages and mail copy are wording-checked (23-28)', () => {
  const INVITE_ENTRY = 'app/pages/invite/index.vue'
  const INVITE_VERIFY = 'app/pages/invite/verify.vue'
  const MAIL_COPY = 'server/utils/mail-copy.ts'
  const listed: string[] = [...(fixture.signupSources ?? []), ...(fixture.mailSources ?? [])]
  // The files the planting tests need, whether or not the fixture lists them yet.
  const wanted = [...new Set([...listed, INVITE_ENTRY, INVITE_VERIFY, MAIL_COPY])]

  /** Copy every listed source (and the three named above) from the repo into the temp root. */
  function copyListed() {
    for (const rel of wanted) {
      const from = join(repo, rel)
      mkdirSync(join(root, dirname(rel)), { recursive: true })
      writeFileSync(join(root, rel), readFileSync(from, 'utf8'))
    }
  }
  function plant(rel: string, add: string) {
    writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8') + `\n${add}\n`)
  }
  const runClean = () => run(page(CLEAN_BODY))

  it('the fixture lists both invite pages in signupSources and the mail copy in mailSources', () => {
    expect(fixture.signupSources).toEqual(expect.arrayContaining([INVITE_ENTRY, INVITE_VERIFY]))
    expect(fixture.mailSources).toEqual([MAIL_COPY])
  })

  it('every listed file exists, so a rename or a typo cannot drop a file out of the check unnoticed', () => {
    for (const rel of listed) expect(existsSync(join(repo, rel)), rel).toBe(true)
  })

  it('the unchanged pages and mail copy pass', () => {
    copyListed()
    const r = runClean()
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('a place word planted in the invite page fails, and the line names signupSources and the file', () => {
    copyListed()
    plant(INVITE_ENTRY, '<p>Find groups near you.</p>')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/pages\/invite\/index\.vue: .*\(signupSources: voice and product rules, PLACE-01:/m)
  })

  it('a place word planted in the link landing fails the same way', () => {
    copyListed()
    plant(INVITE_VERIFY, '<p>Meet people in your town.</p>')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/pages\/invite\/verify\.vue: .*\(signupSources: voice and product rules, PLACE-01:/m)
  })

  it('a place word planted in the mail copy fails, and the line names mailSources and the file', () => {
    copyListed()
    plant(MAIL_COPY, 'export const planted = \'Find groups near you\'')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL server\/utils\/mail-copy\.ts: .*\(mailSources: voice and product rules, PLACE-01:/m)
  })

  it.each(['co-op', 'guild', 'DAO', 'land trust'])('the buyer word "%s" planted in a sign-up page fails and names signupSources', (word) => {
    copyListed()
    plant(INVITE_ENTRY, `<p>Set up your ${word}.</p>`)
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/pages\/invite\/index\.vue: .*\(signupSources: buyer word in the sign-up flow \(D-05\)\)/m)
  })

  it('a buyer word planted in the mail copy fails and names mailSources', () => {
    copyListed()
    plant(MAIL_COPY, 'export const planted = \'Welcome, land trust\'')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL server\/utils\/mail-copy\.ts: .*\(mailSources: buyer word in the mail copy \(D-05\)\)/m)
  })

  it('a frame word planted in the mail copy fails and names mailSources', () => {
    copyListed()
    plant(MAIL_COPY, 'export const planted = \'a network state\'')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL server\/utils\/mail-copy\.ts: .*\(mailSources: frame word in the mail copy \(D-05\)\)/m)
  })

  it.each(['full price', 'about 4 minutes'])('the plain-words phrase "%s" planted in a sign-up page fails as a voice rule', (phrase) => {
    copyListed()
    plant(INVITE_ENTRY, `<p>Then the ${phrase} applies.</p>`)
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/pages\/invite\/index\.vue: .*\(signupSources: voice and product rules, Plain words:/m)
  })

  it('the plain-words phrases planted in the mail copy fail and name mailSources', () => {
    copyListed()
    plant(MAIL_COPY, 'export const planted = \'Then the full price applies\'')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL server\/utils\/mail-copy\.ts: .*\(mailSources: voice and product rules, Plain words:/m)
  })

  it('a hype word planted in a sign-up page fails as a voice rule', () => {
    copyListed()
    plant(INVITE_ENTRY, '<p>A seamless start.</p>')
    const r = runClean()
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/pages\/invite\/index\.vue: .*\(signupSources: voice and product rules, Voice:/m)
  })

  it('a listed file that is not in the root is skipped, not a failure (a page not built yet)', () => {
    const r = runClean()
    expect(r.out).toContain('RESULT: PASS')
  })
})
