// The funding record for a practice site's gas-sponsor wallet. The site
// repository's fund-practice-relayer.yml sends test ETH once to a
// practice site's relayer from the practice wallet, and keeps its record here,
// so that a second run, two runs at once, or a run whose broadcast reply was
// lost can never send a second time.
//
// The record is relayer-funding:{provisionId}, a hash with no lifetime (it
// must outlive the sign-up record: "sent" means never again for that site):
//   state     pending | sent | stopped
//   to        the relayer address, copied from the sign-up record by this app
//             (never from the request)
//   from      the practice wallet's public address
//   amountWei the amount, exactly RELAYER_FUNDING_AMOUNT_WEI (nothing else is accepted)
//   nonce     the transaction's nonce
//   txHash    keccak256 of rawTx
//   rawTx     the signed transaction, written BEFORE it is broadcast, so a lost
//             reply is followed by the same transaction, never a new one. A
//             signed transaction is public once sent; it holds no key.
//   pendingAt, sentAt, stoppedAt, stopCode
//
// Transitions, each one Lua step (with JS twins for the tests):
//   none -> pending (RELAYER_FUNDING_PENDING_SCRIPT: refused if any record exists or
//     the sign-up, read again inside the script, is no longer fundable)
//   pending -> sent | stopped (RELAYER_FUNDING_FINISH_SCRIPT: same txHash only)
// sent and stopped are final: no route changes them. A stopped record waits
// for a person (runbook, practice pilot sites).
//
// The bearer is hex HMAC-SHA256(secret, "relayer-funding:" + provision_id),
// not the callback token: the site itself holds its callback token
// (PROVISION_CALLBACK_TOKEN), and must not be able to write this record. The
// workflow derives the same value from PROVISION_CALLBACK_SECRET.
//
// Privacy rule: log lines hold fixed words only, never an id, an address or a hash.
import { createHmac, timingSafeEqual } from 'node:crypto'
import * as v from 'valibot'
import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import type { ScriptTwin } from './lifecycle'

/** The amount each practice relayer receives: exactly 0.1 test ETH. Any other amount is refused. */
export const RELAYER_FUNDING_AMOUNT_WEI = 100_000_000_000_000_000n

/** The stop codes the workflow may record. */
export const RELAYER_FUNDING_STOP_CODES = ['nonce_taken', 'tx_reverted'] as const

/** Sign-up states in which a first send may start (the site is built and reported ready). */
const FUNDABLE_STATUSES = new Set(['ready', 'complete'])

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-f]{64}$/
const RAW_TX = /^0x[0-9a-f]{2,2048}$/
const UINT = /^(0|[1-9]\d{0,30})$/

export const fundingKey = (provisionId: string) => `relayer-funding:${provisionId}`

/** hex HMAC-SHA256(secret, "relayer-funding:" + provision id). */
export function fundingToken(secret: string, provisionId: string): string {
  return createHmac('sha256', secret).update(`relayer-funding:${provisionId}`).digest('hex')
}

