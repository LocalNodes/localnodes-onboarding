#!/usr/bin/env node
// Run before removing the site of a pilot that ended without a yes:
//
//   node scripts/pilot-removal.mjs <pilot subscription id>
//
// The end link still works for 30 days after the free end, unless the site is
// already removed (server/utils/pilot-late.ts): a late yes opens a Stripe
// payment page. This
// closes any payment page still open and marks the pilot as being removed, so
// the link answers "already ended" from now on and no one can pay for a site
// that is going away. It refuses when the organizer already paid on that page:
// that site stays. It changes nothing in Stripe except to expire an unpaid page.
//
// Settings, as scripts/reconcile-signups.mjs: the Stripe key and the Upstash
// Redis address and token from the environment. The key is never printed.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readEnv } from './reconcile-signups.mjs'

const SUB_RE = /^sub_[A-Za-z0-9]{8,64}$/

const SAY = {
  marked: 'Marked for removal. Any open payment page is closed; the link now says the pilot has ended. You can remove the site.',
  continued: 'Do not remove this site: the organizer paid on the payment page after the end.',
  busy: 'Someone is using the link right now. Try again in a minute.',
  'session-still-open': 'A payment page could not be closed. Nothing was marked; try again in a minute.'
}

/** Exit codes: 0 marked, 3 do not remove (paid), 1 anything else. */
export async function main(argv, env, io, deps) {
  const id = argv[0]
  if (argv.length !== 1 || !SUB_RE.test(String(id))) {
    io.err('Usage: node scripts/pilot-removal.mjs <pilot subscription id, sub_...>')
    return 1
  }
  const d = deps ?? await defaultDeps(env)
  if (!d) {
    io.err('Missing settings: the Stripe key and the Upstash Redis address and token.')
    return 1
  }
  let outcome
  try {
    outcome = await d.markLateRemoval(id, Math.floor(d.now() / 1000), { redis: d.redis, stripe: d.stripe, log: () => {} })
  } catch {
    io.err('Stripe or Redis could not be reached, or the record could not be read. Nothing was marked.')
    return 1
  }
  ;(outcome === 'marked' ? io.out : io.err)(SAY[outcome] ?? 'Unexpected answer. Nothing was marked.')
  return outcome === 'marked' ? 0 : outcome === 'continued' ? 3 : 1
}

async function defaultDeps(env) {
  const { stripeKey, redisUrl, redisToken } = readEnv(env)
  if (!stripeKey || !redisUrl || !redisToken) return null
  const [{ Redis }, { default: Stripe }, { createJiti }] = await Promise.all([import('@upstash/redis'), import('stripe'), import('jiti')])
  const { markLateRemoval } = await createJiti(import.meta.url).import('../server/utils/pilot-late.ts')
  return { redis: new Redis({ url: redisUrl, token: redisToken }), stripe: new Stripe(stripeKey), markLateRemoval, now: Date.now }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, { out: console.log, err: console.error })
}
