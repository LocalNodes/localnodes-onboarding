import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CLEAR_INDEX_SCRIPT,
  CREATE_SCRIPT,
  createArgs,
  createKeys,
  COUNT_FAILURE_SCRIPT,
  RECORD_SETUP_SCRIPT,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
  TRANSITION_SCRIPT,
  TRANSITIONS,
  clearIndexArgs,
  countFailureArgs,
  countFailureKeys,
  transitionArgs,
  transitionKeys,
  type TransitionName,
  type TransitionParams
} from '../../server/utils/lifecycle'
import { FakeRedis } from './helpers/fake-redis'
import { RELAYER_FUNDING_FINISH_SCRIPT, RELAYER_FUNDING_PENDING_SCRIPT } from '../../server/utils/relayer-funding'

/**
 * Lua parity (23-43, Task 1; Q-lua answered yes; T-23-206). Each vector runs
 * the real Lua script on a throwaway local Redis (the command named by
 * LN_LUA_REDIS_CLI, for example "docker exec ln-lua-parity redis-cli -n 9")
 * and the JS twin on FakeRedis, from the same seed, and compares the reply and
 * every key afterwards (type, value, lifetime to the second). Unset, the
 * describe is skipped. Never pointed at Upstash: 23-22 runs the scripts there
 * first.
 */

const CLI = process.env.LN_LUA_REDIS_CLI ?? ''

type Seed =
  | ['hset', string, Record<string, string>]
  | ['set', string, string]
  | ['zadd', string, number, string]
  | ['pexpire', string, number]

interface Vector {
  name: string
  seed: Seed[]
  script: string
  keys: string[]
  args: string[]
}

const DUMP = `
local out = {}
for _, k in ipairs(redis.call('KEYS', '*')) do
  local t = redis.call('TYPE', k)['ok']
  local v
  if t == 'hash' then v = redis.call('HGETALL', k)
  elseif t == 'zset' then v = redis.call('ZRANGE', k, 0, -1, 'WITHSCORES')
  else v = redis.call('GET', k) end
  out[#out + 1] = {k, t, v, redis.call('PTTL', k)}
end
return cjson.encode(out)
`

// Async (code review round 2): a synchronous exec per command blocked the vitest worker for over
// 60 s once the vectors passed 140, and vitest then reported an RPC timeout as an unhandled error.
const run = promisify(execFile)
async function cli(args: string[]): Promise<string> {
  const [cmd, ...pre] = CLI.split(' ').filter(Boolean)
  return (await run(cmd!, [...pre, ...args], { encoding: 'utf8' })).stdout.replace(/\n$/, '')
}

type KeyState = { type: string, value: unknown, ttl: number | 'none' }
const ttlOf = (pttl: number): number | 'none' => (pttl < 0 ? 'none' : Math.round(pttl / 1000))

function pairsToObject(flat: string[]): Record<string, string> {
  const o: Record<string, string> = {}
  for (let i = 0; i < flat.length; i += 2) o[flat[i]!] = flat[i + 1]!
  return o
}

async function realDump(): Promise<Record<string, KeyState>> {
  const parsed = JSON.parse(await cli(['EVAL', DUMP, '0'])) as unknown
  // cjson encodes an empty table as {}.
  const dumped = (Array.isArray(parsed) ? parsed : []) as Array<[string, string, unknown, number]>
  const state: Record<string, KeyState> = {}
  for (const [k, t, val, pttl] of dumped) {
    let value: unknown = val
    if (t === 'hash') value = pairsToObject(val as string[])
    if (t === 'zset') value = Object.fromEntries(Object.entries(pairsToObject(val as string[])).map(([m, sc]) => [m, Number(sc)]))
    state[k] = { type: t, value, ttl: ttlOf(pttl) }
  }
  return state
}

async function realRun(v: Vector): Promise<{ reply: string, state: Record<string, KeyState>, before: Record<string, KeyState> }> {
  await cli(['FLUSHDB'])
  for (const op of v.seed) {
    if (op[0] === 'hset') await cli(['HSET', op[1], ...Object.entries(op[2]).flat()])
    else if (op[0] === 'set') await cli(['SET', op[1], op[2]])
    else if (op[0] === 'zadd') await cli(['ZADD', op[1], String(op[2]), op[3]])
    else await cli(['PEXPIRE', op[1], String(op[2])])
  }
  const before = await realDump()
  const reply = await cli(['EVAL', v.script, String(v.keys.length), ...v.keys, ...v.args])
  return { reply, state: await realDump(), before }
}

async function fakeRun(v: Vector): Promise<{ reply: string, state: Record<string, KeyState> }> {
  const redis = new FakeRedis()
  const r = redis.atomic()
  for (const op of v.seed) {
    if (op[0] === 'hset') r.hset(op[1], Object.entries(op[2]))
    else if (op[0] === 'set') r.set(op[1], op[2], {})
    else if (op[0] === 'zadd') r.zadd(op[1], op[2], op[3])
    else r.pexpire(op[1], op[2])
  }
  let reply: string
  try {
    reply = String(await redis.eval(v.script, v.keys, v.args))
  } catch (err) {
    reply = `error: ${(err as Error).message}`
  }
  const state: Record<string, KeyState> = {}
  for (const k of redis.keys()) {
    const t = r.type(k)
    let value: unknown
    if (t === 'hash') value = Object.fromEntries(Object.entries((await redis.hgetall(k)) ?? {}).map(([f]) => [f, r.hget(k, f)]))
    else if (t === 'zset') value = Object.fromEntries((await redis.zrange(k, 0, -1)).map(m => [m, (redis as unknown as { store: Map<string, { zset: Map<string, number> }> }).store.get(k)!.zset.get(m)]))
    else value = r.get(k)
    state[k] = { type: t, value, ttl: ttlOf(r.pttl(k)) }
  }
  return { reply, state }
}

const SID = 'cs_test_parity'
const PID = 'PaRiTy0000000000000000'
const REC = `provision:${SID}`
const LOCK = `provision:${SID}:lifecycle`
const NOW = 1794225600000

