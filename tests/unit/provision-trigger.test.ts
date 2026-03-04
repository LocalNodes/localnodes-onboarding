import { describe, it, expect, vi, beforeEach } from 'vitest'
import { triggerProvisioning } from '../../server/utils/provisioning'

/**
 * Unit tests for the provisioning trigger logic.
 *
 * Tests the triggerProvisioning pure function that:
 * 1. Acquires a Redis lock (SETNX) for idempotency
 * 2. Sets initial provisioning state in Redis
 * 3. Dispatches the GitHub Actions workflow
 * 4. Updates provisioning state with run details
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

describe('provision-trigger: triggerProvisioning', () => {
  const testSession = {
    id: 'cs_test_abc123def456',
    metadata: {
      subdomain: 'cascadia',
      communityName: 'Cascadia Bioregion',
      email: 'organizer@example.com'
    },
    customer_email: 'organizer@example.com'
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets Redis lock key via set(nx:true) and returns alreadyProcessing=false on first call', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 12345, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/12345' })

    const result = await triggerProvisioning(testSession, {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(mockRedis.set).toHaveBeenCalledWith(
      `provision:${testSession.id}:lock`,
      'locked',
      { nx: true, ex: 3600 }
    )
    expect(result.alreadyProcessing).toBe(false)
  })

  it('sets initial provisioning state with status=triggered', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 12345, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/12345' })

    await triggerProvisioning(testSession, {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    // First hset call should be the initial state with status 'triggered'
    const firstHsetCall = mockRedis.hset.mock.calls[0]
    expect(firstHsetCall[0]).toBe(`provision:${testSession.id}`)
    expect(firstHsetCall[1]).toMatchObject({
      status: 'triggered',
      subdomain: 'cascadia',
      email: 'organizer@example.com',
      siteName: 'Cascadia Bioregion',
      stripeSessionId: testSession.id
    })
    expect(firstHsetCall[1].startedAt).toBeDefined()
    expect(firstHsetCall[1].updatedAt).toBeDefined()
  })

  it('calls dispatchProvisioningWorkflow with correct params', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({ runId: 12345, runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/12345' })

    await triggerProvisioning(testSession, {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(mockDispatch).toHaveBeenCalledWith({
      subdomain: 'cascadia',
      siteName: 'Cascadia Bioregion',
      email: 'organizer@example.com',
      stripeSessionId: testSession.id
    })
  })

  it('updates state to status=provisioning with githubRunId and githubRunUrl after dispatch', async () => {
    mockRedis.set.mockResolvedValue('OK')
    mockDispatch.mockResolvedValue({
      runId: 99999,
      runUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/99999'
    })

    await triggerProvisioning(testSession, {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    // Second hset call should update to 'provisioning' with run details
    const secondHsetCall = mockRedis.hset.mock.calls[1]
    expect(secondHsetCall[0]).toBe(`provision:${testSession.id}`)
    expect(secondHsetCall[1]).toMatchObject({
      status: 'provisioning',
      githubRunId: '99999',
      githubRunUrl: 'https://github.com/LocalNodes/os-knowledge-garden/actions/runs/99999'
    })
    expect(secondHsetCall[1].updatedAt).toBeDefined()
  })

  it('returns alreadyProcessing=true when lock already exists', async () => {
    // Redis SET with NX returns null when key already exists
    mockRedis.set.mockResolvedValue(null)

    const result = await triggerProvisioning(testSession, {
      redis: mockRedis,
      dispatchProvisioningWorkflow: mockDispatch
    })

    expect(result.alreadyProcessing).toBe(true)
    expect(mockDispatch).not.toHaveBeenCalled()
    expect(mockRedis.hset).not.toHaveBeenCalled()
  })
})
