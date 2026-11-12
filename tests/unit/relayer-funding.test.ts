import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { callbackToken } from '../../server/utils/provision-handlers'
import {
  RELAYER_FUNDING_AMOUNT_WEI,
  RELAYER_FUNDING_FINISH_SCRIPT,
  RELAYER_FUNDING_PENDING_SCRIPT,
  fundingKey,
  fundingToken,
  handleFundingCheck,
  handleFundingWrite,
  type FundingDeps
} from '../../server/utils/relayer-funding'
import { FakeRedis } from './helpers/fake-redis'

/**
 * The practice relayer's funding record. LocalNodes/os-knowledge-garden's
 * fund-practice-relayer.yml reads it, writes pending before it broadcasts, and
 * finishes it with sent or stopped. These tests hold the rules the workflow's
 * own fake store copies (scripts/ops/relayer-funding/test/fake-signup.mjs in
 * the site repository): one record per provision, written once, finished once,
 * same hash only, the fixed amount only, destination from the sign-up record only.
 */

const SECRET = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const SID = 'cs_test_funding'
const PID = 'FuNd1nG000000000000000'
const OTHER_PID = 'FuNd1nG111111111111111'
const RELAYER = '0x' + '1a'.repeat(20)
const FUNDER = '0x' + '2b'.repeat(20)
const H1 = '0x' + 'a'.repeat(64)
const H2 = '0x' + 'b'.repeat(64)
const RAW = '0x02f8' + 'c'.repeat(60)
const AMOUNT = '100000000000000000'

const bearer = (pid = PID) => `Bearer ${fundingToken(SECRET, pid)}`
const pending = (extra: Record<string, unknown> = {}) => ({ provision_id: PID, action: 'pending', from: FUNDER, amount_wei: AMOUNT, nonce: '7', tx_hash: H1, raw_tx: RAW, ...extra })

let redis: FakeRedis
const isEmptyRecord = (r: unknown) => r === null || (typeof r === 'object' && Object.keys(r as object).length === 0)
let deps: FundingDeps
let logs: string[]

async function seedSignup(fields: Record<string, unknown> = {}) {
  await redis.set(`provision:by-id:${PID}`, SID)
  await redis.hset(`provision:${SID}`, { provisionId: PID, status: 'ready', relayerAddress: RELAYER, email: 'organizer@example.org', ...fields })
}

beforeEach(async () => {
  redis = new FakeRedis()
  logs = []
  deps = { redis, secret: SECRET, now: () => 1_700_000_000_000, log: m => logs.push(m) }
  await seedSignup()
})

describe('the bearer', () => {
  it('is its own HMAC, not the site callback token (the site must not write this record)', () => {
    expect(fundingToken(SECRET, PID)).toMatch(/^[0-9a-f]{64}$/)
    expect(fundingToken(SECRET, PID)).not.toBe(callbackToken(SECRET, PID))
  })

  it('the site callback token is refused on both routes', async () => {
    const site = `Bearer ${callbackToken(SECRET, PID)}`
    expect((await handleFundingCheck(site, PID, deps)).status).toBe(401)
    expect((await handleFundingWrite(site, pending(), deps)).status).toBe(401)
  })

  it('another provision\'s bearer, no bearer, an empty secret and a bad id are refused', async () => {
    expect((await handleFundingCheck(bearer(OTHER_PID), PID, deps)).status).toBe(401)
    expect((await handleFundingCheck(undefined, PID, deps)).status).toBe(401)
    expect((await handleFundingCheck(bearer(), PID, { ...deps, secret: '' })).status).toBe(401)
    expect((await handleFundingCheck(bearer(), 'short', deps)).status).toBe(401)
    expect((await handleFundingWrite(bearer(OTHER_PID), pending(), deps)).status).toBe(401)
    expect((await handleFundingWrite(bearer(), null, deps)).status).toBe(401)
  })

  it('is checked before any read', async () => {
    let reads = 0
    const counting = { ...deps, redis: { get: async () => { reads++; return null }, hgetall: async () => { reads++; return null }, eval: async () => { reads++; return 0 } } }
    await handleFundingCheck(bearer(OTHER_PID), PID, counting)
    await handleFundingWrite(bearer(OTHER_PID), pending(), counting)
    expect(reads).toBe(0)
  })
})

