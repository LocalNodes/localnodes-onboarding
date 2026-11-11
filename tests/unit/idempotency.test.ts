import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerProvisioning } from '../../server/utils/provisioning'
import { FakeRedis } from './helpers/fake-redis'

/**
 * Unit tests for provisioning idempotency logic.
 *
 * Since 23-43 Task 3 the first writes of a completed checkout are one Lua
 * step (lifecycle.ts CREATE_SCRIPT): the record and the 30-day marker
 * dedupe:{provisionId}, not a separate SET NX lock, keep a session to one
 * dispatch, and the build lock provision:{sid}:lock is written in the same
 * step for an hour. provision-trigger.test.ts covers the failure and
 * redelivery cases; these keep the original properties.
 */

const PID = 'Tt1Uu2Vv3Ww4Xx5Yy6Zz7A'
const PID_B = 'Tt1Uu2Vv3Ww4Xx5Yy6Zz7B'

describe('idempotency: one dispatch per checkout session', () => {
  let redis: FakeRedis
  const mockDispatch = vi.fn()
  const makeSession = (id: string, provisionId = PID) => ({
    id,
    metadata: {
      subdomain: 'test-community',
      // 23-11: provisioning is keyed by the opaque provision id (22 characters)
      provision_id: provisionId
    }
  })

  beforeEach(() => {
    redis = new FakeRedis()
    vi.clearAllMocks()
    mockDispatch.mockResolvedValue({ runId: 1, runUrl: 'https://github.com/runs/1' })
  })

  it('the first call for a session takes the build lock and returns alreadyProcessing=false', async () => {
    const result = await triggerProvisioning(makeSession('cs_first'), { redis, dispatchProvisioningWorkflow: mockDispatch })
    expect(result.alreadyProcessing).toBe(false)
    expect(await redis.get('provision:cs_first:lock')).toBe('locked')
    expect(mockDispatch).toHaveBeenCalledTimes(1)
  })

  it('a second call for the same session returns alreadyProcessing=true, dispatches nothing and writes nothing', async () => {
    await triggerProvisioning(makeSession('cs_duplicate'), { redis, dispatchProvisioningWorkflow: mockDispatch })
    const before = redis.dump()
    const result = await triggerProvisioning(makeSession('cs_duplicate'), { redis, dispatchProvisioningWorkflow: mockDispatch })
    expect(result.alreadyProcessing).toBe(true)
    expect(mockDispatch).toHaveBeenCalledTimes(1)
    expect(redis.dump()).toBe(before)
  })

  it('two different sessions each get their own lock and their own dispatch', async () => {
    const a = await triggerProvisioning(makeSession('cs_session_a', PID), { redis, dispatchProvisioningWorkflow: mockDispatch })
    const b = await triggerProvisioning(makeSession('cs_session_b', PID_B), { redis, dispatchProvisioningWorkflow: mockDispatch })
    expect(a.alreadyProcessing).toBe(false)
    expect(b.alreadyProcessing).toBe(false)
    expect(await redis.get('provision:cs_session_a:lock')).toBe('locked')
    expect(await redis.get('provision:cs_session_b:lock')).toBe('locked')
    expect(mockDispatch).toHaveBeenCalledTimes(2)
  })

  it('the build lock lives one hour (3600 s)', async () => {
    await triggerProvisioning(makeSession('cs_ttl_check'), { redis, dispatchProvisioningWorkflow: mockDispatch })
    expect(await redis.ttl('provision:cs_ttl_check:lock')).toBe(3600)
  })
})
