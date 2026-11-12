#!/usr/bin/env node
// Landing-page claims check (fresh3 22.1-04, D-16).
//
// The landing page is pre-launch (Tom, 2026-11-06): it describes the finished
// product, says plainly that it hasn't launched, and never invents numbers,
// testimonials, customers or prices. This reads
// the banned and required claims from tests/fixtures/banned-claims.json (a
// copy of fresh3 .planning/brand/LANDING.md section 6) and checks:
//   1. the prerendered landing page (Nitro's node-server output
//      .output/public/index.html, or the Vercel preset's
//      .vercel/output/static/index.html; with the build-start stamp that the
//      prebuild step writes, only a page written during this build counts): visible text
//      and meta tags, plus the landing sources (app/pages/index.vue,
//      app/components/*.vue, content/**, nuxt.config.ts), for banned claims;
//   2. the built page for the required claims: both licences named (or
//      "open source (GPL and AGPL)"), never GPL without AGPL; a visible
//      pre-launch statement (an element with data-prelaunch saying
//      "Launching soon"; Tom, 2026-11-06, PR #9); every demo-site link
//      labelled a demo; no frame word;
//   2b. every sentence in the launch claims list (shared/launch-claims.mjs) is
//      on the built page word for word;
//   Plus the voice and product rules (PLACE-01, AI-advisory, voice), a
//   separate list; every FAIL line names the list a hit came from.
//   2c. the public "Who it's for" page (fixture forPage): the built /for page
//      gets the honesty bans, the voice rules and the required claims of rule
//      2 (not 2b, and no buyer-word rule); its data file gets the honesty bans
//      and voice rules; and the built page, its meta, the data file and the
//      listed sources get three more lists, cryptoWords, priceWords and
//      pendingTopicWords (the last with the launch-claims sentences taken out
//      first, word for word). A repo with the page source and no built /for
//      page fails.
//   3. the sign-up pages and components (fixture list signupSources, plus the
//      built /onboarding, /success, /cancel, /invite pages when prerendered)
//      and the Nuxt mail copy (list mailSources) for frame words, buyer words
//      (D-05) and the voice and product rules, PLACE-01 included (D-22).
//
// Usage: node scripts/check-landing-claims.mjs [--root <dir>]
//        node scripts/check-landing-claims.mjs --stamp   (prebuild: record the build start)
// Exit: 0 pass, 1 fail, 2 no landing page written by this build (run npm run build first).
// Node built-ins only.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LAUNCH_CLAIMS, missingClaims } from '../shared/launch-claims.mjs'

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


const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const HIDDEN_CLASSES = new Set(['hidden', 'sr-only', 'invisible', 'opacity-0'])

/**
 * Whether a tag's own attributes hide it: hidden, aria-hidden, an inline
 * display:none, visibility:hidden or opacity:0, or a hiding utility class
 * (hidden, sr-only, invisible, opacity-0, and their variants like md:opacity-0).
 */