describe('GET /api/relayer-funding', () => {
  it('a ready sign-up with no record: the stored relayer, fundable, no record', async () => {
    expect(await handleFundingCheck(bearer(), PID, deps)).toEqual({ status: 200, body: { relayer_address: RELAYER, fundable: true, funding: null } })
  })

  it('complete is fundable; building, failed and refunding are not', async () => {
    await seedSignup({ status: 'complete' })
    expect((await handleFundingCheck(bearer(), PID, deps)).body).toMatchObject({ fundable: true })
    for (const status of ['building', 'failed', 'refunding']) {
      await seedSignup({ status })
      expect((await handleFundingCheck(bearer(), PID, deps)).body).toMatchObject({ fundable: false })
    }
  })

  it('no relayer address (a site built without web3) is not fundable', async () => {
    await seedSignup({ relayerAddress: '' })
    expect((await handleFundingCheck(bearer(), PID, deps)).body).toEqual({ relayer_address: '', fundable: false, funding: null })
  })

  it('an unknown provision with no record is 404', async () => {
    expect((await handleFundingCheck(bearer(OTHER_PID), OTHER_PID, deps)).status).toBe(404)
  })

  it('a record is answered even after the sign-up is gone, so a pending send is always reconciled', async () => {
    await handleFundingWrite(bearer(), pending(), deps)
    await redis.del(`provision:${SID}`)
    const out = await handleFundingCheck(bearer(), PID, deps)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ relayer_address: '', fundable: false, funding: { state: 'pending', to: RELAYER, tx_hash: H1, raw_tx: RAW, nonce: '7', amount_wei: AMOUNT } })
  })
})

describe('POST pending', () => {
  it('writes the record with the stored relayer as its destination, and no lifetime', async () => {
    expect(await handleFundingWrite(bearer(), pending({ to: '0x' + '9'.repeat(40) }), deps)).toEqual({ status: 200, body: { ok: true } })
    const rec = await redis.hgetall<Record<string, unknown>>(fundingKey(PID))
    expect(rec).toMatchObject({ state: 'pending', from: FUNDER, nonce: 7, txHash: H1, rawTx: RAW })
    expect(String(rec!.to)).toBe(RELAYER)
    // The amount survives Upstash's JSON parse of a numeric string.
    expect(String(rec!.amountWei)).toBe(AMOUNT)
    expect(await redis.ttl(fundingKey(PID))).toBe(-1)
    expect(logs).toEqual(['relayer-funding: pending'])
  })

  it('a second pending is refused whatever its hash (one record per provision)', async () => {
    await handleFundingWrite(bearer(), pending(), deps)
    expect(await handleFundingWrite(bearer(), pending({ tx_hash: H2, nonce: '8' }), deps)).toEqual({ status: 409, body: { message: 'Record exists' } })
    expect(await handleFundingWrite(bearer(), pending(), deps)).toEqual({ status: 409, body: { message: 'Record exists' } })
    expect((await redis.hgetall<Record<string, unknown>>(fundingKey(PID)))!.txHash).toBe(H1)
  })

  it('of two at once, exactly one is written', async () => {
    const [a, b] = await Promise.all([
      handleFundingWrite(bearer(), pending(), deps),
      handleFundingWrite(bearer(), pending({ tx_hash: H2 }), deps)
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('any amount but the fixed one (more, less, zero) is refused, and a non-number is invalid; nothing is written', async () => {
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: String(RELAYER_FUNDING_AMOUNT_WEI + 1n) }), deps)).body).toEqual({ message: 'Wrong amount' })
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: String(RELAYER_FUNDING_AMOUNT_WEI - 1n) }), deps)).body).toEqual({ message: 'Wrong amount' })
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: '1' }), deps)).body).toEqual({ message: 'Wrong amount' })
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: '0' }), deps)).body).toEqual({ message: 'Wrong amount' })
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: '1e17' }), deps)).status).toBe(400)
    expect(await redis.hgetall(fundingKey(PID))).toBeNull()
    expect((await handleFundingWrite(bearer(), pending({ amount_wei: String(RELAYER_FUNDING_AMOUNT_WEI) }), deps)).status).toBe(200)
  })

  it('not fundable (no relayer, or not ready) is refused and writes nothing', async () => {
    await seedSignup({ status: 'building' })
    expect((await handleFundingWrite(bearer(), pending(), deps)).body).toEqual({ message: 'Not fundable' })
    await seedSignup({ relayerAddress: 'not-an-address' })
    expect((await handleFundingWrite(bearer(), pending(), deps)).body).toEqual({ message: 'Not fundable' })
    expect(await redis.hgetall(fundingKey(PID))).toBeNull()
  })

  it('an unknown provision is 404', async () => {
    expect((await handleFundingWrite(bearer(OTHER_PID), pending({ provision_id: OTHER_PID }), deps)).status).toBe(404)
  })

  it('malformed fields are 400', async () => {
    for (const bad of [{ tx_hash: 'x' }, { from: 'x' }, { nonce: '-1' }, { raw_tx: 'zz' }, { tx_hash: H1.toUpperCase().replace('0X', '0x') }]) {
      expect((await handleFundingWrite(bearer(), pending(bad), deps)).status).toBe(400)
    }
    expect(await redis.hgetall(fundingKey(PID))).toBeNull()
  })
})

