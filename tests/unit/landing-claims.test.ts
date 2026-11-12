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
import { LAUNCH_CLAIMS, claimsOn } from '../../shared/launch-claims.mjs'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import WhoItsForWindow from '~/components/WhoItsForWindow.vue'
import whoItsFor from '~/data/who-its-for.json'

const repo = resolve(__dirname, '../..')
const script = join(repo, 'scripts/check-landing-claims.mjs')
const fixture = JSON.parse(readFileSync(join(repo, 'tests/fixtures/banned-claims.json'), 'utf8'))

// The pre-launch statement every page must carry (Tom, 2026-11-06, PR #9).
const PRELAUNCH = '<p data-prelaunch class="band"><span>Launching soon.</span> <a href="#demo">See the demo</a> or <a href="#early-access">get early access</a>.</p>'

// The home page's promises, which the built home page must carry word for word.
const CLAIMS = claimsOn('/').map(c => `<p>${c.text}</p>`).join('\n  ')

const CLEAN_BODY = `
  ${PRELAUNCH}
  <h1>Where your community shares, decides and funds together.</h1>
  <p>Share posts, events and conversations, keep a library every member can ask, run a group fund, and vote on what happens next.</p>
  <a href="https://cascadia.localnodes.xyz">Cascadia (demo)</a>
  <a href="/onboarding">Set up your community's site</a>
  ${CLAIMS}
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
  for (const c of claimsOn('/')) {
    it(`fails when the launch claim "${c.id}" is reworded on the page`, () => {
      const reworded = CLEAN_BODY.replace(`<p>${c.text}</p>`, `<p>${c.text.replace(/\.$/, '')} today.</p>`)
      expect(reworded).not.toBe(CLEAN_BODY)
      const r = run(page(reworded))
      expect(r.out).toContain(`launch claim "${c.id}"`)
      expect(r.out).toContain('RESULT: FAIL')
      expect(r.code).toBe(1)
    })
  }

  it('reads a launch claim across line breaks and markup, as a reader sees it', () => {
    const c = claimsOn('/')[0]!
    const [first, ...rest] = c.text.split(' ')
    const split = CLEAN_BODY.replace(`<p>${c.text}</p>`, `<p><span>${first}</span>\n   ${rest.join(' ')}</p>`)
    const r = run(page(split))
    expect(r.out).toContain('RESULT: PASS')
  })

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

// The home page's fund window shows scripted example
// amounts. Only an amount that sits alone in a box, in the fund section, and
// that matches home-demo.json is exempt from the price rule, and only from the
// price rule. Every other rule still reads the unchanged text.
describe('demo amounts in the fund window', () => {
  const DEMO = { fund: { balanceBefore: 12400, balanceAfter: 10600, payment: 1800 }, examples: [{ q: 'Where do we keep the lease?', a: 'The lease is in the shared binder.' }] }

  function writeDemo(json: unknown) {
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/home-demo.json'), typeof json === 'string' ? json : JSON.stringify(json))
  }
  const slot = (path: string, text: string) => `<span data-demo-amount="${path}">${text}</span>`
  const box = (path: string, text: string) => `<div data-demo-amount-box>${slot(path, text)}</div>`
  const FUND = `<section id="fund"><h2>A fund the group controls, and can see.</h2><p>Repair fund balance</p>${box('fund.balanceAfter', '$10,600')}${box('fund.payment', '$1,800')}</section>`

  it('the demo page passes: both amounts are boxed, in #fund, and match the data', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('passes with Vue comment markers around the slot', () => {
    writeDemo(DEMO)
    const f = FUND.replace('<span data-demo-amount="fund.payment">$1,800</span>', '<!--[--><span data-demo-amount="fund.payment">$1,800</span><!--]-->')
    expect(run(page(CLEAN_BODY + f)).code).toBe(0)
  })

  it('a $5 planted elsewhere still fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND + '<p>Join for $5.</p>'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL /m)
  })

  it('a $99 in #fund with no slot fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace('</section>', '<p>Only $99</p></section>')))
    expect(r.code).toBe(1)
  })

  it('a slot outside #fund fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND + `<section id="other">${box('fund.payment', '$1,800')}</section>`))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/demo amount/)
  })

  it('a slot of $1,800,000 fails (text is not the data)', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace('$1,800', '$1,800,000')))
    expect(r.code).toBe(1)
  })

  it('a slot of $1,800/month fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(slot('fund.payment', '$1,800'), slot('fund.payment', '$1,800/month'))))
    expect(r.code).toBe(1)
  })

  it('a slot naming a missing field or fund.other fails', () => {
    writeDemo(DEMO)
    expect(run(page(CLEAN_BODY + FUND.replace('fund.payment', 'fund.other'))).code).toBe(1)
    writeDemo({ ...DEMO, fund: { balanceBefore: 12400, balanceAfter: 10600 } })
    expect(run(page(CLEAN_BODY + FUND)).code).toBe(1)
  })

  it('a field that is not a number fails', () => {
    writeDemo({ ...DEMO, fund: { ...DEMO.fund, payment: '1800' } })
    expect(run(page(CLEAN_BODY + FUND)).code).toBe(1)
  })

  it('a page with slots and no data file fails (exit 1)', () => {
    const r = run(page(CLEAN_BODY + FUND))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/home-demo\.json/)
  })

  it('a page with slots and an invalid data file fails (exit 1)', () => {
    writeDemo('{ not json')
    const r = run(page(CLEAN_BODY + FUND))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/home-demo\.json/)
  })

  it('a missing build is still exit 2', () => {
    writeDemo(DEMO)
    expect(runCli().code).toBe(2)
  })

  it('the existing clean fixtures still pass with no data file and no slots', () => {
    expect(run(page(CLEAN_BODY)).code).toBe(0)
  })

  it('a price with a label word and no box fails (Price: slot /month, no box)', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + '<section id="fund">Price: <span data-demo-amount="fund.payment">$1,800</span>/month</section>'))
    expect(r.code).toBe(1)
  })

  it('a boxed amount followed by /month fails (orphan rate word)', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace('</section>', '</section>').replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '/month')))
    expect(r.code).toBe(1)
  })

  it('a boxed amount followed by "per month" or "each" fails', () => {
    writeDemo(DEMO)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '<p>per month</p>'))).code).toBe(1)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + ' each'))).code).toBe(1)
  })

  it('a boxed amount after "Price:" or "from" fails', () => {
    writeDemo(DEMO)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), 'Price: ' + box('fund.payment', '$1,800')))).code).toBe(1)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), '<p>from</p>' + box('fund.payment', '$1,800')))).code).toBe(1)
  })

  // The orphan checks read what a reader sees, so hidden text
  // between a label word and the box cannot mask them. aria-hidden demo text is still seen.
  it('hidden text cannot mask "Price:" before a box', () => {
    writeDemo(DEMO)
    const f = (hide: string) => run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), `Price: ${hide}` + box('fund.payment', '$1,800'))))
    expect(f('<span hidden>balance</span>').code).toBe(1)
    expect(f('<span style="display:none">balance</span>').code).toBe(1)
    expect(f('<span class="hidden">balance</span>').code).toBe(1)
  })

  it('hidden text cannot mask "monthly" after a box', () => {
    writeDemo(DEMO)
    const f = (hide: string) => run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + `${hide} monthly`)))
    expect(f('<span hidden>balance</span>').code).toBe(1)
    expect(f('<span style="display:none">balance</span>').code).toBe(1)
    expect(f('<span class="hidden">balance</span>').code).toBe(1)
  })

  // sr-only text is read out but not seen, so it cannot mask a seen
  // price word; and the word "hidden" inside an attribute value hides nothing.
  it('sr-only text cannot mask "Price:" before or "monthly" after a box', () => {
    writeDemo(DEMO)
    const sr = '<span class="sr-only">balance</span>'
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), `Price: ${sr}` + box('fund.payment', '$1,800') + `${sr} monthly`)))
    expect(r.code).toBe(1)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), `Price: ${sr}` + box('fund.payment', '$1,800')))).code).toBe(1)
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + `${sr} monthly`))).code).toBe(1)
  })

  it('a price word read out by a screen reader (sr-only) next to a box fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '<span class="sr-only">per month</span>')))
    expect(r.code).toBe(1)
  })

  it('"hidden" inside an attribute value does not hide the text', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), '<span title="a hidden example">Price:</span>' + box('fund.payment', '$1,800') + '<span title="a hidden example"> monthly</span>')))
    expect(r.code).toBe(1)
    const after = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '<span data-note="hidden"> monthly</span>')))
    expect(after.code).toBe(1)
  })

  it('hidden text before a box that says a price word (and nothing seen does) still passes the orphan check', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), '<span hidden>Price:</span>' + box('fund.payment', '$1,800'))))
    expect(r.out).toContain('RESULT: PASS')
  })

  it('aria-hidden demo text still counts as seen text: a rate word in it fails', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '<span aria-hidden="true">per month</span>')))
    expect(r.code).toBe(1)
  })

  it('a box whose text is $1,800/month fails (text mismatch)', () => {
    writeDemo(DEMO)
    const bad = '<div data-demo-amount-box><span data-demo-amount="fund.payment">$1,800</span>/month</div>'
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), bad)))
    expect(r.code).toBe(1)
  })

  it('a box in a span or b (not a block box) fails', () => {
    writeDemo(DEMO)
    const bad = '<span data-demo-amount-box><span data-demo-amount="fund.payment">$1,800</span></span>'
    expect(run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), bad))).code).toBe(1)
  })

  it('other rules still read the unchanged text: a monthly rate right after a box fails on the rate rule', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND.replace(box('fund.payment', '$1,800'), box('fund.payment', '$1,800') + '<p>/mo</p>')))
    expect(r.code).toBe(1)
  })

  it('meta tags get no exemption', () => {
    writeDemo(DEMO)
    const r = run(page(CLEAN_BODY + FUND).replace('A library your members', '$1,800 A library your members'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/meta/)
  })
})

describe('home-demo.json strings are wording-checked', () => {
  function writeDemo(json: unknown) {
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/home-demo.json'), JSON.stringify(json))
  }
  const base = () => ({
    fund: { balanceBefore: 12400, balanceAfter: 10600, payment: 1800 },
    examples: [{ a: 'One.' }, { a: 'Two.' }, { a: 'Three.' }, { a: 'Four.' }]
  })

  it('a clean data file passes with no slots on the page', () => {
    writeDemo(base())
    expect(run(page(CLEAN_BODY)).code).toBe(0)
  })

  it('a banned phrase planted in the third example answer fails and names the file', () => {
    const d = base()
    d.examples[2]!.a = 'Trusted by 127 Communities worldwide.'
    writeDemo(d)
    const r = run(page(CLEAN_BODY))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/data\/home-demo\.json/m)
  })

  it('a voice rule hit in the data fails and names the file', () => {
    const d = base()
    d.examples[0]!.a = 'A seamless, AI-powered library.'
    writeDemo(d)
    const r = run(page(CLEAN_BODY))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/home-demo\.json/)
  })

  it('a price in a data string fails', () => {
    const d = base()
    d.examples[1]!.a = 'Costs $12 a seat.'
    writeDemo(d)
    expect(run(page(CLEAN_BODY)).code).toBe(1)
  })
})

describe('the Who it\'s for page (/for) is claims-checked', () => {
  // The page's own promises, which the built /for page must carry word for word.
  const FOR_CLAIMS = claimsOn('/for').map(c => `<p>${c.text}</p>`).join('\n  ')
  const FOR_BODY = `
  <h1>Who it's for</h1>
  <section id="housing-co-ops"><h2>Housing co-ops</h2><p>Your co-op has several houses and plenty to remember.</p>
  <dl><dt>How it's set up</dt><dd>The co-op has one site, with each house as a group.</dd>
  <dt>In the first week</dt><dd><ul><li>Add the minutes and repair log.</li><li>Ask about the back steps and open the cited page.</li></ul></dd></dl></section>
  <p>A single group with no network is welcome too.</p>
  ${FOR_CLAIMS}
  <p data-prelaunch>Launching soon.</p><a href="/#early-access">Get early access</a>
