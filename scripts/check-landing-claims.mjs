#!/usr/bin/env node
// Landing-page claims check (fresh3 22.1-04, D-16).
//
// Every claim on localnodes.xyz must be true on the day it ships. This reads
// the banned and required claims from tests/fixtures/banned-claims.json (a
// copy of fresh3 .planning/brand/LANDING.md section 6) and checks:
//   1. the prerendered landing page (Nitro's node-server output
//      .output/public/index.html, or the Vercel preset's
//      .vercel/output/static/index.html; with the build-start stamp that the
//      prebuild step writes, only a page written during this build counts): visible text
//      and meta tags, plus the landing sources (app/pages/index.vue,
//      app/components/*.vue, content/**, nuxt.config.ts), for banned claims;
//   2. the built page for the required claims: both licences named (or
//      "open source (GPL and AGPL)"), never GPL without AGPL; each inventory
//      feature's badge (none, or exactly "Coming"; LANDING.md section 5); every
//      demo-site link labelled a demo; no frame word;
//   Plus the voice and product rules (PLACE-01, AI-advisory, voice), a
//   separate list; every FAIL line names the list a hit came from.
//   Plus badged claims: a fund claim needs a "Test network" or "Coming"
//   badge in its sentence (Tom, 2026-11-06, PR #9).
//   3. the sign-up pages (/onboarding, /success, /cancel) for frame and buyer
//      words (D-05).
//
// Usage: node scripts/check-landing-claims.mjs [--root <dir>]
//        node scripts/check-landing-claims.mjs --stamp   (prebuild: record the build start)
// Exit: 0 pass, 1 fail, 2 no landing page written by this build (run npm run build first).
// Node built-ins only.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ALNUM = /[A-Za-z0-9]/

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile one banned row into a RegExp. */
export function compileRow(row) {
  if (row.regex) return new RegExp(row.pattern, row.flags ?? '')
  const p = row.pattern
  const start = ALNUM.test(p[0]) ? '\\b' : ''
  const end = ALNUM.test(p[p.length - 1]) ? '\\b' : ''
  return new RegExp(start + escapeRegex(p) + end, 'i')
}

/** Return the banned rows whose pattern matches text. */
export function findBannedHits(text, banned) {
  return banned.filter((row) => compileRow(row).test(text))
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/** Drop CSS: <style> blocks and class, :class and style attribute values. */
export function stripCss(src) {
  return src
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\s:?(class|style)\s*=\s*"[^"]*"/gi, ' ')
    .replace(/\s:?(class|style)\s*=\s*'[^']*'/gi, ' ')
}

/**
 * Visible text of an HTML page: no scripts, CSS, <title> (metaText reads it)
 * or tags; whitespace collapsed.
 */
export function visibleText(html) {
  const noCss = stripCss(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<title[\s\S]*?<\/title>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
  return decodeEntities(noCss.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** The <title> plus every meta tag's content attribute. */
export function metaText(html) {
  const parts = []
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (title) parts.push(title[1])
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const c = m[0].match(/\scontent\s*=\s*"([^"]*)"/i) || m[0].match(/\scontent\s*=\s*'([^']*)'/i)
    if (c) parts.push(c[1])
  }
  return decodeEntities(parts.join(' \n '))
}

/** Every <a href> with its visible text and aria-label. */
export function links(html) {
  const out = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]
    const href = (attrs.match(/\shref\s*=\s*"([^"]*)"/i) || [])[1]
    if (!href) continue
    const aria = (attrs.match(/\saria-label\s*=\s*"([^"]*)"/i) || [])[1] || ''
    out.push({ href: decodeEntities(href), text: visibleText(m[2]), aria: decodeEntities(aria) })
  }
  return out
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** Landing source files, relative to root. */
export function landingSources(root) {
  const files = []
  const index = join(root, 'app/pages/index.vue')
  if (existsSync(index)) files.push(index)
  const comps = join(root, 'app/components')
  if (existsSync(comps)) {
    for (const f of readdirSync(comps)) if (f.endsWith('.vue')) files.push(join(comps, f))
  }
  files.push(...walk(join(root, 'content')))
  const cfg = join(root, 'nuxt.config.ts')
  if (existsSync(cfg)) files.push(cfg)
  return files
}