export function hidesElement(attrs) {
  if (/(^|\s)hidden(\s|=|$)/i.test(attrs)) return true
  if (/\saria-hidden\s*=\s*["']?true/i.test(attrs)) return true
  const style = (attrs.match(/\sstyle\s*=\s*"([^"]*)"/i) || attrs.match(/\sstyle\s*=\s*'([^']*)'/i) || [])[1] || ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden|(^|;|\s)opacity\s*:\s*0*(\.0*)?(%)?\s*(;|!|$)/i.test(style)) return true
  const cls = (attrs.match(/\sclass\s*=\s*"([^"]*)"/i) || attrs.match(/\sclass\s*=\s*'([^']*)'/i) || [])[1] || ''
  // Responsive variants count too (md:hidden hides it on wider screens).
  return cls.split(/\s+/).some((c) => HIDDEN_CLASSES.has(c.split(':').pop()))
}

/**
 * The attribute names a tag carries, with quoted values left out, so a word inside
 * a value (title="a hidden example") is never read as an attribute.
 */
function attrNames(attrs) {
  return attrs
    .replace(/=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g, ' ')
    .split(/[\s/]+/)
    .filter(Boolean)
    .map((n) => n.toLowerCase())
}

const OUT_OF_VIEW_CLASSES = ['hidden', 'invisible', 'opacity-0']

/**
 * Whether a tag's attributes take it out of the text, for the demo-amount orphan
 * checks. Two readings, both checked, so text hidden from one cannot mask a word in the other:
 * - 'seen': what a sighted reader sees. The hidden attribute, an inline display:none /
 *   visibility:hidden / opacity:0, or a hiding utility class, sr-only included.
 *   aria-hidden does not count: the demo windows are aria-hidden pictures, and their
 *   text is seen.
 * - 'heard': what a screen reader reads out. The same, except sr-only text is read.
 */
function takenOutOfView(attrs, reading) {
  if (attrNames(attrs).includes('hidden')) return true
  const style = (attrs.match(/\sstyle\s*=\s*"([^"]*)"/i) || attrs.match(/\sstyle\s*=\s*'([^']*)'/i) || [])[1] || ''
  if (/display\s*:\s*none|visibility\s*:\s*hidden|(^|;|\s)opacity\s*:\s*0*(\.0*)?(%)?\s*(;|!|$)/i.test(style)) return true
  const cls = (attrs.match(/\sclass\s*=\s*"([^"]*)"/i) || attrs.match(/\sclass\s*=\s*'([^']*)'/i) || [])[1] || ''
  const hiding = reading === 'seen' ? [...OUT_OF_VIEW_CLASSES, 'sr-only'] : OUT_OF_VIEW_CLASSES
  return cls.split(/\s+/).some((c) => hiding.includes(c.split(':').pop()))
}

/**
 * The text nodes of a built page as { start, end, text }, in source order, with text
 * inside an element taken out of the given reading left out (see takenOutOfView).
 * Positions are in `src`, so the text before and after a box can be taken from it.
 */
function renderedTextNodes(src, reading) {
  const stack = []
  const nodes = []
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  let last = 0
  const add = (from, to) => {
    if (to <= from || stack.some((e) => e.out)) return
    nodes.push({ start: from, end: to, text: src.slice(from, to) })
  }
  for (const m of src.matchAll(tagRe)) {
    add(last, m.index)
    last = m.index + m[0].length
    const tag = m[1].toLowerCase()
    const attrs = m[2] || ''
    if (m[0].startsWith('</')) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag)
      if (i >= 0) stack.length = i
      continue
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue
    stack.push({ tag, out: takenOutOfView(attrs, reading) })
  }
  add(last, src.length)
  return nodes
}

/**
 * Each element carrying `attribute`, with the text a reader can see in it:
 * text inside a hidden descendant is left out, and an element inside a hidden
 * ancestor (or hidden itself) has no visible text at all. Comments, scripts,
 * templates, <noscript>, <style> and <title> never count.
 */
export function visibleMarked(html, attribute) {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|template|noscript|title|style)\b[\s\S]*?<\/\1>/gi, ' ')
  const marker = new RegExp(`\\s${attribute}(\\s|=|/|$)`, 'i')
  const stack = [] // { tag, hidden, mark }
  const out = []
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  let last = 0
  const addText = (text) => {
    if (!text.trim()) return
    const hidden = stack.some((e) => e.hidden)
    for (const e of stack) if (e.mark && !hidden) e.mark.text += text
  }
  for (const m of src.matchAll(tagRe)) {
    addText(src.slice(last, m.index))
    last = m.index + m[0].length
    const tag = m[1].toLowerCase()
    const attrs = m[2] || ''
    if (m[0].startsWith('</')) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag)
      if (i >= 0) stack.length = i
      continue
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue
    const entry = { tag, hidden: hidesElement(attrs), mark: null }
    if (marker.test(attrs)) {
      entry.mark = { text: '' }
      out.push(entry.mark)
    }
    stack.push(entry)
  }
  addText(src.slice(last))
  return out.map((o) => decodeEntities(o.text).replace(/\s+/g, ' ').trim())
}

