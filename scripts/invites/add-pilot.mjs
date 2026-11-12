#!/usr/bin/env node
// Add one pilot to the invite list, and optionally make that pilot's
// single-use promotion code (Phase 23, plan 23-24; Tom's decisions D-05 and D-06).
//
// Run by Tom or the orchestrator, never by the web app. The invite is written
// through the same addInvite the app uses (key = HMAC of the address, kind
// "pilot"). With --coupon, Stripe makes a promotion code on an existing 100%-off
// coupon: one redemption only, tagged with this invite's id, and the code and
// its Stripe id are stored on the invite. The checkout re-checks that binding
// before it takes the code (23-15).
//
// Usage:
//   node scripts/invites/add-pilot.mjs --email <address> [--coupon <coupon id>] [--template <id>] [--test] [--wave <label>] [--dry-run]
//
//   --coupon COUPON_ID  create a single-use promotion code on that Stripe coupon
//   --template ID       the community kind the site is built from: housing_coop,
//                       single_house, market or neighbourhood_association
//   --test              mark the invite as a test pilot (field "test"), for dry runs
//                       that must not count as a real pilot
//   --wave LABEL        wave label stored on the invite (default "pilot")
//   --dry-run           check everything, write and create nothing
//
// Environment (none is ever printed):
//   INVITE_HASH_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//   and STRIPE_SECRET_KEY when --coupon is used (not needed with --dry-run).
//
// An address with an open invite gets a fresh invite (a new id, so an older
// sign-in link stops working). An address whose invite was already used is
// refused: one site per invite.
//
// Output: the created code (that is the point of the tool) and counts. The
// script never prints the email address, a key or a secret, and an error from
// Stripe or Redis is reported by status code only, because those messages can
// carry the address. The address is only ever on the command line you typed.
//
// Nothing here talks to a network when the module is imported: addPilot and
// main take Redis, Stripe and the invite functions as arguments, so
// tests/unit/invite-scripts.test.ts runs them offline.
import { parseArgs as nodeParseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'Usage: node scripts/invites/add-pilot.mjs --email <address> [--coupon <coupon id>] [--template <id>] [--test] [--wave <label>] [--dry-run]'

// Must match COMMUNITY_TEMPLATES in server/utils/invites.ts; a test checks it.
// invites.ts is loaded only at run time (through jiti), so parseArgs checks
// --template against this copy offline.
export const COMMUNITY_TEMPLATES = ['housing_coop', 'single_house', 'market', 'neighbourhood_association']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

class UsageError extends Error {}

/** Read the command line. Throws UsageError; the message never repeats what was typed. */
export function parseArgs(argv) {
  let values
  try {
    ;({ values } = nodeParseArgs({
      args: argv,
      options: {
        'email': { type: 'string' },
        'coupon': { type: 'string' },
        'template': { type: 'string' },
        'test': { type: 'boolean' },
        'wave': { type: 'string' },
        'dry-run': { type: 'boolean' }
      },
      strict: true,
      allowPositionals: false
    }))
  } catch {
    throw new UsageError('Unknown or malformed arguments.')
  }
  const email = (values.email ?? '').trim()
  if (!EMAIL_RE.test(email) || email.length > 254) throw new UsageError('--email is required and must be one email address.')
  if (values.coupon !== undefined && !values.coupon.trim()) throw new UsageError('--coupon needs a Stripe coupon id.')
  const template = values.template === undefined ? '' : values.template.trim()
  if (values.template !== undefined && !COMMUNITY_TEMPLATES.includes(template)) {
    throw new UsageError(`--template must be one of: ${COMMUNITY_TEMPLATES.join(', ')}.`)
  }
  const wave = (values.wave ?? 'pilot').trim()
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(wave)) throw new UsageError('--wave must be a short label (letters, digits, . _ -).')
  return {
    email,
    coupon: values.coupon === undefined ? undefined : values.coupon.trim(),
    test: values.test === true,
    wave,
    dryRun: values['dry-run'] === true,
    template
  }
}