`
  function forPage(body: string, meta = 'The kinds of group LocalNodes is for.') {
    return `<!DOCTYPE html><html><head><title>Who it's for - LocalNodes</title>
<meta name="description" content="${meta}"></head>
<body>${body}<p>LocalNodes is open source (GPL and AGPL).</p></body></html>`
  }
  /** Write the home page and the /for page, then run the check. */
  function runBoth(forHtml: string | null, opts: { pageSource?: boolean } = {}) {
    if (opts.pageSource !== false) {
      mkdirSync(join(root, 'app/pages'), { recursive: true })
      writeFileSync(join(root, 'app/pages/for.vue'), '<template><h1>Who it\'s for</h1></template>')
    }
    if (forHtml !== null) {
      mkdirSync(join(root, '.output/public/for'), { recursive: true })
      writeFileSync(join(root, '.output/public/for/index.html'), forHtml)
    }
    return run(page(CLEAN_BODY))
  }

  it('passes a clean /for page, which carries its own launch claims and not the home page\'s', () => {
    expect(claimsOn('/for').length).toBeGreaterThan(0)
    const r = runBoth(forPage(FOR_BODY))
    expect(r.out).toContain('CHECK .output/public/for/index.html')
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  for (const c of claimsOn('/for')) {
    it(`fails when the /for launch claim "${c.id}" is reworded on the /for page`, () => {
      const reworded = FOR_BODY.replace(`<p>${c.text}</p>`, `<p>${c.text.replace(/[.?]$/, '')} today.</p>`)
      expect(reworded).not.toBe(FOR_BODY)
      const r = runBoth(forPage(reworded))
      expect(r.code).toBe(1)
      expect(r.out).toContain(`FAIL .output/public/for/index.html: launch claim "${c.id}" (not on the page word for word`)
    })
  }

  it('fails a sentence about a poll or the calendar that is not on the claims list, naming the list', () => {
    for (const line of ['<p>Settle it with a poll.</p>', '<p>Add the potluck to the calendar.</p>']) {
      const r = runBoth(forPage(FOR_BODY + line))
      expect(r.code, line).toBe(1)
      expect(r.out, line).toMatch(/\(pendingTopicWords: a sentence about a promise that is not on the claims list/)
    }
  })

  it('fails when the page source exists but no /for page was built', () => {
    const r = runBoth(null)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no built \/for page/)
  })

  it('does not ask for a /for page when the repo has no page source', () => {
    const r = runBoth(null, { pageSource: false })
    expect(r.code).toBe(0)
  })

  it('fails on a price, in the text or the meta', () => {
    expect(runBoth(forPage(FOR_BODY + '<p>Only $49.</p>')).code).toBe(1)
    const r = runBoth(forPage(FOR_BODY, 'From $49 a month.'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL \.output\/public\/for\/index\.html: meta/m)
  })

  it('fails without the pre-launch statement, and on a demo link that does not say demo', () => {
    expect(runBoth(forPage(FOR_BODY.replace('data-prelaunch', ''))).out).toMatch(/no pre-launch statement/)
    expect(runBoth(forPage(FOR_BODY + '<a href="https://coop.localnodes.xyz">Visit the co-op</a>')).out).toMatch(/demo link not labelled/)
  })

  it('fails on a voice rule', () => {
    expect(runBoth(forPage(FOR_BODY + '<p>Find groups near you.</p>')).code).toBe(1)
  })

  it('fails the original gatherings line, on its pending words, naming the list', () => {
    const line = '<li>Coming next: decide the programme together; use practice money for small session grants.</li>'
    const r = runBoth(forPage(FOR_BODY + line))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/pendingTopicWords: a sentence about a promise that is not on the claims list/)
    expect(r.out).toMatch(/decid/)
    expect(r.out).toMatch(/money/)
  })

  it('lets a launch-claims sentence through the pending-words list word for word, and nothing else', () => {
    const claim = LAUNCH_CLAIMS.find(c => c.id === 'real-fund')!.text
    expect(runBoth(forPage(FOR_BODY + `<p>${claim}</p>`)).code).toBe(0)
    expect(runBoth(forPage(FOR_BODY + '<p>Open a practice fund for the group.</p>')).code).toBe(1)
  })

  it('checks the data file and the page sources with the three lists', () => {
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/who-its-for.json'), JSON.stringify({ kinds: [{ who: 'Members connect a wallet.' }] }))
    const r = runBoth(forPage(FOR_BODY))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/data\/who-its-for\.json: .*cryptoWords/m)
    rmSync(join(root, 'app/data/who-its-for.json'))
    mkdirSync(join(root, 'app/components'), { recursive: true })
    writeFileSync(join(root, 'app/components/HomeKinds.vue'), '<template><p>Free for groups like co-ops.</p></template>')
    const r2 = runBoth(forPage(FOR_BODY))
    expect(r2.code).toBe(1)
    expect(r2.out).toMatch(/^FAIL app\/components\/HomeKinds\.vue: .*priceWords/m)
  })

  it('runs the honesty bans on the data file', () => {
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/who-its-for.json'), JSON.stringify({ intro: 'Trusted by 127 Communities.' }))
    const r = runBoth(forPage(FOR_BODY))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL app\/data\/who-its-for\.json: 127 Communities/m)
  })

  // One hard-coded probe per entry of each list, so every word is proved to fire.
  const listProbes: Record<string, string[]> = {
    cryptoWords: ['a wallet', 'tokens', 'gas', 'a chain', 'the blockchain', 'on-chain', 'cryptocurrency', 'a DAO', 'Ethereum', 'USDC', 'a stablecoin', 'NFTs', 'web3', 'a smart contract', 'multisig', 'the ledger', 'signatures', 'a fee', 'your seed phrase'],
    priceWords: ['the price', 'pricing', 'it costs', 'free', 'a pilot', 'a subscription', 'a discount', 'a coupon', '5 per month', '50 per year', '5 a month'],
    pendingTopicWords: ['vote', 'decided', 'a decision', 'a proposal', 'the fund', 'funded', 'funding', 'money', 'a budget', 'pay', 'payments', 'paid', 'treasury', 'dues', 'the bank', 'export', 'owned', 'owns', 'owners', 'ownership', 'a poll', 'polls', 'the calendar', 'calendars', 'session grants', 'anyone proposes a session']
  }
  for (const list of Object.keys(listProbes)) {
    // Every word in the fixture has a probe here, so a word added there is tested.
    const patterns: string[] = fixture[list].patterns
    it.each(patterns)(`${list}: %s fires on a hard-coded probe`, (p) => {
      const re = new RegExp(`\\b(?:${p})\\b`, 'i')
      expect(listProbes[list]!.some(probe => re.test(probe))).toBe(true)
    })
    // Every probe here goes through the checker on its own and must be
    // rejected, whatever the fixture says: a word taken out of the fixture
    // turns its probe red here.
    it.each(listProbes[list]!)(`${list}: the checker rejects "%s" on the built page and names the list`, (probe) => {
      const r = runBoth(forPage(FOR_BODY + `<p>${probe}</p>`))
      expect(r.code).toBe(1)
      expect(r.out).toContain(`(${list}: `)
    })
  }

  // The example window: every line in every kind's window goes through the same check as
  // the page text, on the built page and in the data file.
  async function windowHtml(data: typeof whoItsFor): Promise<string> {
    const app = createSSRApp({ render: () => h(WhoItsForWindow, { kinds: data.kinds, label: data.exampleWindow.label, note: data.exampleWindow.note }) })
    app.config.warnHandler = () => {}
    return renderToString(app)
  }
  /** The data file with one kind's example answer replaced. */
  function withAnswer(id: string, answer: string): typeof whoItsFor {
    const copy = JSON.parse(JSON.stringify(whoItsFor)) as typeof whoItsFor
    const kind = copy.kinds.find(k => k.id === id)!
    kind.example.a = answer
    return copy
  }
  const UNTRACKED = 'Yes. The house voted to pay for the repair from the group fund.'

  it('lists the window component among the /for sources the three word lists read', () => {
    expect(fixture.forPage.sources).toContain('app/components/WhoItsForWindow.vue')
  })

  it('passes the real example windows, in the built page and in the data file', async () => {
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/who-its-for.json'), JSON.stringify(whoItsFor))
    const r = runBoth(forPage(FOR_BODY + await windowHtml(whoItsFor)))
    expect(r.out).toContain('RESULT: PASS')
    expect(r.code).toBe(0)
  })

  it('fails an untracked promise planted in one kind\'s window, on the built page and in the data file', async () => {
    const planted = withAnswer('housing-co-ops', UNTRACKED)
    const html = await windowHtml(planted)
    expect(html).toContain(UNTRACKED)
    const r = runBoth(forPage(FOR_BODY + html))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL \.output\/public\/for\/index\.html: vot.*\(pendingTopicWords: /m)
    expect(r.out).toMatch(/^FAIL \.output\/public\/for\/index\.html: funds.*\(pendingTopicWords: /m)
    mkdirSync(join(root, 'app/data'), { recursive: true })
    writeFileSync(join(root, 'app/data/who-its-for.json'), JSON.stringify(planted))
    const r2 = runBoth(forPage(FOR_BODY + await windowHtml(whoItsFor)))
    expect(r2.code).toBe(1)
    expect(r2.out).toMatch(/^FAIL app\/data\/who-its-for\.json: .*\(pendingTopicWords: /m)
  })

  it('fails a crypto word or a price planted in a window\'s tile', async () => {
    for (const line of ['Send it from the group wallet.', 'Tickets cost $5 at the gate.']) {
      const copy = JSON.parse(JSON.stringify(whoItsFor)) as typeof whoItsFor
      copy.kinds.find(k => k.id === 'tenant-unions')!.example.tile.text = line
      const r = runBoth(forPage(FOR_BODY + await windowHtml(copy)))
      expect(r.code, line).toBe(1)
      expect(r.out, line).toMatch(/\((cryptoWords|priceWords): /)
    }
  })

  it('does not count "own" ("its own group") as a pending word', () => {
    expect(runBoth(forPage(FOR_BODY + '<p>Each team has its own group.</p>')).code).toBe(0)
  })
})