/**
 * Pre-launch statement (Tom, 2026-11-06, PR #9): the page describes the
 * finished product in the present tense, so it must say, visibly, that
 * LocalNodes hasn't launched. Passes when at least one element carrying the
 * rule's attribute (`data-prelaunch`) shows the phrase to a reader: not in a
 * comment, not hidden by an attribute, aria-hidden, an inline style or a
 * hiding utility class, on it or on any ancestor (Codex P2).
 */
export function prelaunchProblems(html, rule) {
  const phrase = rule.phrase.toLowerCase()
  if (visibleMarked(html, rule.attribute).some((t) => t.toLowerCase().includes(phrase))) return []
  return [`no pre-launch statement: no visible element with ${rule.attribute} saying "${rule.phrase}"`]
}

// Scripted example amounts in the home page's fund window.
// The price rule is the one rule these amounts are exempt from, and only when
// each amount is a slot (data-demo-amount) alone in a box (data-demo-amount-box,
// a div, p, dd, td, li or output) inside the section with id="fund", the path
// is one of the three below, the field is a number in app/data/home-demo.json,
// and the slot text is "$" plus that number grouped the en-US way. Everything
// else (a price anywhere else, a rate word next to a box, a changed amount)
// still fails. Meta tags get no exemption.
export const DEMO_AMOUNT_PATHS = ['fund.balanceBefore', 'fund.balanceAfter', 'fund.payment']
export const DEMO_DATA_FILE = 'app/data/home-demo.json'
const BOX_TAGS = new Set(['div', 'p', 'dd', 'td', 'li', 'output'])
const PRICE_PATTERN = '[$€£]\\s?\\d'
const ORPHAN_AFTER = /^\s*(\/|per\b|a month|monthly|\/mo|each)/i
const ORPHAN_BEFORE = /(price|cost|from|only)\s*:?\s*$/i

function plainText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Elements with their source ranges and ancestors (built page markup). */
function parseElements(src) {
  const stack = []
  const els = []
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  for (const m of src.matchAll(tagRe)) {
    const tag = m[1].toLowerCase()
    const attrs = m[2] || ''
    if (m[0].startsWith('</')) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag)
      if (i < 0) continue
      for (let j = stack.length - 1; j > i; j--) {
        stack[j].closeStart = m.index
        stack[j].closeEnd = m.index
      }
      stack[i].closeStart = m.index
      stack[i].closeEnd = m.index + m[0].length
      stack.length = i
      continue
    }
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(attrs)) continue
    const el = { tag, attrs, start: m.index, openEnd: m.index + m[0].length, closeStart: src.length, closeEnd: src.length, ancestors: stack.slice() }
    els.push(el)
    stack.push(el)
  }
  return els
}

function demoData(root) {
  const p = join(root, DEMO_DATA_FILE)
  if (!existsSync(p)) return { error: `${DEMO_DATA_FILE} is missing` }
  try {
    return { data: JSON.parse(readFileSync(p, 'utf8')) }
  } catch {
    return { error: `${DEMO_DATA_FILE} is not valid JSON` }
  }
}

function pathValue(data, path) {
  return path.split('.').reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), data)
}

/**
 * Check the demo amount slots in a built page. Returns { problems, stripped }:
 * the problems (each a string), and the page markup with every valid box
 * removed, for the price rule only.
 */