/** Status code of an error from Stripe or Redis, if it has one. Never the message. */
const statusOf = err => err?.statusCode ?? err?.status ?? undefined

/**
 * Add the pilot. Returns { inviteId, promoCode?, promoCodeId?, test, replaced, dryRun }.
 * Throws an Error with a message that never contains the address.
 */
export async function addPilot({ email, coupon, test, wave, dryRun, template }, deps) {
  const { redis, secret, stripe, invites } = deps
  const key = invites.inviteKey(invites.emailKey(secret, email))
  const existing = await redis.hgetall(key)
  if (existing && existing.status !== 'open') {
    throw new Error('That address already has a used invite. One site per invite: nothing was changed.')
  }
  const replaced = Boolean(existing)
  if (dryRun) return { inviteId: undefined, test, replaced, dryRun: true }

  const { inviteId } = await invites.addInvite(redis, secret, { email, kind: 'pilot', wave, communityTemplate: template ?? '' })
  const result = { inviteId, test, replaced, dryRun: false }
  if (test) await redis.hset(key, { test: true })

  if (coupon) {
    let promo
    try {
      promo = await stripe.promotionCodes.create(
        {
          promotion: { type: 'coupon', coupon },
          max_redemptions: 1,
          metadata: { invite_id: inviteId }
        },
        { idempotencyKey: `pilot-promo-${inviteId}` }
      )
    } catch (err) {
      const status = statusOf(err)
      throw new Error(`Stripe refused to create the promotion code${status ? ` (status ${status})` : ''}. The invite was added without a code: run again to replace it.`)
    }
    await redis.hset(key, { promoCodeId: promo.id, promoCode: promo.code })
    result.promoCodeId = promo.id
    result.promoCode = promo.code
  }
  return result
}

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
  const required = ['INVITE_HASH_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
  if (args.coupon && !args.dryRun) required.push('STRIPE_SECRET_KEY')
  const missing = required.filter(k => !env[k])
  if (missing.length) {
    io.err(`Missing environment variables: ${missing.join(', ')}`)
    io.err(USAGE)
    return 2
  }
  let result
  try {
    result = await addPilot(args, await makeDeps(env, args))
  } catch (err) {
    io.err(`Not done: ${err instanceof Error ? err.message : 'unknown error'}`)
    return 1
  }
  if (result.dryRun) {
    io.out('Dry run: nothing was written and no promotion code was created.')
    io.out(result.replaced ? 'An open invite exists for that address; a real run would replace it.' : 'No invite exists for that address; a real run would add one.')
    if (args.coupon) io.out('A real run would create one single-use promotion code on the chosen coupon.')
    if (args.test) io.out('A real run would mark the invite as a test pilot.')
    if (args.template) io.out(`A real run would store the community template ${args.template}.`)
    return 0
  }
  io.out('1 pilot invite added' + (result.replaced ? ' (replaced an open invite)' : '') + '.')
  if (args.test) io.out('Marked as a test pilot.')
  if (args.template) io.out(`Community template: ${args.template}.`)
  if (result.promoCode) {
    io.out(`Promotion code: ${result.promoCode}`)
    io.out('1 promotion code created: single use, bound to this invite.')
  }
  return 0
}

/** The real services. Reached only when the script is run, never by the tests. */
async function defaultDeps(env, args) {
  const [{ Redis }, { createJiti }] = await Promise.all([import('@upstash/redis'), import('jiti')])
  // The invite code is TypeScript: load the very module the app uses (no copy to drift).
  const inv = await createJiti(import.meta.url).import('../../server/utils/invites.ts')
  let stripe
  if (args.coupon && !args.dryRun) {
    const { default: Stripe } = await import('stripe')
    stripe = new Stripe(env.STRIPE_SECRET_KEY)
  }
  return {
    redis: new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }),
    secret: env.INVITE_HASH_SECRET,
    stripe,
    invites: { addInvite: inv.addInvite, emailKey: inv.emailKey, inviteKey: inv.inviteKey }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, { out: console.log, err: console.error })
}
