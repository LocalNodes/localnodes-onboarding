import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Unit tests for provisioning idempotency logic.
 *
 * Specifically tests the Redis SETNX lock mechanism that prevents
 * duplicate provisioning for the same Stripe session.
 */

// Mock Redis instance
const mockRedis = {
  set: vi.fn(),
  hset: vi.fn(),
  expire: vi.fn(),
  hgetall: vi.fn()
}

// Mock dispatch function
const mockDispatch = vi.fn()

// Pure function: triggerProvisioning
// Will be imported from server/utils/provisioning.ts once implemented
async function triggerProvisioning(
  session: {
    id: string
    metadata: { subdomain: string; communityName: string; email: string }
    customer_email: string
  },
  deps: {
    redis: typeof mockRedis
    dispatchProvisioningWorkflow: typeof mockDispatch
  }
): Promise<{ alreadyProcessing: boolean }> {
  throw new Error('Not implemented')
}

describe('idempotency: Redis SETNX lock', () => {
  const makeSession = (id: string) => ({
    id,
    metadata: {
      subdomain: 'test-community',
      communityName: 'Test Community',
      email: 'test@example.com'
    },
    customer_email: 'test@example.com'
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('first call with session_id acquires lock and returns alreadyProcessing=false', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 1, runUrl: 'https://github.com/runs/1' })

    const result = await triggerProvisioning(makeSession('cs_first'), {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(result.alreadyProcessing).toBe(false)
    expect(mockRedis.set).toHaveBeenCalledWith(
      'provision:cs_first:lock',
      'locked',
      { nx: true, ex: 3600 }
    )
    expect(mockDispatch).toHaveBeenCalled()
  })

  it('second call with same session_id returns alreadyProcessing=true without dispatching', async () => {
    mockRedis.set.mockResolvedValue(null) // NX fails -- key already exists

    const result = await triggerProvisioning(makeSession('cs_duplicate'), {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(result.alreadyProcessing).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockRedis.hset).not.toHaveBeenCalled()
  })

  it('two different session_ids both acquire their own locks independently', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 1, runUrl: 'https://github.com/runs/1' })

    const result1 = await triggerProvisioning(makeSession('cs_session_a'), {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    const result2 = await triggerProvisioning(makeSession('cs_session_b'), {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(result1.alreadyProcessing).toBe(false)
    expect(result2.alreadyProcessing).toBe(false)

    // Each session gets its own lock key
    expect(mockRedis.set).toHaveBeenCalledWith(
      'provision:cs_session_a:lock',
      'locked',
      { nx: true, ex: 3600 }
    )
    expect(mockRedis.set).toHaveBeenCalledWith(
      'provision:cs_session_b:lock',
      'locked',
      { nx: true, ex: 3600 }
    )
  })

  it('lock uses 1-hour TTL (ex: 3600)', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 1, runUrl: 'https://github.com/runs/1' })

    await triggerProvisioning(makeSession('cs_ttl_check'), {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.any(String),
      'locked',
      expect.objectContaining({ ex: 3600 })
    )
  })
})