export function demoAmountCheck(html, root) {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|template|noscript|title|style)\b[\s\S]*?<\/\1>/gi, ' ')
  const slotAttr = /\sdata-demo-amount\s*=\s*"([^"]*)"/i
  const boxAttr = /\sdata-demo-amount-box(\s|=|\/|$)/i
  const els = parseElements(src)
  const slots = els.filter((e) => slotAttr.test(e.attrs))
  if (!slots.length) return { problems: [], stripped: html }

  const problems = []
  const loaded = demoData(root)
  if (loaded.error) problems.push(`demo amounts on the page but ${loaded.error}`)

  const readings = [renderedTextNodes(src, 'seen'), renderedTextNodes(src, 'heard')]
  const valid = []
  const contains = (outer, inner) => inner.start >= outer.openEnd && inner.start < outer.closeStart
  for (const s of slots) {
    const path = s.attrs.match(slotAttr)[1]
    const slotText = plainText(src.slice(s.openEnd, s.closeStart))
    const label = `demo amount "${path}" ("${slotText}")`
    const b = [...s.ancestors].reverse().find((a) => boxAttr.test(a.attrs))
    if (!b) {
      problems.push(`${label}: not alone in a data-demo-amount-box`)
      continue
    }
    if (!BOX_TAGS.has(b.tag)) {
      problems.push(`${label}: the box is a <${b.tag}>, not a div, p, dd, td, li or output`)
      continue
    }
    if (!b.ancestors.some((a) => /\sid\s*=\s*"fund"/i.test(a.attrs))) {
      problems.push(`${label}: not inside the section with id="fund"`)
      continue
    }
    if (slots.filter((o) => contains(b, o)).length !== 1) {
      problems.push(`${label}: the box holds more than one amount`)
      continue
    }
    const boxText = plainText(src.slice(b.openEnd, b.closeStart))
    if (boxText !== slotText) {
      problems.push(`${label}: the box text is "${boxText}", not only the amount`)
      continue
    }
    if (!DEMO_AMOUNT_PATHS.includes(path)) {
      problems.push(`${label}: ${path} is not one of ${DEMO_AMOUNT_PATHS.join(', ')}`)
      continue
    }
    if (loaded.error) continue
    const v = pathValue(loaded.data, path)
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      problems.push(`${label}: ${path} is not a number in ${DEMO_DATA_FILE}`)
      continue
    }
    const expected = `$${new Intl.NumberFormat('en-US').format(v)}`
    if (slotText !== expected) {
      problems.push(`${label}: the data says ${expected}`)
      continue
    }
    const orphan = readings.some((rendered) => {
      const before = plainText(rendered.filter((n) => n.end <= b.start).map((n) => n.text).join(' '))
      const after = plainText(rendered.filter((n) => n.start >= b.closeEnd).map((n) => n.text).join(' '))
      return ORPHAN_AFTER.test(after) || ORPHAN_BEFORE.test(before)
    })
    if (orphan) {
      problems.push(`${label}: a rate or price word sits next to the amount`)
      continue
    }
    valid.push(b)
  }

  // Remove each valid box by position.
  valid.sort((a, b) => a.start - b.start)
  let stripped = ''
  let at = 0
  for (const b of valid) {
    if (b.start < at) continue
    stripped += src.slice(at, b.start) + ' '
    at = b.closeEnd
  }
  stripped += src.slice(at)
  return { problems, stripped }
}

/** Every string value in a parsed JSON value. */
function jsonStrings(v, out = []) {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => jsonStrings(x, out))
  return out
}

/** One word list from the fixture as whole-word, case-insensitive regexes. */
export function wordList(entry) {
  return (entry?.patterns ?? []).map((p) => ({ p, re: new RegExp(`\\b(?:${p})\\b`, 'i') }))
}

/** Text with every launch-claims sentence taken out, word for word (whitespace-collapsed). */
export function withoutLaunchClaims(text, claims = LAUNCH_CLAIMS) {
  let t = text.replace(/\s+/g, ' ')
  for (const c of claims) t = t.split(c.text.replace(/\s+/g, ' ').trim()).join(' ')
  return t
}

/**
 * The "Who it's for" checks (rule 2c). `builtDirs` are the directories the
 * home page was found in; `rowChecks` runs rule 2's required claims on a page.
 */