function licenceProblems(text, rule) {
  const problems = []
  const gpl = new RegExp(rule.gplMention)
  const agpl = new RegExp(rule.agplMention)
  const namesBoth = rule.both.every((l) => text.includes(l))
  const short = text.toLowerCase().includes(rule.short.toLowerCase())
  if (!namesBoth && !short) {
    problems.push(`licence missing: name ${rule.both.join(' and ')} or say "${rule.short}"`)
  }
  if (gpl.test(text) && !agpl.test(text)) {
    problems.push('GPL without AGPL: the page mentions GPL but never AGPL')
  }
  return problems
}

function demoLinkProblems(html, siteHost) {
  const problems = []
  for (const l of links(html)) {
    let url
    try {
      url = new URL(l.href, `https://${siteHost}/`)
    } catch {
      continue
    }
    const host = url.hostname.toLowerCase()
    const isSite = host === siteHost || host === `www.${siteHost}`
    if (!host.endsWith(`.${siteHost}`) || isSite) continue
    if (!/demo/i.test(l.text) && !/demo/i.test(l.aria)) {
      problems.push(`demo link not labelled a demo: ${l.href} ("${l.text}")`)
    }
  }
  return problems
}


/**
 * The page text with each badge element (any tag carrying `data-badge`, as
 * ComingChip renders) replaced by a marker, so the feature check reads badges
 * and never the prose around them (D-16 as revised, Tom 2026-11-06). Each
 * section's end is marked too, so a feature's badge window stops at its own
 * section (Who it's for carries Test network badges).
 */
export function badgedText(html) {
  const marked = html.replace(/<\/section>/gi, ' \u27E6END\u27E7 </section>').replace(
    /<([a-z]+)\b[^>]*\sdata-badge\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, inner) => ` \u27E6BADGE:${visibleText(inner)}\u27E7 `
  )
  return visibleText(marked)
}

/**
 * Per-feature badge check (LANDING.md section 5). Items are in page order;
 * each title is searched after the previous match, so an earlier repeat of a
 * title (the band heading "Fund what matters. Decide together. ...") isn't
 * taken for the item. The first badge after the title, up to the next
 * inventory title, the end of its section or `window` characters, is the feature's badge: a today item
 * carries none, a coming item's badge must equal `badge` exactly.
 */
export function featureProblems(text, features) {
  const problems = []
  const badgeRe = /\u27E6BADGE:([^\u27E7]*)\u27E7/
  const titles = features.items.map((f) => f.title)
  let cursor = 0
  for (const f of features.items) {
    const at = text.indexOf(f.title, cursor)
    if (at < 0) {
      problems.push({ feature: f.title, why: 'feature missing from the page, or out of the inventory\'s page order' })
      continue
    }
    const start = at + f.title.length
    cursor = start
    let end = Math.min(text.length, start + (features.window ?? 400))
    const sectionEnd = text.indexOf('\u27E6END\u27E7', start)
    if (sectionEnd >= 0 && sectionEnd < end) end = sectionEnd
    for (const t of titles) {
      if (t === f.title) continue
      const next = text.indexOf(t, start)
      if (next >= 0 && next < end) end = next
    }
    const m = text.slice(start, end).match(badgeRe)
    const found = m ? m[1].trim() : null
    if (f.status === 'today' && found !== null) {
      problems.push({ feature: f.title, why: `works today per the inventory, but has the badge "${found}"` })
    } else if (f.status === 'coming' && found !== f.badge) {
      problems.push({ feature: f.title, why: `expected the badge "${f.badge}", found ${found !== null ? `"${found}"` : 'no badge'}` })
    }
  }
  return problems
}