function tv(name: string, seed: Seed[], tname: TransitionName, params: TransitionParams, fence = ''): Vector {
  const row = TRANSITIONS[tname]
  const built = row.build(params, NOW, SID)
  const spec = { ...built, from: row.from, guards: [...(built.guards ?? []), ...(params.guards ?? [])] }
  return { name, seed, script: TRANSITION_SCRIPT, keys: transitionKeys(SID, PID), args: transitionArgs(spec, SID, NOW, params.opId ?? 'op-1', fence) }
}

const readySeed: Seed[] = [
  ['hset', REC, { status: 'ready', provisionId: PID, attempt: '1', billing: 'charging', subdomain: 'cascadia' }],
  ['pexpire', REC, 86400000],
  ['set', `provision:by-id:${PID}`, SID],
  ['pexpire', `provision:by-id:${PID}`, 86400000],
  ['hset', `signup:${PID}`, { email: 'x@example.org' }],
  ['pexpire', `signup:${PID}`, 86400000],
  ['zadd', 'sweep:billing', 1, SID]
]

export const VECTORS: Vector[] = [
  tv('pending applies: counter, index, op id', readySeed, 'pending', { provisionId: PID, due: NOW + 60000 }),
  tv('pending replayed with the same op id writes nothing', [...readySeed, ['hset', REC, { lastOpId: 'op-1', billingTries: '1' }]], 'pending', { provisionId: PID, due: NOW + 60000 }),
  tv('held applies: record, signup link, sweep:held at heldUntil, out of sweep:billing, 72 h on all three keys', readySeed, 'held', { provisionId: PID, heldUntil: NOW + 3600000, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' }),
  tv('held with a wrong-type sweep:held (a string) is invalid and writes nothing', [...readySeed, ['set', 'sweep:held', 'oops']], 'held', { provisionId: PID, heldUntil: NOW + 3600000 }),
  tv('a counter that is not an integer is invalid and writes nothing', [...readySeed, ['hset', REC, { billingTries: '1.5' }]], 'pending', { provisionId: PID, due: NOW }),
  tv('a score that is not a number is invalid and writes nothing', readySeed, 'held', { provisionId: PID, heldUntil: 'soon' as unknown as number }),
  tv('a status outside the from-set is refused and writes nothing', [['hset', REC, { status: 'complete', provisionId: PID }]], 'held', { provisionId: PID, heldUntil: NOW }),
  tv('a missing record is refused and never created', [], 'pending', { provisionId: PID, due: NOW }),
  tv('a fence whose lock holds another token is lost', [...readySeed, ['set', LOCK, 'theirs']], 'pending', { provisionId: PID, due: NOW }, 'mine'),
  tv('a fence that holds applies', [...readySeed, ['set', LOCK, 'mine']], 'pending', { provisionId: PID, due: NOW }, 'mine'),
  tv('a failing guard is refused (paid is not paid twice)', [...readySeed, ['hset', REC, { billing: 'paid' }]], 'paid', { provisionId: PID, subscriptionId: 'sub_1' }),
  tv('a lifetime is raised, never lowered: a 5-day key keeps 5 days', [...readySeed, ['pexpire', REC, 432000000]], 'held', { provisionId: PID, heldUntil: NOW }),
  tv('ready writes readyAt once: an existing readyAt stays', [['hset', REC, { status: 'installing', provisionId: PID, attempt: '1', readyAt: 'earlier' }]], 'ready', { provisionId: PID, attempt: 1 }),
  tv('a late progress step on a complete, paid record is refused (HIGH 6)', [['hset', REC, { status: 'complete', provisionId: PID, attempt: '1', billing: 'paid', subscriptionId: 'sub_1' }]], 'progress', { provisionId: PID, attempt: 1, status: 'installing' }),
  tv('the retry step makes triggered, attempt plus one, in one step', [['hset', REC, { status: 'failed', provisionId: PID, attempt: '1', failedAttempts: '1', canRetry: 'true' }]], 'retry', { provisionId: PID, attempt: 1 }),
  tv('a second retry of the same attempt is refused', [['hset', REC, { status: 'triggered', provisionId: PID, attempt: '2', failedAttempts: '1', canRetry: 'false' }]], 'retry', { provisionId: PID, attempt: 1 }),
  tv('a record without a provision id never touches a placeholder key', [['hset', REC, { status: 'ready', attempt: '1' }]], 'held', { heldUntil: NOW, hostedInvoiceUrl: 'https://invoice.stripe.com/i/x' })
]

const building: Seed[] = [
  ['hset', REC, { status: 'installing', provisionId: PID, attempt: '1', failedAttempts: '0' }],
  ['pexpire', REC, 86400000],
  ['set', `provision:${SID}:lock`, 'locked'],
  ['pexpire', `provision:${SID}:lock`, 3600000]
]
const cf = (name: string, seed: Seed[], attempt: number, opId = 'op-c'): Vector => ({
  name,
  seed,
  script: COUNT_FAILURE_SCRIPT,
  keys: countFailureKeys(SID, PID, attempt),
  args: countFailureArgs(SID, { provisionId: PID, attempt, reason: 'deploy_failed' }, NOW, opId)
})
const ci = (name: string, seed: Seed[], index: 'billing' | 'held' | 'teardown' | 'stops' | 'refund', key: string): Vector => ({
  name,
  seed,
  script: CLEAR_INDEX_SCRIPT,
  keys: [REC, key],
  args: clearIndexArgs(index, SID)
})

VECTORS.push(
  cf('count failure: first failure counted, claim taken, lock freed, canRetry true', building, 1),
  cf('count failure: the second joins sweep:stops at now', [...building, ['hset', REC, { attempt: '2', failedAttempts: '1', countedAttempt: '1' }]], 2),
  cf('count failure: a claim already taken answers taken and counts nothing', [...building, ['set', `provision:${SID}:failed:1`, '1']], 1),
  cf('count failure: refused on a complete, paid sign-up (HIGH 6)', [['hset', REC, { status: 'complete', provisionId: PID, attempt: '1', billing: 'paid', subscriptionId: 'sub_1' }]], 1),
  cf('count failure: refused on a ready sign-up whose charge has not started (the status alone decides)', [['hset', REC, { status: 'ready', provisionId: PID, attempt: '1', failedAttempts: '0' }]], 1),
  cf('count failure: a failedAttempts that is not an integer is invalid', [...building, ['hset', REC, { failedAttempts: '1.5' }]], 1),
  cf('count failure: a wrong-type sweep:stops is invalid', [...building, ['set', 'sweep:stops', 'x']], 1),
  cf('count failure: a replayed op id answers its count and writes nothing', [...building, ['hset', REC, { lastOpId: 'op-c', failedAttempts: '1' }]], 1),
  ci('clear index: a ready record keeps its sweep:billing member', [['hset', REC, { status: 'ready' }], ['zadd', 'sweep:billing', 1, SID]], 'billing', 'sweep:billing'),
  ci('clear index: a complete record leaves sweep:billing', [['hset', REC, { status: 'complete' }], ['zadd', 'sweep:billing', 1, SID]], 'billing', 'sweep:billing'),
  ci('clear index: a gone record leaves sweep:held', [['zadd', 'sweep:held', 1, SID]], 'held', 'sweep:held'),
  ci('clear index: a failed record with a window open stays in sweep:stops', [['hset', REC, { status: 'failed', failedAttempts: '1', provisionalUntil: '5' }], ['zadd', 'sweep:stops', 1, SID]], 'stops', 'sweep:stops'),
  ci('clear index: a stopped record leaves sweep:stops', [['hset', REC, { status: 'failed', failedAttempts: '2', stopped: 'true' }], ['zadd', 'sweep:stops', 1, SID]], 'stops', 'sweep:stops'),
  ci('clear index: a provisionalUntil that is not a number is invalid', [['hset', REC, { status: 'failed', provisionalUntil: 'x' }], ['zadd', 'sweep:stops', 1, SID]], 'stops', 'sweep:stops'),
  ci('clear index: a wrong-type record is invalid and removes nothing', [['set', REC, 'x'], ['zadd', 'sweep:held', 1, SID]], 'held', 'sweep:held'),
  { name: 'renew: the holder\'s token renews', seed: [['set', LOCK, 'mine'], ['pexpire', LOCK, 1000]], script: RENEW_SCRIPT, keys: [LOCK], args: ['mine', '60000'] },
  { name: 'renew: another token is not renewed', seed: [['set', LOCK, 'theirs'], ['pexpire', LOCK, 1000]], script: RENEW_SCRIPT, keys: [LOCK], args: ['mine', '60000'] },
  { name: 'release: the holder\'s token deletes', seed: [['set', LOCK, 'mine']], script: RELEASE_SCRIPT, keys: [LOCK], args: ['mine'] },
  { name: 'release: never deletes another runner\'s lock', seed: [['set', LOCK, 'theirs']], script: RELEASE_SCRIPT, keys: [LOCK], args: ['mine'] }
)

// Task 2: the terminal rows, the hand-back, the flags and the teardown index rule.
const day: Seed[] = [['pexpire', REC, 86400000], ['set', `provision:by-id:${PID}`, SID], ['pexpire', `provision:by-id:${PID}`, 86400000], ['hset', `signup:${PID}`, { email: 'x@example.org' }], ['pexpire', `signup:${PID}`, 86400000]]
VECTORS.push(
  tv('tearingDownBuildFailed: failed twice, no money: tearing_down, out of sweep:stops, into sweep:teardown, 72 h', [['hset', REC, { status: 'failed', provisionId: PID, attempt: '2', failedAttempts: '2' }], ...day, ['zadd', 'sweep:stops', 1, SID]], 'tearingDownBuildFailed', { provisionId: PID }),
  tv('tearingDownBuildFailed is refused on a ready, charging sign-up (HIGH 3)', [['hset', REC, { status: 'ready', provisionId: PID, failedAttempts: '2', billing: 'charging' }], ...day], 'tearingDownBuildFailed', { provisionId: PID }),
  tv('tearingDownDeclined applies after the void', [['hset', REC, { status: 'declined', provisionId: PID, teardownReason: 'declined', billing: 'declined', stopInvoice: 'true' }], ...day, ['zadd', 'sweep:teardown', 1, SID]], 'tearingDownDeclined', { provisionId: PID }),
  tv('tearingDownDeclined is refused before the void', [['hset', REC, { status: 'declined', provisionId: PID, teardownReason: 'declined', billing: 'declined' }], ...day], 'tearingDownDeclined', { provisionId: PID }),
  tv('tearingDownHeldExpired applies after the void: out of sweep:held, into sweep:teardown', [['hset', REC, { status: 'held', provisionId: PID, billing: 'held', heldUntil: '5', stopInvoice: 'true' }], ...day, ['zadd', 'sweep:held', 5, SID]], 'tearingDownHeldExpired', { provisionId: PID }),
  tv('tornDown applies from tearing_down and joins sweep:teardown', [['hset', REC, { status: 'tearing_down', provisionId: PID, teardownReason: 'held_expired', tornDown: 'true' }], ...day], 'tornDown', { provisionId: PID, result: 'deleted', removedMailDue: true }),
  tv('tornDown is refused from declined', [['hset', REC, { status: 'declined', provisionId: PID, teardownReason: 'declined' }], ...day], 'tornDown', { provisionId: PID, result: 'deleted' }),
  tv('handBack from held: ready, billing paid, into sweep:billing, out of sweep:held and sweep:teardown, 72 h', [['hset', REC, { status: 'held', provisionId: PID, billing: 'held', pendingSubscriptionId: 'sub_1', invoiceId: 'in_1' }], ...day, ['zadd', 'sweep:held', 5, SID], ['zadd', 'sweep:teardown', 5, SID]], 'handBack', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', amountPaid: 4900, currency: 'usd' }),
  tv('handBack from declined applies', [['hset', REC, { status: 'declined', provisionId: PID, billing: 'declined', teardownReason: 'declined', pendingSubscriptionId: 'sub_1' }], ...day, ['zadd', 'sweep:teardown', 5, SID]], 'handBack', { provisionId: PID, subscriptionId: 'sub_1' }),
  tv('handBack is refused once the void is done (stopInvoice true)', [['hset', REC, { status: 'declined', provisionId: PID, billing: 'declined', stopInvoice: 'true' }], ...day], 'handBack', { provisionId: PID, subscriptionId: 'sub_1' }),
  tv('handBack is refused on a complete sign-up', [['hset', REC, { status: 'complete', provisionId: PID, billing: 'paid', subscriptionId: 'sub_1' }], ...day], 'handBack', { provisionId: PID, subscriptionId: 'sub_1' }),
  tv('teardownStep sets one done flag', [['hset', REC, { status: 'tearing_down', provisionId: PID, teardownReason: 'declined' }], ...day], 'teardownStep', { provisionId: PID, flag: 'stopApp', dispatchedAt: 7 }),
  tv('stopFinished with no app goes straight to torn_down', [['hset', REC, { status: 'tearing_down', provisionId: PID, teardownReason: 'build_failed' }], ...day], 'stopFinished', { provisionId: PID, reason: 'build_failed', noApp: true }),
  tv('teardownProblem stores the word and flags it for a person', [['hset', REC, { status: 'tearing_down', provisionId: PID, teardownReason: 'declined', tornDown: 'true' }], ...day], 'teardownProblem', { provisionId: PID, result: 'refused' }),
  tv('teardownResult stores the word and its time on a sign-up not tearing_down', [['hset', REC, { status: 'declined', provisionId: PID, teardownReason: 'declined' }], ...day], 'teardownResult', { provisionId: PID, result: 'deleted' }),
  tv('the flag row with no op id writes only the reconcile:flags entry', [['hset', REC, { status: 'torn_down', provisionId: PID }], ...day], 'flag', { provisionId: PID, kind: 'paid_after_void', opId: '' }),
  tv('heldUntilBad marks the record and flags it', [['hset', REC, { status: 'held', provisionId: PID, heldUntil: '' }], ...day], 'heldUntilBad', { provisionId: PID }),
  tv('removedMailSent clears the owed mail', [['hset', REC, { status: 'torn_down', provisionId: PID, removedMailDue: 'true' }], ...day, ['zadd', 'sweep:teardown', 5, SID]], 'removedMailSent', { provisionId: PID }),
  ci('clear index: a tearing_down record with steps left stays in sweep:teardown', [['hset', REC, { status: 'tearing_down', teardownReason: 'build_failed' }], ['zadd', 'sweep:teardown', 1, SID]], 'teardown', 'sweep:teardown'),
  ci('clear index: activation_failed with a subscription stays in sweep:teardown (Codex 3)', [['hset', REC, { status: 'tearing_down', teardownReason: 'activation_failed', subscriptionId: 'sub_1' }], ['zadd', 'sweep:teardown', 1, SID]], 'teardown', 'sweep:teardown'),
  ci('clear index: a tearing_down record whose steps all ran leaves sweep:teardown', [['hset', REC, { status: 'tearing_down', tornDown: 'true' }], ['zadd', 'sweep:teardown', 1, SID]], 'teardown', 'sweep:teardown'),
  ci('clear index: torn_down with the removed mail owed stays', [['hset', REC, { status: 'torn_down', tornDown: 'true', removedMailDue: 'true' }], ['zadd', 'sweep:teardown', 1, SID]], 'teardown', 'sweep:teardown'),
  ci('clear index: a ready, paid record leaves sweep:teardown', [['hset', REC, { status: 'ready', billing: 'paid', subscriptionId: 'sub_1' }], ['zadd', 'sweep:teardown', 1, SID]], 'teardown', 'sweep:teardown')
)

// --- Task 3 (23-43): the dedupe marker, the billing caps, CREATE_SCRIPT ---------------------------
const MARK = `dedupe:${PID}`
const marked: Seed[] = [...readySeed, ['hset', MARK, { checkoutSession: SID }], ['pexpire', MARK, 2592000000]]
const cr = (name: string, seed: Seed[], opId = 'op-create'): Vector => ({
  name,
  seed,
  script: CREATE_SCRIPT,
  keys: createKeys(SID, PID),
  args: createArgs({ sid: SID, provisionId: PID, subdomain: 'cascadia', now: NOW }, opId)
})
VECTORS.push(
  tv('charging writes subscribeAttempt and payAttempt once', [...readySeed, ['hset', REC, { billing: '', siteAnsweredAt: 'x' }]], 'charging', { provisionId: PID }),
  tv('pendingSubscription writes the subscription id on the dedupe marker in the same step', marked, 'pendingSubscription', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1 }),
  tv('pendingSubscription never creates a missing marker', readySeed, 'pendingSubscription', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1 }),
  tv('paid writes the invoice id on the marker', [...marked, ['hset', REC, { billing: 'pending', pendingSubscriptionId: 'sub_1' }]], 'paid', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1' }),
  tv('a marker of the wrong type (a string) is invalid and writes nothing', [...readySeed, ['set', MARK, 'x']], 'pendingSubscription', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1', subscriptionCreatedAt: 1 }),
  tv('pending is refused at billingTries 9 (the cap)', [...readySeed, ['hset', REC, { billing: 'pending', billingTries: '9' }]], 'pending', { provisionId: PID, due: NOW }),
  tv('triesExhausted at billingTries 9: rejected, tries, out of sweep:billing, flagged', [...readySeed, ['hset', REC, { billing: 'pending', billingTries: '9' }]], 'triesExhausted', { provisionId: PID }),
  tv('unclear counts both counters and stays pending', [...readySeed, ['hset', REC, { billing: 'pending', billingTries: '1' }]], 'unclear', { provisionId: PID, due: NOW + 60000, unclearTries: 0 }),
  tv('unclear is refused when unclearTries is not the one read', [...readySeed, ['hset', REC, { billing: 'pending', billingTries: '2', unclearTries: '1' }]], 'unclear', { provisionId: PID, due: NOW, unclearTries: 0 }),
  tv('review: billing review, flagged, out of sweep:billing, unclearTries 3', [...readySeed, ['hset', REC, { billing: 'pending', billingTries: '3', unclearTries: '2' }]], 'review', { provisionId: PID, kind: 'stripe_unclear', unclearTries: 2 }),
  tv('review for several matches counts nothing', readySeed, 'review', { provisionId: PID, kind: 'multiple_subscriptions' }),
  tv('pending is refused on billing review', [...readySeed, ['hset', REC, { billing: 'review' }]], 'pending', { provisionId: PID, due: NOW }),
  cr('create: by-id, the first hash, the marker and the build lock, with their lifetimes', []),
  cr('create: a record already there answers exists and writes nothing', [['hset', REC, { status: 'ready', provisionId: PID }]]),
  cr('create: the marker alone (the record expired) answers exists and writes nothing', [['hset', MARK, { checkoutSession: SID }], ['pexpire', MARK, 2592000000]]),
  cr('create: a re-run with the same op id answers replayed and writes nothing', [['hset', REC, { status: 'triggered', provisionId: PID, createOpId: 'op-create' }]]),
  cr('create: a wrong-type marker is invalid and writes nothing', [['set', MARK, 'x']]),
  cr('create: a wrong-type by-id is invalid and writes nothing', [['hset', `provision:by-id:${PID}`, { x: '1' }]])
)

// --- 23-43 Task 6 (and the orchestrator's addition): the probe, the window, the refund rows --------
const DAY = 86400000
const paidSeed: Seed[] = [
  ...readySeed,
  ['hset', REC, { billing: 'paid', subscriptionId: 'sub_1', invoiceId: 'in_1', amountPaid: '4900', currency: 'usd', activationDeadline: String(NOW - 1), siteAnsweredAt: 'x' }],
  ['hset', MARK, { checkoutSession: SID }],
  ['pexpire', MARK, 2592000000]
]
const refundingSeed: Seed[] = [...paidSeed, ['hset', REC, { status: 'refunding', teardownReason: 'activation_failed' }], ['zadd', 'sweep:refund', 1, SID]]
VECTORS.push(
  tv('paymentRecorded: one paid_in_review entry scored by the event time, the record untouched', [...readySeed, ['hset', REC, { billing: 'review' }]], 'paymentRecorded', { provisionId: PID, opId: '', eventId: 'evt_1', invoiceId: 'in_1', amount: 4900, eventAt: NOW - 5000 }),
  tv('charging is refused before the site answered the probe', [...readySeed, ['hset', REC, { billing: '' }]], 'charging', { provisionId: PID }),
  tv('ready writes readyAtMs once', [['hset', REC, { status: 'installing', provisionId: PID, attempt: '1' }], ['pexpire', REC, 86400000]], 'ready', { provisionId: PID, attempt: 1 }),
  tv('siteAnswered: fields only, once', [...readySeed, ['hset', REC, { billing: '' }]], 'siteAnswered', { provisionId: PID }),
  tv('probeTry: probeTries plus one, due 60 s later', [...readySeed, ['hset', REC, { billing: '' }]], 'probeTry', { provisionId: PID, due: NOW + 60000 }),
  tv('siteNeverAnswered after 24 h: flagged, out of sweep:billing, 72 h', [...readySeed, ['hset', REC, { billing: '', readyAtMs: String(NOW - DAY) }]], 'siteNeverAnswered', { provisionId: PID }),
  tv('siteNeverAnswered is refused before 24 h', [...readySeed, ['hset', REC, { billing: '', readyAtMs: String(NOW - DAY + 1) }]], 'siteNeverAnswered', { provisionId: PID }),
  tv('paid writes activationDeadline', [...readySeed, ['hset', REC, { billing: 'pending', pendingSubscriptionId: 'sub_1' }]], 'paid', { provisionId: PID, subscriptionId: 'sub_1', invoiceId: 'in_1' }),
  tv('activationTry has no cap', [...paidSeed, ['hset', REC, { activationTries: '400' }]], 'activationTry', { provisionId: PID, due: NOW + 60000 }),
  tv('refunding after the window: activation_failed, refund_started, into sweep:refund, out of sweep:billing', paidSeed, 'refunding', { provisionId: PID }),
  tv('refunding is refused inside the window', [...paidSeed, ['hset', REC, { activationDeadline: String(NOW + 1) }]], 'refunding', { provisionId: PID }),
  tv('refunding is refused on an activated sign-up', [...paidSeed, ['hset', REC, { activatedAt: 'x' }]], 'refunding', { provisionId: PID }),
  tv('complete is refused on refunding', refundingSeed, 'complete', { provisionId: PID }),
  tv('refundSucceeded writes refundId on the record and the marker', refundingSeed, 'refundSucceeded', { provisionId: PID, refundId: 're_1' }),
  tv('refundPending keeps refunding, due later', refundingSeed, 'refundPending', { provisionId: PID, refundId: 're_1', due: NOW + 60000 }),
  tv('refundProblem: flagged, still in sweep:refund (R3-1)', refundingSeed, 'refundProblem', { provisionId: PID, kind: 'partial', refundId: 're_1' }),
  tv('refundSucceeded is refused after a refund problem', [...refundingSeed, ['hset', REC, { refundProblem: 'failed' }]], 'refundSucceeded', { provisionId: PID, refundId: 're_1' }),
  tv('refundZero marks the zero invoice done', refundingSeed, 'refundZero', { provisionId: PID }),
  tv('refundInvoice records the recovered invoice', refundingSeed, 'refundInvoice', { provisionId: PID, invoiceId: 'in_2', amountPaid: 4900, currency: 'usd' }),
  tv('refundCancelled applies at the refund start, before refundDone, and raises the keys to 72 h (C1)', refundingSeed, 'refundCancelled', { provisionId: PID }),
  tv('refunded needs refundDone and refundCancelled', [...refundingSeed, ['hset', REC, { refundDone: 'true', refundCancelled: 'true' }]], 'refunded', { provisionId: PID }),
  tv('refunded is refused before the cancel', [...refundingSeed, ['hset', REC, { refundDone: 'true' }]], 'refunded', { provisionId: PID }),
  tv('tearingDownActivationFailed: out of sweep:refund, into sweep:teardown', [...refundingSeed, ['hset', REC, { status: 'refunded', refundDone: 'true', refundCancelled: 'true' }]], 'tearingDownActivationFailed', { provisionId: PID }),
  tv('lateActivation: the flag and the field only', refundingSeed, 'lateActivation', { provisionId: PID, opId: '' }),
  tv('lateActivation is refused on ready', paidSeed, 'lateActivation', { provisionId: PID, opId: '' }),
  // Orchestrator ruling (a), 23-43 Task 7: a zero invoice's late activation before the delete was asked for.
  tv('keepLateActivation: a free site that activated late is complete, out of every sweep, flagged kept', [...refundingSeed, ['hset', REC, { status: 'tearing_down', refundZero: 'true', refundDone: 'true', refundCancelled: 'true', lateActivation: 'true', stopMail: 'true' }], ['zadd', 'sweep:teardown', 1, SID]], 'keepLateActivation', { provisionId: PID, undone: 'cancel,card', mail: 'sent' }),
  tv('keepLateActivation is refused once the delete was asked for', [...refundingSeed, ['hset', REC, { status: 'tearing_down', refundZero: 'true', refundDone: 'true', lateActivation: 'true', dispatchAskedAt: 'x' }]], 'keepLateActivation', { provisionId: PID, undone: 'none', mail: 'none' }),
  tv('keepLateActivation is refused without refundZero', [...refundingSeed, ['hset', REC, { lateActivation: 'true' }]], 'keepLateActivation', { provisionId: PID, undone: 'none', mail: 'none' }),
  tv('intent for a dispatch marks dispatchAskedAt', refundingSeed, 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok' })
)
VECTORS.push(
  ci('clear index: a refunding record keeps its sweep:refund member', refundingSeed, 'refund', 'sweep:refund'),
  ci('clear index: a refund problem not yet settled keeps its sweep:refund member (R3-1)', [...refundingSeed, ['hset', REC, { refundProblem: 'failed', refundCancelled: 'true' }]], 'refund', 'sweep:refund'),
  ci('clear index: a settled refund problem leaves sweep:refund', [...refundingSeed, ['hset', REC, { refundProblem: 'failed', refundCancelled: 'true', refundSettledAt: 'x' }]], 'refund', 'sweep:refund')
)

// --- Code review fix round 1, C1: refund floors and the 7-day pending flag -------------------------
const WEEK = 7 * DAY
VECTORS.push(
  tv('refundPending raises the three keys to 72 h (C1)', [...refundingSeed, ['pexpire', REC, 3600000]], 'refundPending', { provisionId: PID, refundId: 're_1', refundStatus: 'pending', due: NOW + 60000 }),
  tv('refundPendingStale after 7 days: one refund_problem:{sid}:pending entry, refundStaleAt, still refunding and in sweep:refund (C1)', [...refundingSeed, ['hset', REC, { refundId: 're_1', refundStatus: 'pending', refundingAtMs: String(NOW - WEEK) }]], 'refundPendingStale', { provisionId: PID }),
  tv('refundPendingStale is refused before 7 days', [...refundingSeed, ['hset', REC, { refundId: 're_1', refundingAtMs: String(NOW - WEEK + 1) }]], 'refundPendingStale', { provisionId: PID }),
  tv('refundPendingStale is refused once raised (refundStaleAt set)', [...refundingSeed, ['hset', REC, { refundingAtMs: String(NOW - WEEK), refundStaleAt: 'x' }]], 'refundPendingStale', { provisionId: PID }),
  tv('refundPendingStale is refused without refundingAtMs', refundingSeed, 'refundPendingStale', { provisionId: PID }),
  tv('refundProblem raises the keys to 72 h (C1)', [...refundingSeed, ['pexpire', REC, 3600000]], 'refundProblem', { provisionId: PID, kind: 'failed', refundId: 're_1' })
)

// --- Code review fix round 1, C2: the dispatch intent is the one keep-or-delete decision -----------
const lateZero: Seed[] = [...refundingSeed, ['hset', REC, { status: 'tearing_down', refundZero: 'true', refundDone: 'true', refundCancelled: 'true', lateActivation: 'true' }]]
VECTORS.push(
  tv('C2: a dispatch intent is refused while lateActivation is set on a zero charge, and writes nothing', lateZero, 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok' }),
  tv('C2: a dispatch intent applies on a paid sign-up with a late 200 (no refundZero)', [...refundingSeed, ['hset', REC, { status: 'tearing_down', refundDone: 'true', refundCancelled: 'true', lateActivation: 'true' }]], 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok' }),
  tv('C2: a dispatch intent applies on a zero charge with no late 200', [...refundingSeed, ['hset', REC, { status: 'tearing_down', refundZero: 'true', refundDone: 'true' }]], 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok' }),
  tv('C2: a mail intent is not held by a late 200', lateZero, 'intent', { provisionId: PID, op: 'mail', key: 'refund-mail-x', token: 'tok' }),
  tv('C2: a notboth guard with no second field is invalid and writes nothing', lateZero, 'flag', { provisionId: PID, kind: 'late_activation', guards: [['lateActivation', 'notboth', '']] }),
  tv('C2: notboth holds when the second field is not true', [...lateZero, ['hset', REC, { refundZero: 'false' }]], 'flag', { provisionId: PID, kind: 'late_activation', guards: [['lateActivation', 'notboth', 'refundZero']] })
)

// --- Code review fix round 1, C5: the per-callback key of a build callback -------------------------
const cbBuilding: Seed[] = [['hset', REC, { status: 'creating_user', provisionId: PID, attempt: '1' }], ['pexpire', REC, 86400000]]
VECTORS.push(
  tv('C5: a progress callback writes its cbSeen:{attempt}:{status} key', [['hset', REC, { status: 'provisioning', provisionId: PID, attempt: '1' }], ['pexpire', REC, 86400000]], 'progress', { provisionId: PID, attempt: 1, status: 'installing' }),
  tv('C5: installing again after creating_user is refused and writes nothing', [...cbBuilding, ['hset', REC, { 'cbSeen:1:installing': 'x' }]], 'progress', { provisionId: PID, attempt: 1, status: 'installing', opId: 'op-a' }),
  tv('C5: the same status of the next attempt applies', [...cbBuilding, ['hset', REC, { attempt: '2', 'cbSeen:1:installing': 'x' }]], 'progress', { provisionId: PID, attempt: 2, status: 'installing' }),
  tv('C5: a ready already seen for this attempt is refused', [...cbBuilding, ['hset', REC, { 'cbSeen:1:ready': 'x' }]], 'ready', { provisionId: PID, attempt: 1 })
)

// --- Code review round 2: R2-1 (refundTick, refundCancelStale, the intent floor) and R2-2 (the dispatch retry) ---
const recorded: Seed[] = [...lateZero, ['hset', REC, { dispatchAskedAt: 'x' }]]
VECTORS.push(
  tv('R2-1: refundTick raises the three keys to 72 h and writes nothing else', [...refundingSeed, ['pexpire', REC, 3600000]], 'refundTick', { provisionId: PID }),
  tv('R2-1: refundTick is refused outside a refund state', paidSeed, 'refundTick', { provisionId: PID }),
  tv('R2-1: an intent raises the keys to 72 h', [...refundingSeed, ['pexpire', REC, 3600000]], 'intent', { provisionId: PID, op: 'cancel', key: 'cancel:sub_1', token: 'tok' }),
  tv('R2-1: refundCancelStale after 7 days: one refund_problem:{sid}:cancel entry, refundCancelStaleAt', [...refundingSeed, ['hset', REC, { refundDone: 'true', refundingAtMs: String(NOW - WEEK) }]], 'refundCancelStale', { provisionId: PID }),
  tv('R2-1: refundCancelStale is refused before 7 days', [...refundingSeed, ['hset', REC, { refundingAtMs: String(NOW - WEEK + 1) }]], 'refundCancelStale', { provisionId: PID }),
  tv('R2-1: refundCancelStale is refused once the cancel is done', [...refundingSeed, ['hset', REC, { refundCancelled: 'true', refundingAtMs: String(NOW - WEEK) }]], 'refundCancelStale', { provisionId: PID }),
  tv('R2-1: refundCancelStale is refused once raised', [...refundingSeed, ['hset', REC, { refundingAtMs: String(NOW - WEEK), refundCancelStaleAt: 'x' }]], 'refundCancelStale', { provisionId: PID }),
  tv('R2-1: refundCancelStale on a refund problem applies at once', [...refundingSeed, ['hset', REC, { refundProblem: 'failed', refundingAtMs: String(NOW) }]], 'refundCancelStale', { provisionId: PID, problem: true }),
  tv('R2-2: a retry of a recorded dispatch applies despite a late 200 on a zero charge', recorded, 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok', retry: true }),
  tv('R2-2: a retry without a recorded dispatch is refused', lateZero, 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok', retry: true }),
  tv('R2-2: a first dispatch on a recorded one is still refused by notboth', recorded, 'intent', { provisionId: PID, op: 'dispatch', key: 'teardown:x', token: 'tok' })
)

// --- Code review round 3 (the confirming pass): R3-1, refundProblemSettled ---
const problemSeed: Seed[] = [...refundingSeed, ['hset', REC, { refundProblem: 'partial' }]]
VECTORS.push(
  tv('R3-1: refundProblemSettled with the cancel done: refundSettledAt, out of sweep:refund, the keys raised', [...problemSeed, ['hset', REC, { refundCancelled: 'true' }], ['pexpire', REC, 3600000]], 'refundProblemSettled', { provisionId: PID }),
  tv('R3-1: refundProblemSettled is refused while the cancel is not done', problemSeed, 'refundProblemSettled', { provisionId: PID }),
  tv('R3-1: refundProblemSettled is refused without a refund problem', [...refundingSeed, ['hset', REC, { refundCancelled: 'true' }]], 'refundProblemSettled', { provisionId: PID }),
  tv('R3-1: refundProblemSettled is refused once settled', [...problemSeed, ['hset', REC, { refundCancelled: 'true', refundSettledAt: 'x' }]], 'refundProblemSettled', { provisionId: PID }),
  tv('R3-1: refundCancelled applies on a refund problem', problemSeed, 'refundCancelled', { provisionId: PID }),
  tv('R3-1: refundTick applies on a refund problem', [...problemSeed, ['pexpire', REC, 3600000]], 'refundTick', { provisionId: PID })
)

// --- Code review round 3: R3-2, refundTick moves the served sign-up to the back of sweep:refund ---
VECTORS.push(
  tv('R3-2: refundTick with a due time re-scores the sweep:refund member and raises the keys', [...refundingSeed, ['pexpire', REC, 3600000]], 'refundTick', { provisionId: PID, due: NOW + 5 }),
  tv('R3-2: refundTick with a due time on a refund problem not yet settled applies', problemSeed, 'refundTick', { provisionId: PID, due: NOW + 5 }),
  tv('R3-2: refundTick with a due time is refused on a settled refund problem', [...paidSeed, ['hset', REC, { status: 'refunding', teardownReason: 'activation_failed', refundProblem: 'partial', refundCancelled: 'true', refundSettledAt: 'x' }]], 'refundTick', { provisionId: PID, due: NOW + 5 })
)

// --- Code review fix round 1, C6: the checkout redelivery's write and raise in one step ----------
const SIGNUP = `signup:${PID}`
const rs = (name: string, seed: Seed[], args: string[] = ['cus_1', 'seti_1', '172800000']): Vector => ({ name, seed, script: RECORD_SETUP_SCRIPT, keys: [SIGNUP], args })
VECTORS.push(
  rs('recordSetup: both ids written, a 1 h signup raised to 48 h', [['hset', SIGNUP, { email: 'x@example.org' }], ['pexpire', SIGNUP, 3600000]]),
  rs('recordSetup: a 72 h signup keeps 72 h (raise only)', [['hset', SIGNUP, { email: 'x@example.org' }], ['pexpire', SIGNUP, 259200000]]),
  rs('recordSetup: a signup with no lifetime is left with none', [['hset', SIGNUP, { email: 'x@example.org' }]]),
  rs('recordSetup: a missing signup answers none and is never made', []),
  rs('recordSetup: a wrong-type signup is invalid and writes nothing', [['set', SIGNUP, 'x']]),
  rs('recordSetup: an empty id is invalid and writes nothing', [['hset', SIGNUP, { email: 'x@example.org' }]], ['', 'seti_1', '172800000']),
  rs('recordSetup: a lifetime that is not a positive integer is invalid', [['hset', SIGNUP, { email: 'x@example.org' }]], ['cus_1', 'seti_1', '0'])
)

// --- The practice relayer's funding record ------------------------------------
const FUND = `relayer-funding:${PID}`
const H1 = `0x${'a'.repeat(64)}`
const H2 = `0x${'b'.repeat(64)}`
const PHASH = `provision:${SID}`
const pendingArgs = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40), '100000000000000000', '7', H1, '0x02f87001', '1700000000000', PID, 'ready', 'complete']
const readySignup = { provisionId: PID, status: 'ready', relayerAddress: '0x' + '1'.repeat(40) }
const pendingRec = { state: 'pending', to: '0x' + '1'.repeat(40), from: '0x' + '2'.repeat(40), amountWei: '100000000000000000', nonce: '7', txHash: H1, rawTx: '0x02f87001', pendingAt: '1700000000000' }
const fp = (name: string, seed: Seed[], signup: Record<string, string> | null = readySignup, args: string[] = pendingArgs): Vector => ({ name, seed: signup ? [['hset', PHASH, signup], ...seed] : seed, script: RELAYER_FUNDING_PENDING_SCRIPT, keys: [FUND, PHASH], args })
const ff = (name: string, seed: Seed[], args: string[]): Vector => ({ name, seed, script: RELAYER_FUNDING_FINISH_SCRIPT, keys: [FUND], args })
VECTORS.push(
  fp('relayerFunding pending: no record, written with no lifetime', []),
  fp('relayerFunding pending: a pending record exists, nothing written', [['hset', FUND, pendingRec]]),
  fp('relayerFunding pending: a sent record exists, nothing written', [['hset', FUND, { ...pendingRec, state: 'sent', sentAt: '1' }]]),
  fp('relayerFunding pending: a complete sign-up is fundable', [], { ...readySignup, status: 'complete' }),
  fp('relayerFunding pending: a sign-up turned declined is not fundable, nothing written', [], { ...readySignup, status: 'declined' }),
  fp('relayerFunding pending: another stored relayer address is not fundable', [], { ...readySignup, relayerAddress: '0x' + '3'.repeat(40) }),
  fp('relayerFunding pending: another provision id in the hash is not fundable', [], { ...readySignup, provisionId: 'Other00000000000000000' }),
  fp('relayerFunding pending: no sign-up hash is not fundable', [], null),
  fp('relayerFunding pending: one wei more than the fixed amount is refused, nothing written', [], readySignup, pendingArgs.map((x, i) => (i === 2 ? '100000000000000001' : x))),
  fp('relayerFunding pending: zero is refused, nothing written', [], readySignup, pendingArgs.map((x, i) => (i === 2 ? '0' : x))),
  ff('relayerFunding finish: pending to sent with the same hash', [['hset', FUND, pendingRec]], ['sent', H1, '1700000001000', '']),
  ff('relayerFunding finish: pending to stopped with the same hash and a code', [['hset', FUND, pendingRec]], ['stopped', H1, '1700000001000', 'nonce_taken']),
  ff('relayerFunding finish: another hash is refused', [['hset', FUND, pendingRec]], ['sent', H2, '1700000001000', '']),
  ff('relayerFunding finish: no record is refused', [], ['sent', H1, '1700000001000', '']),
  ff('relayerFunding finish: sent again is a repeat', [['hset', FUND, { ...pendingRec, state: 'sent', sentAt: '1' }]], ['sent', H1, '1700000002000', '']),
  ff('relayerFunding finish: stopped after sent is refused', [['hset', FUND, { ...pendingRec, state: 'sent', sentAt: '1' }]], ['stopped', H1, '1700000002000', 'nonce_taken']),
  ff('relayerFunding finish: sent after stopped is refused', [['hset', FUND, { ...pendingRec, state: 'stopped', stoppedAt: '1', stopCode: 'nonce_taken' }]], ['sent', H1, '1700000002000', ''])
)

describe.skipIf(!CLI)('Lua parity against a local Redis (LN_LUA_REDIS_CLI unset: skipped, nothing to compare)', () => {
  for (const v of VECTORS) {
    it(v.name, async () => {
      const real = await realRun(v)
      const fake = await fakeRun(v)
      expect(fake.reply).toBe(real.reply)
      // Lifetimes to within 2 s: the real key ages while redis-cli runs the seed (one docker exec per command).
      for (const [k, st] of Object.entries(real.state)) {
        const f = fake.state[k]
        if (f && typeof f.ttl === 'number' && typeof st.ttl === 'number' && Math.abs(f.ttl - st.ttl) <= 2) st.ttl = f.ttl
      }
      expect(fake.state).toEqual(real.state)
      // A refused, invalid, lost, taken, kept, replayed or exists vector writes nothing, on the real Redis itself (m36).
      if (/^(refused|invalid|lost|taken|kept|replayed|exists|none|0$)/.test(real.reply)) {
        for (const [k, st] of Object.entries(real.state)) {
          const b = real.before[k]
          if (b && typeof b.ttl === 'number' && typeof st.ttl === 'number' && Math.abs(b.ttl - st.ttl) <= 2) st.ttl = b.ttl
        }
        expect(real.state).toEqual(real.before)
      }
    })
  }
})