function forPageChecks(root, fixture, builtDirs, voiceRules, fail, lines, rowChecks) {
  const spec = fixture.forPage
  if (!spec) return
  const lists = ['cryptoWords', 'priceWords', 'pendingTopicWords']
    .map((name) => ({ name, reason: fixture[name]?.reason ?? name, words: wordList(fixture[name]) }))
  const wordChecks = (file, text) => {
    for (const { name, reason, words } of lists) {
      const subject = name === 'pendingTopicWords' ? withoutLaunchClaims(text) : text
      for (const { p, re } of words) if (re.test(subject)) fail(file, p, `${name}: ${reason}`)
    }
  }

  // The data file: honesty bans, voice rules and the three lists on every string.
  const dataPath = join(root, spec.dataFile)
  if (existsSync(dataPath)) {
    let data
    try {
      data = JSON.parse(readFileSync(dataPath, 'utf8'))
    } catch {
      fail(spec.dataFile, 'invalid', 'the Who it\'s for data file is not valid JSON')
    }
    if (data !== undefined) {
      for (const str of jsonStrings(data)) {
        for (const row of findBannedHits(str, fixture.banned)) fail(spec.dataFile, row.pattern, `honesty bans: ${row.reason}`)
        for (const row of findBannedHits(str, voiceRules)) fail(spec.dataFile, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
        wordChecks(spec.dataFile, str)
      }
    }
  }

  // The sources: the three lists (the honesty bans and voice rules already
  // read every component in rule 1).
  for (const rel of spec.sources ?? []) {
    const p = join(root, rel)
    if (existsSync(p)) wordChecks(rel, stripCss(readFileSync(p, 'utf8')))
  }
  const pageSrc = join(root, spec.page)
  if (existsSync(pageSrc)) {
    const src = stripCss(readFileSync(pageSrc, 'utf8'))
    for (const row of findBannedHits(src, fixture.banned)) fail(spec.page, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(src, voiceRules)) fail(spec.page, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
  }

  // The built page.
  const built = builtDirs.map((d) => join(d, spec.builtRoute, 'index.html')).filter((p) => existsSync(p))
  if (!built.length) {
    if (existsSync(pageSrc)) fail(spec.page, `/${spec.builtRoute}`, `no built /${spec.builtRoute} page next to the built home page; run npm run build`)
    return
  }
  for (const builtPath of built) {
    const html = readFileSync(builtPath, 'utf8')
    const text = visibleText(html)
    const meta = metaText(html)
    const builtRel = relative(root, builtPath)
    lines.push(`CHECK ${builtRel}`)
    for (const row of findBannedHits(text, fixture.banned)) fail(builtRel, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(meta, fixture.banned)) fail(`${builtRel}: meta`, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(text, voiceRules)) fail(builtRel, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
    for (const row of findBannedHits(meta, voiceRules)) fail(`${builtRel}: meta`, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
    rowChecks(builtRel, html, text, meta)
    wordChecks(builtRel, text)
    wordChecks(`${builtRel}: meta`, meta)
  }
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

  // Rule 2's required claims, and the frame words, on one built page.
  const requiredChecks = (builtRel, html, text) => {
    for (const req of fixture.required) {
      if (req.id === 'licence') {
        for (const p of licenceProblems(text, req)) fail(builtRel, req.rule, p)
      } else if (req.id === 'prelaunch') {
        for (const p of prelaunchProblems(html, req)) fail(builtRel, req.rule, p)
      } else if (req.id === 'demo-label') {
        for (const p of demoLinkProblems(html, fixture.siteHost)) fail(builtRel, req.rule, p)
      }
    }
  }
  const frameChecks = (builtRel, text, meta) => {
    if (fixture.frameWordAllowed) return
    for (const w of fixture.frameWords) {
      const re = compileRow({ pattern: w, regex: false })
      if (re.test(text) || re.test(meta)) fail(builtRel, w, 'frame word on the landing page (D-14)')
    }
  }

  // 1. Honesty bans and voice and product rules in the landing sources.
  for (const file of landingSources(root)) {
    const src = stripCss(readFileSync(file, 'utf8'))
    for (const row of findBannedHits(src, fixture.banned)) fail(relative(root, file), row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(src, voiceRules)) fail(relative(root, file), row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
  }

  // 1b. The scripted demo strings: every string value in
  //     app/data/home-demo.json gets the honesty bans and the voice rules, with
  //     no exemption, whether or not the page has amount slots.
  const demo = demoData(root)
  if (demo.data) {
    for (const str of jsonStrings(demo.data)) {
      for (const row of findBannedHits(str, fixture.banned)) fail(DEMO_DATA_FILE, row.pattern, `honesty bans: ${row.reason}`)
      for (const row of findBannedHits(str, voiceRules)) fail(DEMO_DATA_FILE, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
    }
  } else if (existsSync(join(root, DEMO_DATA_FILE))) {
    fail(DEMO_DATA_FILE, 'invalid', 'the demo data file is not valid JSON')
  }

  const builtDirs = []
  for (const builtPath of resolved.paths) {
    builtDirs.push(dirname(builtPath))
    const html = readFileSync(builtPath, 'utf8')
    const text = visibleText(html)
    const meta = metaText(html)
    const builtRel = relative(root, builtPath)
    lines.push(`CHECK ${builtRel}`)

    // Banned claims on the built page (visible text, meta). Boxed demo amounts
    // are taken out of the text for the price rule only.
    const amounts = demoAmountCheck(html, root)
    for (const p of amounts.problems) fail(builtRel, 'demo amount', p)
    const priceText = amounts.stripped === html ? text : visibleText(amounts.stripped)
    for (const row of fixture.banned) {
      const subject = row.pattern === PRICE_PATTERN ? priceText : text
      if (compileRow(row).test(subject)) fail(builtRel, row.pattern, `honesty bans: ${row.reason}`)
    }
    for (const row of findBannedHits(meta, fixture.banned)) fail(`${builtRel}: meta`, row.pattern, `honesty bans: ${row.reason}`)
    for (const row of findBannedHits(text, voiceRules)) fail(builtRel, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)
    for (const row of findBannedHits(meta, voiceRules)) fail(`${builtRel}: meta`, row.pattern, `voice and product rules, ${row.rule}: ${row.reason}`)

    // 2. Required claims on the built page.
    requiredChecks(builtRel, html, text, meta)

    // 2b. Every pending home page promise (shared/launch-claims.mjs) is on the
    //     built page word for word, so a reworded or removed sentence can't
    //     slip out of the list that keeps sign-ups closed.
    for (const c of missingClaims(text, LAUNCH_CLAIMS)) {
      fail(builtRel, `launch claim "${c.id}"`, `not on the page word for word: "${c.text}". Update shared/launch-claims.mjs with the page`)
    }

    frameChecks(builtRel, text, meta)
  }

  // 2c. The "Who it's for" page, its data file and its sources.
  forPageChecks(root, fixture, builtDirs, voiceRules, fail, lines, (rel, html, text, meta) => {
    requiredChecks(rel, html, text, meta)
    frameChecks(rel, text, meta)
  })

  // 3. Sign-up pages and mail copy: no frame or buyer words (D-05) and none of
  //    the voice and product rules, PLACE-01 included (D-22). The source lists
  //    are signupSources (pages and components) and mailSources (the mail
  //    strings the Nuxt side sends). A listed file that is not there is skipped,
  //    so a plan can list a page before it builds it; a test checks every listed
  //    file exists today. Every FAIL line names the list and the file.
  const words = [
    ...fixture.frameWords.map((w) => ({ re: compileRow({ pattern: w, regex: false }), w, type: 'frame' })),
    ...fixture.buyerWords.map((w) => ({ re: new RegExp(w, 'i'), w, type: 'buyer' }))
  ]
  const signup = []
  const sourceLists = [
    { list: 'signupSources', where: 'sign-up flow', files: fixture.signupSources ?? [] },
    { list: 'mailSources', where: 'mail copy', files: fixture.mailSources ?? [] }
  ]
  for (const { list, where, files } of sourceLists) {
    for (const s of files) {
      const p = join(root, s)
      if (existsSync(p)) signup.push({ file: s, list, where, text: stripCss(readFileSync(p, 'utf8')) })
    }
  }
  for (const route of ['onboarding', 'success', 'cancel', 'invite', 'invite/verify']) for (const dir of builtDirs) {
    const p = join(dir, route, 'index.html')
    if (existsSync(p)) {
      const h = readFileSync(p, 'utf8')
      signup.push({ file: relative(root, p), list: 'signupSources (built page)', where: 'sign-up flow', text: `${visibleText(h)} \n ${metaText(h)}` })
    }
  }
  for (const { file, list, where, text: t } of signup) {
    for (const { re, w, type } of words) if (re.test(t)) fail(file, w, `${list}: ${type} word in the ${where} (D-05)`)
    for (const row of findBannedHits(t, voiceRules)) fail(file, row.pattern, `${list}: voice and product rules, ${row.rule}: ${row.reason}`)
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