/** The page without its sections marked `data-claims-exempt`. */
export function dropExempt(html) {
  return html.replace(/<section\b[^>]*\sdata-claims-exempt\b[^>]*>[\s\S]*?<\/section>/gi, ' ')
}

/**
 * Badged claims (Tom, 2026-11-06, PR #9, option A): each match of a rule's
 * pattern in `text` (badgedText output) needs one of the rule's badges in its
 * own clause: the nearest badge after it with no , ; : or sentence end in
 * between (one full stop allowed, for a badge straight after the sentence),
 * or else the nearest badge before it with no punctuation in between (a chip
 * that heads its text). A badge for another clause ("…shared money, with votes
 * to follow [Coming].") doesn't count for the fund claim.
 */
export function badgedClaimProblems(text, cfg) {
  const problems = []
  const BADGE = /⟦BADGE:([^⟧]*)⟧/
  for (const rule of cfg?.rules ?? []) {
    const re = new RegExp(rule.pattern, (rule.flags ?? '').replace('g', '') + 'g')
    for (const m of text.matchAll(re)) {
      const after = text.slice(m.index + m[0].length)
      const fwd = after.match(BADGE)
      let found = null
      if (fwd && /^[^,;:.!?]*(?:[.!?]\s*)?$/.test(after.slice(0, fwd.index))) found = fwd[1].trim()
      if (found === null) {
        const before = text.slice(0, m.index)
        const at = before.lastIndexOf('⟦BADGE:')
        if (at >= 0) {
          const close = before.indexOf('⟧', at)
          if (close >= 0 && !/[,;:.!?]/.test(before.slice(close + 1))) found = before.slice(at + 7, close).trim()
        }
      }
      if (found === null || !rule.badges.includes(found)) {
        const ctx = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim()
        problems.push({ claim: m[0], why: `${rule.reason}${found !== null ? ` (found "${found}")` : ''}: "…${ctx}…"` })
      }
    }
  }
  return problems
}

/**
 * The landing pages to check. With a build-start stamp, only candidates
 * written during this build count (a stale page from another preset or an
 * older build is ignored). Without one (a manual run), the newest candidate.
 * Returns { paths } or { error }.
 */
export function resolveBuiltPages(root, outputs) {
  const existing = outputs.candidates
    .map((c) => join(root, c))
    .filter((p) => existsSync(p))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
  const stampPath = join(root, outputs.stampFile)
  if (existsSync(stampPath)) {
    const start = Number(readFileSync(stampPath, 'utf8').trim())
    // 2 s slack for filesystem timestamp granularity.
    const fresh = existing.filter((c) => c.mtime >= start - 2000)
    if (fresh.length) return { paths: fresh.map((c) => c.p) }
    if (existing.length) {
      return { error: `landing page not written during this build (stale: ${existing.map((c) => relative(root, c.p)).join(', ')}); run npm run build first` }
    }
    return { error: `no landing page found (${outputs.candidates.join(' or ')}); run npm run build first` }
  }
  if (!existing.length) {
    return { error: `no landing page found (${outputs.candidates.join(' or ')}); run npm run build first` }
  }
  existing.sort((a, b) => b.mtime - a.mtime)
  return { paths: [existing[0].p] }
}

/**
 * Run every check. Returns { code, lines }. code: 0 pass, 1 fail, 2 no build.
 */
