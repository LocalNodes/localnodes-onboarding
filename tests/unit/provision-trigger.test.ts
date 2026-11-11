import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerProvisioning } from '../../server/utils/provisioning'
import { dispatchWorkflow } from '../../server/utils/github'
import { FakeRedis } from './helpers/fake-redis'
import { CREATE_SCRIPT } from '../../server/utils/lifecycle'

/**
 * Unit tests for the provisioning trigger (Phase 23, plan 23-11, D-12, D-13).
 *
 * triggerProvisioning:
 * 1. takes a Redis lock (SETNX) so a session provisions once
 * 2. maps the opaque provision id to the Stripe session id (provision:by-id)
 * 3. writes the state hash (no email, no site name)
 * 4. dispatches the workflow with only the contract inputs
 *
 * Fakes only: FakeRedis, a mock dispatch function, a mock fetch. Nothing here
 * calls GitHub, Stripe or Upstash.
 */

const PID = 'A1b2C3d4E5f6G7h8I9j0Kl' // 22 characters, [A-Za-z0-9_-]
const SID = 'cs_test_abc123def456'

const session = (over: Partial<{ id: string, provision_id: string | undefined, subdomain: string }> = {}) => ({
  id: over.id ?? SID,
  metadata: {
    subdomain: over.subdomain ?? 'cascadia',
    provision_id: 'provision_id' in over ? over.provision_id : PID
  }
})

const RUN = { runId: 12345, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/12345' }

describe('provision-trigger: triggerProvisioning', () => {
  let redis: FakeRedis
  let dispatch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    redis = new FakeRedis()
    dispatch = vi.fn().mockResolvedValue(RUN)
  })

  it('makes its first writes in one CREATE_SCRIPT step (23-43 Task 3): no separate SET NX lock, the build lock held an hour, alreadyProcessing=false', async () => {
    const set = vi.spyOn(redis, 'set')
    const evalSpy = vi.spyOn(redis, 'eval')
    const result = await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    expect(result.alreadyProcessing).toBe(false)
    expect(set).not.toHaveBeenCalled()
    expect(evalSpy.mock.calls[0]![0]).toBe(CREATE_SCRIPT)
    expect(await redis.get(`provision:${SID}:lock`)).toBe('locked')
    expect(await redis.ttl(`provision:${SID}:lock`)).toBe(3600)
    expect(await redis.hgetall(`dedupe:${PID}`)).toMatchObject({ checkoutSession: SID })
    expect(await redis.ttl(`dedupe:${PID}`)).toBe(2592000)
  })

  it('a failed first write leaves nothing, and the redelivery dispatches once', async () => {
    redis.failEvals(CREATE_SCRIPT, 2)
    await expect(triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })).rejects.toThrow()
    expect(redis.keys()).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    // Stripe redelivers after the 5xx: the build starts, once.
    expect((await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })).alreadyProcessing).toBe(false)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect((await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })).alreadyProcessing).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('a redelivery after the record expired dispatches nothing (the 30-day marker outlives the record)', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    // 25 hours later: the record, the by-id map and the build lock are gone; the marker is not.
    await redis.del(`provision:${SID}`, `provision:by-id:${PID}`, `provision:${SID}:lock`)
    const before = redis.dump()
    expect((await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })).alreadyProcessing).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(redis.dump()).toBe(before)
  })

  it('two deliveries at once give one dispatch', async () => {
    const [a, b] = await Promise.all([
      triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch }),
      triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    ])
    expect([a.alreadyProcessing, b.alreadyProcessing].sort()).toEqual([false, true])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('a lost reply on the create step: re-run with the same op id, one record, one dispatch', async () => {
    redis.loseReplies(CREATE_SCRIPT, 1)
    expect((await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })).alreadyProcessing).toBe(false)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await redis.hgetall(`provision:${SID}`)).toMatchObject({ status: 'provisioning', attempt: 1 })
  })

  it('the provisioning write after the dispatch is the dispatched transition (an op id stored, the 24-hour life kept)', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    const st = (await redis.hgetall<Record<string, unknown>>(`provision:${SID}`))!
    expect(st).toMatchObject({ status: 'provisioning', githubRunId: 12345 })
    expect(typeof st.lastOpId).toBe('string')
  })

  it('writes state keyed by the session id: provision id, attempt 1, no failures, no email or site name', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    const state = await redis.hgetall<Record<string, unknown>>(`provision:${SID}`)
    expect(state).toMatchObject({
      status: 'provisioning',
      provisionId: PID,
      attempt: 1,
      failedAttempts: 0,
      subdomain: 'cascadia',
      githubRunId: 12345,
      githubRunUrl: RUN.runUrl
    })
    expect(state!.startedAt).toBeDefined()
    expect(state!.updatedAt).toBeDefined()
    for (const gone of ['email', 'siteName', 'stripeSessionId', 'loginUrl', 'login_url']) {
      expect(state).not.toHaveProperty(gone)
    }
  })

  it('sets state to triggered before the dispatch and to provisioning after it', async () => {
    let seen: Record<string, unknown> | null = null
    dispatch.mockImplementation(async () => {
      seen = await redis.hgetall(`provision:${SID}`)
      return RUN
    })
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    expect(seen).toMatchObject({ status: 'triggered', provisionId: PID, attempt: 1, failedAttempts: 0 })
  })

  it('maps provision:by-id:{provisionId} to the session id, before the dispatch (a fast callback must find it)', async () => {
    let mapped: unknown = 'not read'
    dispatch.mockImplementation(async () => {
      mapped = await redis.get(`provision:by-id:${PID}`)
      return RUN
    })
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    expect(mapped).toBe(SID)
    expect(await redis.ttl(`provision:by-id:${PID}`)).toBeGreaterThan(0)
  })

  it('calls the dispatch function with exactly subdomain, provisionId and attempt 1', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ subdomain: 'cascadia', provisionId: PID, attempt: 1 })
  })

  it('refreshes the 24-hour life of the state hash', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    const ttl = await redis.ttl(`provision:${SID}`)
    expect(ttl).toBeGreaterThan(86000)
    expect(ttl).toBeLessThanOrEqual(86400)
  })

  it('returns alreadyProcessing=true and does nothing when the lock is already held', async () => {
    await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    dispatch.mockClear()
    const before = redis.dump()
    const second = await triggerProvisioning(session(), { redis, dispatchProvisioningWorkflow: dispatch })
    expect(second.alreadyProcessing).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.dump()).toBe(before)
  })

  it('refuses a session with no provision id: no lock, no state, no dispatch', async () => {
    await expect(
      triggerProvisioning(session({ provision_id: undefined }), { redis, dispatchProvisioningWorkflow: dispatch })
    ).rejects.toThrow(/provision id/i)
    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.keys()).toEqual([])
  })

  it.each([
    ['too short', 'abc'],
    ['too long', `${PID}x`],
    ['bad characters', 'A1b2C3d4E5f6G7h8I9j0K!']
  ])('refuses a provision id that is %s', async (_label, bad) => {
    await expect(
      triggerProvisioning(session({ provision_id: bad }), { redis, dispatchProvisioningWorkflow: dispatch })
    ).rejects.toThrow(/provision id/i)
    expect(dispatch).not.toHaveBeenCalled()
    expect(redis.keys()).toEqual([])
  })
})