function hasValidFundingToken(authHeader: string | undefined, provisionId: string, secret: string): boolean {
  if (!secret || !authHeader || !authHeader.startsWith('Bearer ')) return false
  const given = Buffer.from(authHeader.slice('Bearer '.length))
  const expected = Buffer.from(fundingToken(secret, provisionId))
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

/**
 * none -> pending. KEYS: record, the sign-up's provision hash. ARGV: to, from,
 * amountWei, nonce, txHash, rawTx, at, provisionId, then the fundable statuses.
 * The sign-up is checked again inside the script (same provision id, a fundable
 * status, the same stored relayer address), so a sign-up that turns declined
 * or failed after the handler read it is never funded. The amount must be
 * exactly RELAYER_FUNDING_AMOUNT_WEI, checked here too.
 * Answers 1 written, 0 a record already exists, 3 not fundable, 4 not the
 * fixed amount (nothing written for 0, 3 or 4).
 */
export const RELAYER_FUNDING_PENDING_SCRIPT = `if ARGV[3] ~= '${RELAYER_FUNDING_AMOUNT_WEI}' then
  return 4
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
if redis.call('HGET', KEYS[2], 'provisionId') ~= ARGV[8] or redis.call('HGET', KEYS[2], 'relayerAddress') ~= ARGV[1] then
  return 3
end
local status = redis.call('HGET', KEYS[2], 'status')
local fundable = false
for i = 9, #ARGV do
  if status == ARGV[i] then
    fundable = true
  end
end
if not fundable then
  return 3
end
redis.call('HSET', KEYS[1], 'state', 'pending', 'to', ARGV[1], 'from', ARGV[2], 'amountWei', ARGV[3], 'nonce', ARGV[4], 'txHash', ARGV[5], 'rawTx', ARGV[6], 'pendingAt', ARGV[7])
return 1`

/**
 * pending -> sent | stopped. KEYS: record. ARGV: state (sent or stopped), txHash, at, stopCode.
 * Answers 1 written; 2 already in that state with that hash (a repeat, nothing
 * written); 0 refused (no record, another hash, or another final state).
 */
export const RELAYER_FUNDING_FINISH_SCRIPT = `local state = redis.call('HGET', KEYS[1], 'state')
local hash = redis.call('HGET', KEYS[1], 'txHash')
if hash ~= ARGV[2] then
  return 0
end
if state == ARGV[1] then
  return 2
end
if state ~= 'pending' then
  return 0
end
if ARGV[1] == 'sent' then
  redis.call('HSET', KEYS[1], 'state', 'sent', 'sentAt', ARGV[3])
else
  redis.call('HSET', KEYS[1], 'state', 'stopped', 'stoppedAt', ARGV[3], 'stopCode', ARGV[4])
end
return 1`

/** JavaScript stand-ins for the tests' in-memory Redis. */
export const RELAYER_FUNDING_TWINS: Array<[script: string, twin: ScriptTwin]> = [
  [RELAYER_FUNDING_PENDING_SCRIPT, (r, keys, args) => {
    if (args[2] !== String(RELAYER_FUNDING_AMOUNT_WEI)) return 4
    if (r.exists(keys[0]!) === 1) return 0
    if (r.hget(keys[1]!, 'provisionId') !== args[7] || r.hget(keys[1]!, 'relayerAddress') !== args[0]) return 3
    if (!args.slice(8).includes(r.hget(keys[1]!, 'status') as string)) return 3
    r.hset(keys[0]!, [['state', 'pending'], ['to', args[0]!], ['from', args[1]!], ['amountWei', args[2]!], ['nonce', args[3]!], ['txHash', args[4]!], ['rawTx', args[5]!], ['pendingAt', args[6]!]])
    return 1
  }],
  [RELAYER_FUNDING_FINISH_SCRIPT, (r, keys, args) => {
    const state = r.hget(keys[0]!, 'state')
    const hash = r.hget(keys[0]!, 'txHash')
    if (hash !== args[1]) return 0
    if (state === args[0]) return 2
    if (state !== 'pending') return 0
    if (args[0] === 'sent') r.hset(keys[0]!, [['state', 'sent'], ['sentAt', args[2]!]])
    else r.hset(keys[0]!, [['state', 'stopped'], ['stoppedAt', args[2]!], ['stopCode', args[3]!]])
    return 1
  }]
]

export interface FundingRedis {
  get: (key: string) => Promise<unknown>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
}

export interface FundingDeps {
  redis: FundingRedis
  /** NUXT_PROVISION_CALLBACK_SECRET. */
  secret: string
  now?: () => number
  log?: (msg: string) => void
}

export interface FundingRecordView {
  state: string
  to: string
  from: string
  amount_wei: string
  nonce: string
  tx_hash: string
  raw_tx: string
  stop_code?: string
}

const UNAUTHORIZED = { status: 401 as const, body: { message: 'Unauthorized' as const } }
const isEmpty = (s: Record<string, unknown> | null): s is null => !s || Object.keys(s).length === 0
const str = (value: unknown) => (value === undefined || value === null ? '' : String(value))

function recordView(rec: Record<string, unknown> | null): FundingRecordView | null {
  if (isEmpty(rec)) return null
  const view: FundingRecordView = {
    state: str(rec.state),
    to: str(rec.to),
    from: str(rec.from),
    amount_wei: str(rec.amountWei),
    nonce: str(rec.nonce),
    tx_hash: str(rec.txHash),
    raw_tx: str(rec.rawTx)
  }
  if (str(rec.stopCode)) view.stop_code = str(rec.stopCode)
  return view
}

async function readSignup(provisionId: string, redis: FundingRedis): Promise<{ key: string, state: Record<string, unknown> } | null> {
  const sid = await redis.get(`provision:by-id:${provisionId}`)
  if (typeof sid !== 'string' || !sid) return null
  const key = `provision:${sid}`
  const state = await redis.hgetall(key)
  if (isEmpty(state) || String(state.provisionId) !== provisionId) return null
  return { key, state }
}

const relayerOf = (signup: Record<string, unknown> | null) => {
  const a = str(signup?.relayerAddress)
  return ADDRESS.test(a) ? a : ''
}

export type FundingCheckOutcome =
  | typeof UNAUTHORIZED
  | { status: 404, body: { message: 'Unknown provision' } }
  | { status: 200, body: { relayer_address: string, fundable: boolean, funding: FundingRecordView | null } }

/**
 * GET /api/relayer-funding?provision_id. The bearer is checked before any read.
 * The answer: the relayer address the sign-up app stored from the site's ready
 * (empty when there is none), whether a first send may start now, and the
 * funding record (null when there is none). A record is answered whatever the
 * sign-up's state, so a pending send is always reconciled. 404 only when there
 * is neither a sign-up nor a record.
 */
export async function handleFundingCheck(authHeader: string | undefined, provisionId: unknown, deps: FundingDeps): Promise<FundingCheckOutcome> {
  if (typeof provisionId !== 'string' || !PROVISION_ID_PATTERN.test(provisionId)) return UNAUTHORIZED
  if (!hasValidFundingToken(authHeader, provisionId, deps.secret)) return UNAUTHORIZED
  const record = recordView(await deps.redis.hgetall(fundingKey(provisionId)))
  const signup = (await readSignup(provisionId, deps.redis))?.state ?? null
  if (!signup && !record) return { status: 404, body: { message: 'Unknown provision' } }
  const relayer = relayerOf(signup)
  const fundable = Boolean(relayer) && FUNDABLE_STATUSES.has(str(signup?.status))
  return { status: 200, body: { relayer_address: relayer, fundable, funding: record } }
}

const pendingSchema = v.object({
  provision_id: v.pipe(v.string(), v.regex(PROVISION_ID_PATTERN)),
  action: v.literal('pending'),
  from: v.pipe(v.string(), v.regex(ADDRESS)),
  amount_wei: v.pipe(v.string(), v.regex(UINT)),
  nonce: v.pipe(v.string(), v.regex(UINT)),
  tx_hash: v.pipe(v.string(), v.regex(HASH)),
  raw_tx: v.pipe(v.string(), v.regex(RAW_TX))
})

const finishSchema = v.variant('action', [
  v.object({
    provision_id: v.pipe(v.string(), v.regex(PROVISION_ID_PATTERN)),
    action: v.literal('sent'),
    tx_hash: v.pipe(v.string(), v.regex(HASH))
  }),
  v.object({
    provision_id: v.pipe(v.string(), v.regex(PROVISION_ID_PATTERN)),
    action: v.literal('stopped'),
    tx_hash: v.pipe(v.string(), v.regex(HASH)),
    code: v.picklist([...RELAYER_FUNDING_STOP_CODES])
  })
])

export type FundingWriteOutcome =
  | typeof UNAUTHORIZED
  | { status: 400, body: { message: 'Invalid request' } }
  | { status: 404, body: { message: 'Unknown provision' } }
  | { status: 409, body: { message: 'Not fundable' | 'Wrong amount' | 'Record exists' | 'Refused' } }
  | { status: 200, body: { ok: true, repeat?: true } }

/**
 * POST /api/relayer-funding. The bearer is checked for the id in the body
 * before any read.
 *   - pending {from, amount_wei, nonce, tx_hash, raw_tx}: only while the
 *     sign-up is fundable, only for the fixed amount, and only when no record
 *     exists (one step, so of two runs at once exactly one is written). The
 *     destination is the stored relayer address, never a request field.
 *   - sent {tx_hash} and stopped {tx_hash, code}: only from pending with the
 *     same hash; the same answer again is a repeat (200, nothing written).
 */
export async function handleFundingWrite(authHeader: string | undefined, body: unknown, deps: FundingDeps): Promise<FundingWriteOutcome> {
  const claimedId = (body as { provision_id?: unknown } | null)?.provision_id
  if (typeof claimedId !== 'string' || !PROVISION_ID_PATTERN.test(claimedId) || !hasValidFundingToken(authHeader, claimedId, deps.secret)) {
    return UNAUTHORIZED
  }
  const action = (body as { action?: unknown }).action
  const at = String((deps.now ?? Date.now)())
  if (action === 'pending') {
    const parsed = v.safeParse(pendingSchema, body)
    if (!parsed.success) return { status: 400, body: { message: 'Invalid request' } }
    const p = parsed.output
    const found = await readSignup(p.provision_id, deps.redis)
    if (!found) return { status: 404, body: { message: 'Unknown provision' } }
    const signup = found.state
    const to = relayerOf(signup)
    if (!to || !FUNDABLE_STATUSES.has(str(signup.status))) return { status: 409, body: { message: 'Not fundable' } }
    if (p.amount_wei !== String(RELAYER_FUNDING_AMOUNT_WEI)) return { status: 409, body: { message: 'Wrong amount' } }
    const written = Number(await deps.redis.eval(RELAYER_FUNDING_PENDING_SCRIPT, [fundingKey(p.provision_id), found.key], [to, p.from, p.amount_wei, p.nonce, p.tx_hash, p.raw_tx, at, p.provision_id, ...FUNDABLE_STATUSES]))
    if (written === 4) return { status: 409, body: { message: 'Wrong amount' } }
    if (written === 3) return { status: 409, body: { message: 'Not fundable' } }
    if (written !== 1) return { status: 409, body: { message: 'Record exists' } }
    deps.log?.('relayer-funding: pending')
    return { status: 200, body: { ok: true } }
  }
  const parsed = v.safeParse(finishSchema, body)
  if (!parsed.success) return { status: 400, body: { message: 'Invalid request' } }
  const f = parsed.output
  const code = f.action === 'stopped' ? f.code : ''
  const answer = Number(await deps.redis.eval(RELAYER_FUNDING_FINISH_SCRIPT, [fundingKey(f.provision_id)], [f.action, f.tx_hash, at, code]))
  if (answer === 2) return { status: 200, body: { ok: true, repeat: true } }
  if (answer !== 1) return { status: 409, body: { message: 'Refused' } }
  deps.log?.(`relayer-funding: ${f.action}`)
  return { status: 200, body: { ok: true } }
}