describe('POST sent and stopped', () => {
  beforeEach(async () => {
    await handleFundingWrite(bearer(), pending(), deps)
    logs = []
  })

  it('pending to sent with the same hash; again is a repeat', async () => {
    expect(await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).toEqual({ status: 200, body: { ok: true } })
    expect(await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).toEqual({ status: 200, body: { ok: true, repeat: true } })
    expect((await redis.hgetall<Record<string, unknown>>(fundingKey(PID)))!.state).toBe('sent')
    expect(logs).toEqual(['relayer-funding: sent'])
  })

  it('another hash is refused', async () => {
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H2 }, deps)).status).toBe(409)
    expect((await redis.hgetall<Record<string, unknown>>(fundingKey(PID)))!.state).toBe('pending')
  })

  it('stopped needs a known code; it is final', async () => {
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'stopped', tx_hash: H1, code: 'other' }, deps)).status).toBe(400)
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'stopped', tx_hash: H1, code: 'nonce_taken' }, deps)).status).toBe(200)
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).status).toBe(409)
    expect((await handleFundingWrite(bearer(), pending(), deps)).status).toBe(409)
    expect(await redis.hgetall(fundingKey(PID))).toMatchObject({ state: 'stopped', stopCode: 'nonce_taken' })
  })

  it('sent is final: neither stopped nor a new pending', async () => {
    await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'stopped', tx_hash: H1, code: 'nonce_taken' }, deps)).status).toBe(409)
    expect((await handleFundingWrite(bearer(), pending({ tx_hash: H2 }), deps)).status).toBe(409)
  })

  it('a finish with no record is refused', async () => {
    await redis.del(fundingKey(PID))
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).status).toBe(409)
  })

  it('an unknown action is 400', async () => {
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'reset', tx_hash: H1 }, deps)).status).toBe(400)
  })
})

describe('a sign-up that changes after the handler read it', () => {
  for (const status of ['declined', 'failed']) {
    it(`turned ${status} between the read and the write: refused inside the script, nothing written`, async () => {
      const racing = { ...deps, redis: { get: redis.get.bind(redis), hgetall: redis.hgetall.bind(redis), eval: async (script: string, keys: string[], args: unknown[]) => {
        await redis.hset(`provision:${SID}`, { status })
        return redis.eval(script, keys, args)
      } } }
      expect(await handleFundingWrite(bearer(), pending(), racing)).toEqual({ status: 409, body: { message: 'Not fundable' } })
      expect(await redis.hgetall(fundingKey(PID))).toSatisfy(isEmptyRecord)
    })
  }

  it('a relayer address changed between the read and the write: refused, nothing written', async () => {
    const racing = { ...deps, redis: { get: redis.get.bind(redis), hgetall: redis.hgetall.bind(redis), eval: async (script: string, keys: string[], args: unknown[]) => {
      await redis.hset(`provision:${SID}`, { relayerAddress: '0x' + '3c'.repeat(20) })
      return redis.eval(script, keys, args)
    } } }
    expect((await handleFundingWrite(bearer(), pending(), racing)).status).toBe(409)
    expect(await redis.hgetall(fundingKey(PID))).toSatisfy(isEmptyRecord)
  })

  it('the script itself refuses any amount but the fixed one, whatever the handler passed', async () => {
    const skewed = { ...deps, redis: { get: redis.get.bind(redis), hgetall: redis.hgetall.bind(redis), eval: async (script: string, keys: string[], args: unknown[]) => {
      return redis.eval(script, keys, args.map((x, i) => (i === 2 ? String(RELAYER_FUNDING_AMOUNT_WEI * 10n) : x)))
    } } }
    expect(await handleFundingWrite(bearer(), pending(), skewed)).toEqual({ status: 409, body: { message: 'Wrong amount' } })
    expect(await redis.hgetall(fundingKey(PID))).toSatisfy(isEmptyRecord)
  })
})