describe('provision-trigger: dispatch to GitHub (provision contract v1)', () => {
  const config = { githubRepo: 'LocalNodes/os-knowledge-garden', githubToken: 'test-token-not-real', provisionImageTag: '' }

  const okFetch = () => vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workflow_run_id: 777, html_url: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/777' }),
    text: async () => ''
  })

  const sentBody = (fetchMock: ReturnType<typeof vi.fn>) => JSON.parse(fetchMock.mock.calls[0][1].body)

  it('sends exactly the contract inputs, with demo_module none and gemini_key_tier paid', async () => {
    const fetchMock = okFetch()
    const run = await dispatchWorkflow({ subdomain: 'cascadia', provisionId: PID, attempt: 1 }, { config, fetch: fetchMock })
    expect(run).toEqual({ runId: 777, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/777' })
    const body = sentBody(fetchMock)
    expect(body.inputs).toEqual({
      subdomain: 'cascadia',
      provision_id: PID,
      attempt: '1',
      demo_module: 'none',
      gemini_key_tier: 'paid',
      callback_url: 'https://localnodes.xyz'
    })
  })

  it('adds image_tag only when the config names one, so seven inputs then', async () => {
    const fetchMock = okFetch()
    await dispatchWorkflow(
      { subdomain: 'cascadia', provisionId: PID, attempt: 2 },
      { config: { ...config, provisionImageTag: 'sha-0123abc' }, fetch: fetchMock }
    )
    const inputs = sentBody(fetchMock).inputs
    expect(Object.keys(inputs).sort()).toEqual(
      ['attempt', 'callback_url', 'demo_module', 'gemini_key_tier', 'image_tag', 'provision_id', 'subdomain']
    )
    expect(inputs.image_tag).toBe('sha-0123abc')
    expect(inputs.attempt).toBe('2')
  })

  it('carries no email, site name, Stripe session id or old demo module in the request', async () => {
    const fetchMock = okFetch()
    await triggerProvisioning(session(), {
      redis: new FakeRedis(),
      dispatchProvisioningWorkflow: p => dispatchWorkflow(p, { config, fetch: fetchMock })
    })
    const raw = fetchMock.mock.calls[0][1].body as string
    expect(raw).not.toMatch(/@/)
    expect(raw).not.toContain(SID)
    expect(raw).not.toContain('localnodes_demo')
    expect(raw).not.toMatch(/site_name|stripe_session_id|"email"/)
  })

  it('sends the token as a bearer header to the workflow dispatch URL', async () => {
    const fetchMock = okFetch()
    await dispatchWorkflow({ subdomain: 'cascadia', provisionId: PID, attempt: 1 }, { config, fetch: fetchMock })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/LocalNodes/os-knowledge-garden/actions/workflows/provision-instance.yml/dispatches'
    )
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token-not-real')
  })

  it('throws a generic error with the status and none of GitHub\'s body text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unexpected inputs provided: ["secret-detail-from-github"]',
      json: async () => ({})
    })
    const attempt = dispatchWorkflow({ subdomain: 'cascadia', provisionId: PID, attempt: 1 }, { config, fetch: fetchMock })
    await expect(attempt).rejects.toThrow(/422/)
    await expect(attempt).rejects.not.toThrow(/secret-detail-from-github/)
  })
})
