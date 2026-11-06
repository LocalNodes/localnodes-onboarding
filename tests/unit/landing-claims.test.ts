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

interface Feature { title: string, status: 'today' | 'coming', chip?: string }
const features: Feature[] = fixture.features.items

// One list item per inventory feature, each with its expected chip, so the
// clean page always matches the fixture (LANDING.md section 5).
const featureList = features
  .map(f => `<li><span>${f.title}</span> <span>Some words about it.</span>${f.status === 'coming' ? ` <span class="chip">${f.chip}</span>` : ''}</li>`)
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
    const r = run(page(CLEAN_BODY.replace('<span class="chip">Coming, rung 2</span>', '<span class="chip">Available now</span>')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*Decide together\./m)
  })

  it('exits 1 when a coming feature\'s rung changes', () => {
    const r = run(page(CLEAN_BODY.replace('See your group fund.</span> <span>Some words about it.</span> <span class="chip">Coming, rung 1', 'See your group fund.</span> <span>Some words about it.</span> <span class="chip">Coming, rung 2')))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/^FAIL .*See your group fund\..*expected "Coming, rung 1", found "Coming, rung 2"/m)
  })

  it('exits 1 when a today feature gains a Coming chip, or a Phase 22 item loses its chip', () => {
    const marked = run(page(CLEAN_BODY.replace('Search that finds what you mean.</span> <span>Some words about it.</span>', 'Search that finds what you mean.</span> <span>Some words about it.</span> <span>Coming</span>')))
    expect(marked.code).toBe(1)
    expect(marked.out).toMatch(/^FAIL .*Search that finds what you mean\./m)
    const unmarked = run(page(CLEAN_BODY.replace('Bring in many files at once.</span> <span>Some words about it.</span> <span class="chip">Coming, Phase 22</span>', 'Bring in many files at once.</span> <span>Some words about it.</span>')))
    expect(unmarked.code).toBe(1)
    expect(unmarked.out).toMatch(/^FAIL .*Bring in many files at once\./m)
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

  const nearMisses = [
    'Submit',
    'emit',
    'commitment',
    'a community land trust',
    'an online guild or DAO',
    'a housing co-op',
    'open source (GPL and AGPL)'
  ]

  it.each(nearMisses)('near miss "%s" hits nothing', (word) => {
    expect(findBannedHits(word, fixture.banned)).toEqual([])
  })
})