describe('lost replies', () => {
  it('a pending whose reply was lost has applied: the re-read shows our hash', async () => {
    redis.loseReplies(RELAYER_FUNDING_PENDING_SCRIPT, 1)
    await expect(handleFundingWrite(bearer(), pending(), deps)).rejects.toThrow()
    const out = await handleFundingCheck(bearer(), PID, deps)
    expect(out.body).toMatchObject({ funding: { state: 'pending', tx_hash: H1 } })
  })

  it('a sent whose reply was lost: the retry is a repeat', async () => {
    await handleFundingWrite(bearer(), pending(), deps)
    redis.loseReplies(RELAYER_FUNDING_FINISH_SCRIPT, 1)
    await expect(handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).rejects.toThrow()
    expect((await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)).body).toEqual({ ok: true, repeat: true })
  })
})

describe('privacy', () => {
  it('log lines hold fixed words only', async () => {
    await handleFundingWrite(bearer(), pending(), deps)
    await handleFundingWrite(bearer(), { provision_id: PID, action: 'sent', tx_hash: H1 }, deps)
    for (const line of logs) {
      expect(line).toMatch(/^relayer-funding: (pending|sent|stopped)$/)
    }
  })

  it('the module never logs a variable', () => {
    const src = readFileSync(new URL('../../server/utils/relayer-funding.ts', import.meta.url), 'utf8')
    for (const call of src.match(/log\?\.\([^)]*\)/g) ?? []) {
      expect(call).toMatch(/^log\?\.\(('relayer-funding: pending'|`relayer-funding: \$\{f\.action\}`)\)$/)
    }
  })
})

describe('the shared contract (the site repository\'s scripts/ops/relayer-funding/test/contract.json, byte-identical)', () => {
  // The site repository's fake sign-up app runs the same file, so the fake the funding
  // script is tested against keeps this handler's rules.
  interface Step { method: 'GET' | 'POST', body?: Record<string, unknown>, bearer?: 'other', expect: { status: number, body?: unknown } }
  const contract = JSON.parse(readFileSync(new URL('./fixtures/relayer-funding-contract.json', import.meta.url), 'utf8')) as {
    secret: string
    provision_id: string
    other_provision_id: string
    cases: Array<{ name: string, signup: Record<string, string> | null, steps: Step[] }>
  }
  for (const c of contract.cases) {
    it(c.name, async () => {
      const r = new FakeRedis()
      const d: FundingDeps = { redis: r, secret: contract.secret, now: () => 1 }
      if (c.signup) {
        await r.set(`provision:by-id:${contract.provision_id}`, 'cs_contract')
        await r.hset('provision:cs_contract', { provisionId: contract.provision_id, ...c.signup })
      }
      for (const step of c.steps) {
        const auth = `Bearer ${fundingToken(contract.secret, step.bearer === 'other' ? contract.other_provision_id : contract.provision_id)}`
        const out = step.method === 'GET'
          ? await handleFundingCheck(auth, contract.provision_id, d)
          : await handleFundingWrite(auth, step.body, d)
        expect(out.status, `${c.name}: ${JSON.stringify(step)}`).toBe(step.expect.status)
        if (step.expect.body !== undefined) expect(out.body).toEqual(step.expect.body)
      }
    })
  }
})