export function runCheck(root, fixturePath = join(root, 'tests/fixtures/banned-claims.json')) {
  const lines = []
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const resolved = resolveBuiltPages(root, fixture.buildOutputs)
  if (resolved.error) {
    lines.push(`MISSING ${resolved.error}`)
    lines.push('RESULT: FAIL')
    return { code: 2, lines }
  }
  let failed = false
  const fail = (file, what, why) => {
    failed = true
    lines.push(`FAIL ${file}: ${what} (${why})`)
  }

  const voiceRules = fixture.voiceRules?.rules ?? []

  // 1. Honesty bans and voice and product rules in the landing sources.
  for (const file of landingSources(root)) {
    const src = stripCss(readFileSync(file, 'utf8'))
    for (const row of findBannedHits(src, fixture.banned)) fail(relative(root, file), row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(src, voiceRules)) fail(relative(root, file), row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
  }

  const builtDirs = []
  for (const builtPath of resolved.paths) {
    builtDirs.push(dirname(builtPath))
    const html = readFileSync(builtPath, 'utf8')
    const text = visibleText(html)
    const meta = metaText(html)
    const builtRel = relative(root, builtPath)
    lines.push(`CHECK ${builtRel}`)

    // Banned claims on the built page (visible text, meta).
    for (const row of findBannedHits(text, fixture.banned)) fail(builtRel, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(meta, fixture.banned)) fail(`${builtRel}: meta`, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(text, voiceRules)) fail(builtRel, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
    for (const row of findBannedHits(meta, voiceRules)) fail(`${builtRel}: meta`, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)

    // 2. Required claims on the built page.
    for (const req of fixture.required) {
      if (req.id === 'licence') {
        for (const p of licenceProblems(text, req)) fail(builtRel, req.rule, p)
      } else if (req.id === 'demo-label') {
        for (const p of demoLinkProblems(html, fixture.siteHost)) fail(builtRel, req.rule, p)
      }
    }
    if (fixture.features) {
      for (const p of featureProblems(badgedText(html), fixture.features)) fail(builtRel, p.feature, p.why)
    }
    if (fixture.badgedClaims) {
      for (const p of badgedClaimProblems(badgedText(dropExempt(html)), fixture.badgedClaims)) fail(builtRel, p.claim, `badged claims: ${p.why}`)
    }
    if (!fixture.frameWordAllowed) {
      for (const w of fixture.frameWords) {
        const re = compileRow({ pattern: w, regex: false })
        if (re.test(text) || re.test(meta)) fail(builtRel, w, 'frame word on the landing page (D-14)')
      }
    }
  }

  // 3. Sign-up pages: no frame or buyer words (D-05).
  const words = [
    ...fixture.frameWords.map((w) => ({ re: compileRow({ pattern: w, regex: false }), w, why: 'frame word in the sign-up flow (D-05)' })),
    ...fixture.buyerWords.map((w) => ({ re: new RegExp(w, 'i'), w, why: 'buyer word in the sign-up flow (D-05)' }))
  ]
  const signup = []
  for (const s of fixture.signupSources ?? []) {
    const p = join(root, s)
    if (existsSync(p)) signup.push({ file: s, text: stripCss(readFileSync(p, 'utf8')) })
  }
  for (const route of ['onboarding', 'success', 'cancel']) for (const dir of builtDirs) {
    const p = join(dir, route, 'index.html')
    if (existsSync(p)) {
      const h = readFileSync(p, 'utf8')
      signup.push({ file: relative(root, p), text: `${visibleText(h)} \n ${metaText(h)}` })
    }
  }
  for (const { file, text: t } of signup) {
    for (const { re, w, why } of words) if (re.test(t)) fail(file, w, why)
  }

  lines.push(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
  return { code: failed ? 1 : 0, lines }
}

function main(argv) {
  const i = argv.indexOf('--root')
  const here = dirname(fileURLToPath(import.meta.url))
  const root = i >= 0 ? resolve(argv[i + 1]) : resolve(here, '..')
  const fixture = join(resolve(here, '..'), 'tests/fixtures/banned-claims.json')
  if (argv.includes('--stamp')) {
    const { stampFile } = JSON.parse(readFileSync(fixture, 'utf8')).buildOutputs
    writeFileSync(join(root, stampFile), String(Date.now()))
    console.log(`claims check: build start recorded in ${stampFile}`)
    return
  }
  const { code, lines } = runCheck(root, fixture)
  for (const l of lines) console.log(l)
  process.exit(code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
}
