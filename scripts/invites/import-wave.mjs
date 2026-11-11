#!/usr/bin/env node
// Fill the invite list from the Resend early-access segment, one wave at a time
// (Phase 23, plan 23-24; Tom's decisions D-05 and D-07).
//
// Run by Tom or the orchestrator, never by the web app. It lists the contacts
// in the segment, keeps the ones whose group_kind property is one of the kinds
// asked for, and puts each on the invite list (Upstash Redis) through the same
// addInvite the app uses, so the keys are HMACs of the address and nothing is
// ever stored under a plain address. An address that already has an invite is
// left alone and counted as skipped. People who unsubscribed are never invited.
//
// Usage:
//   node scripts/invites/import-wave.mjs --wave 1 --kinds "Co-op,Online guild or DAO,Land trust" [--dry-run]
//
// Environment (all required; none is ever printed):
//   RESEND_API_KEY, RESEND_SEGMENT_ID,
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, INVITE_HASH_SECRET
//
// --dry-run reads the segment and the invite list and writes nothing.
//
// Output is counts only. The script never prints an email address, a key or a
// secret, and a Resend error is reported as its status code alone, because the
// error body can carry an address.
//
// The words in --kinds are the operator's way of sorting waves. They are never
// shown to a person (D-22 applies to screens and mails, not to this tool).
//
// Nothing here talks to a network when the module is imported: the work is in
// importWave and main, which take their Resend fetcher, Redis and invite
// functions as arguments, so tests/unit/invite-scripts.test.ts runs them offline.
// Only the default dependency builder at the bottom reaches the real services.
import { parseArgs as nodeParseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: node scripts/invites/import-wave.mjs --wave <label> --kinds "<kind>,<kind>" [--dry-run]'
const REQUIRED_ENV = ['RESEND_API_KEY', 'RESEND_SEGMENT_ID', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'INVITE_HASH_SECRET']
const RESEND = 'https://api.resend.com'
const PAGE_LIMIT = 100
const MAX_PAGES = 1000
const MAX_RETRIES = 3

class UsageError extends Error {}

/** Read the command line. Throws UsageError; the message never repeats what was typed. */
export function parseArgs(argv) {
  let values
  try {
    ;({ values } = nodeParseArgs({
      args: argv,
      options: { 'wave': { type: 'string' }, 'kinds': { type: 'string' }, 'dry-run': { type: 'boolean' } },
      strict: true,
      allowPositionals: false
    }))
  } catch {
    throw new UsageError('Unknown or malformed arguments.')
  }
  const wave = (values.wave ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(wave)) throw new UsageError('--wave is required: a short label such as 1 (letters, digits, . _ -).')
  const kinds = (values.kinds ?? '').split(',').map(k => k.trim()).filter(Boolean)
  if (kinds.length === 0) throw new UsageError('--kinds is required: the kinds of group this wave invites, separated by commas.')
  return { wave, kinds, dryRun: values['dry-run'] === true }
}

const norm = s => String(s).trim().toLowerCase()

/** The group_kind of a Resend contact, or undefined. Resend may give a plain value or { value }. */
function kindOf(contact) {
  const raw = contact?.properties?.group_kind
  const value = raw && typeof raw === 'object' ? raw.value : raw
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Fill the invite list from the segment. Returns counts only:
 * { seen, added, wouldAdd, skipped, otherKind, unsubscribed, failed }.
 * Throws an Error whose message is a Resend status code and nothing else if
 * Resend refuses; the caller prints that and stops.
 */
export async function importWave({ wave, kinds, dryRun }, deps) {
  const { redis, secret, apiKey, segmentId, invites } = deps
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const throttleMs = deps.throttleMs ?? 0
  const wanted = new Set(kinds.map(norm))
  const counts = { seen: 0, added: 0, wouldAdd: 0, skipped: 0, otherKind: 0, unsubscribed: 0, failed: 0, reasons: [] }
  // Why something failed, by error class and status code only: the message can name the address.
  const fail = (err) => {
    counts.failed++
    const status = err?.statusCode ?? err?.status
    const reason = `${typeof err?.name === 'string' ? err.name : 'Error'}${status ? ` ${status}` : ''}`
    if (!counts.reasons.includes(reason)) counts.reasons.push(reason)
  }

  let requests = 0
  async function get(path) {
    // Resend allows two requests a second: pause before every request but the first.
    if (requests++ > 0 && throttleMs > 0) await sleep(throttleMs)
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await deps.fetch(`${RESEND}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } })
      } catch {
        throw new Error('Resend request failed (no response)')
      }
      if (res.ok) return res.json()
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const wait = Number(res.headers?.get?.('retry-after'))
        await sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 1000)
        continue
      }
      // Status only: the response body can carry an address.
      throw new Error(`Resend responded ${res.status}`)
    }
  }

  const handled = new Set()
  let after
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ segment_id: segmentId, limit: String(PAGE_LIMIT) })
    if (after) q.set('after', after)
    const body = await get(`/contacts?${q}`)
    const list = Array.isArray(body?.data) ? body.data : []
    for (const listed of list) {
      counts.seen++
      if (listed?.unsubscribed === true) { counts.unsubscribed++; continue }
      let contact = listed
      // The list response may carry no properties: ask for the one contact.
      if (listed?.properties === undefined && listed?.id) {
        try { contact = await get(`/contacts/${encodeURIComponent(listed.id)}`) } catch (err) {
          if (/ 4(01|03)$/.test(err.message)) throw err
          fail(err)
          continue
        }
      }
      const kind = kindOf(contact)
      if (!kind || !wanted.has(norm(kind))) { counts.otherKind++; continue }
      const email = contact?.email ?? listed?.email
      if (typeof email !== 'string' || !email.includes('@')) { fail(new Error('contact without a usable address')); continue }
      try {
        const hmac = invites.emailKey(secret, email)
        if (handled.has(hmac) || await redis.hgetall(invites.inviteKey(hmac))) { counts.skipped++; continue }
        handled.add(hmac)
        if (dryRun) { counts.wouldAdd++; continue }
        await invites.addInvite(redis, secret, { email, kind: 'wave', wave })
        counts.added++
      } catch (err) {
        fail(err)
      }
    }
    if (body?.has_more !== true || list.length === 0) break
    after = list[list.length - 1]?.id
    if (!after) break
  }
  return counts
}

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`

/** Command-line entry. Returns the exit code; prints through io.out and io.err. */
export async function main(argv, env, io, makeDeps = defaultDeps) {
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    io.err(err instanceof UsageError ? err.message : 'Could not read the arguments.')
    io.err(USAGE)
    return 2
  }
  const missing = REQUIRED_ENV.filter(k => !env[k])
  if (missing.length) {
    io.err(`Missing environment variables: ${missing.join(', ')}`)
    io.err(USAGE)
    return 2
  }
  let counts
  try {
    counts = await importWave(args, await makeDeps(env))
  } catch (err) {
    io.err(`Import stopped: ${err instanceof Error ? err.message : 'unknown error'}`)
    return 1
  }
  io.out(args.dryRun ? `Wave ${args.wave}, dry run: nothing was written.` : `Wave ${args.wave}.`)
  io.out(args.dryRun ? n(counts.wouldAdd, 'invite would be added', 'invites would be added') : n(counts.added, 'invite added', 'invites added'))
  io.out(`${counts.skipped} skipped (already on the invite list)`)
  io.out(`${counts.otherKind} other (not in the chosen kinds, or no kind set)`)
  io.out(`${counts.unsubscribed} unsubscribed (never invited)`)
  if (counts.failed) io.out(`${counts.failed} failed (not written; run again to retry them): ${counts.reasons.join(', ')}`)
  io.out(`${counts.seen} contacts read`)
  return counts.failed ? 1 : 0
}

/** The real services. Reached only when the script is run, never by the tests. */
async function defaultDeps(env) {
  const [{ Redis }, { createJiti }] = await Promise.all([import('@upstash/redis'), import('jiti')])
  // The invite code is TypeScript: load the very module the app uses (no copy to drift).
  const inv = await createJiti(import.meta.url).import('../../server/utils/invites.ts')
  return {
    redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
    fetch: (url, init) => fetch(url, init),
    secret: env.INVITE_HASH_SECRET,
    apiKey: env.RESEND_API_KEY,
    segmentId: env.RESEND_SEGMENT_ID,
    invites: { addInvite: inv.addInvite, emailKey: inv.emailKey, inviteKey: inv.inviteKey },
    throttleMs: 600
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, { out: console.log, err: console.error })
}
