import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleProvisionStatus, handleProvisionCallback } from '../../server/utils/provision-handlers'

/**
 * Unit tests for provision-status and provision-callback endpoints.
 *
 * Tests the pure handler logic extracted for testability:
 * - handleProvisionStatus: reads provisioning state from Redis by session_id
 * - handleProvisionCallback: authenticates and writes state updates to Redis
 */

// Mock Redis instance
const mockRedis = {
  set: vi.fn(),
  hset: vi.fn(),
  expire: vi.fn(),
  hgetall: vi.fn()
}

describe('provision-status: GET /api/provision-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns status from Redis when state exists', async () => {
    mockRedis.hgetall.mockResolvedValue({
      status: 'provisioning',
      subdomain: 'cascadia',
      email: 'test@example.com',
      siteName: 'Cascadia',
      stripeSessionId: 'cs_test_123',
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:01:00Z'
    })

    const result = await handleProvisionStatus('cs_test_123', mockRedis)

    expect(result.status).toBe('provisioning')
    expect(result.startedAt).toBe('2026-03-04T10:00:00Z')
  })

  it('returns { status: "unknown" } when no state in Redis', async () => {
    mockRedis.hgetall.mockResolvedValue(null)

    const result = await handleProvisionStatus('cs_nonexistent', mockRedis)

    expect(result).toEqual({ status: 'unknown' })
  })

  it('returns 400 validation error when session_id is missing', async () => {
    await expect(handleProvisionStatus(undefined, mockRedis))
      .rejects.toThrow('session_id is required')
  })

  it('returns siteUrl and loginUrl when available in state', async () => {
    mockRedis.hgetall.mockResolvedValue({
      status: 'complete',
      subdomain: 'cascadia',
      email: 'test@example.com',
      siteName: 'Cascadia',
      stripeSessionId: 'cs_test_123',
      siteUrl: 'https://cascadia.localnodes.xyz',
      loginUrl: 'https://cascadia.localnodes.xyz/user/reset/1/abc123/login',
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:05:00Z'
    })

    const result = await handleProvisionStatus('cs_test_123', mockRedis)

    expect(result.status).toBe('complete')
    expect(result.siteUrl).toBe('https://cascadia.localnodes.xyz')
    expect(result.loginUrl).toBe('https://cascadia.localnodes.xyz/user/reset/1/abc123/login')
  })

  it('returns error field when status is failed', async () => {
    mockRedis.hgetall.mockResolvedValue({
      status: 'failed',
      subdomain: 'cascadia',
      email: 'test@example.com',
      siteName: 'Cascadia',
      stripeSessionId: 'cs_test_123',
      error: 'GitHub Actions workflow timed out',
      startedAt: '2026-03-04T10:00:00Z',
      updatedAt: '2026-03-04T10:10:00Z'
    })

    const result = await handleProvisionStatus('cs_test_123', mockRedis)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('GitHub Actions workflow timed out')
  })
})

describe('provision-callback: POST /api/provision-callback', () => {
  const validSecret = 'test-callback-secret-abc123'
  const validConfig = { provisionCallbackSecret: validSecret }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updates Redis state with valid secret', async () => {
    const body = {
      session_id: 'cs_test_123',
      status: 'installing',
      site_url: 'https://cascadia.localnodes.xyz'
    }

    const result = await handleProvisionCallback(
      `Bearer ${validSecret}`,
      body,
      validConfig,
      mockRedis
    )

    expect(result).toEqual({ updated: true })
    expect(mockRedis.hset).toHaveBeenCalledWith(
      'provision:cs_test_123',
      expect.objectContaining({
        status: 'installing',
        siteUrl: 'https://cascadia.localnodes.xyz'
      })
    )
  })

  it('returns 401 with invalid secret', async () => {
    await expect(
      handleProvisionCallback(
        'Bearer wrong-secret',
        { session_id: 'cs_test_123', status: 'installing' },
        validConfig,
        mockRedis
      )
    ).rejects.toThrow(/Unauthorized/)
  })

  it('returns 401 with missing authorization header', async () => {
    await expect(
      handleProvisionCallback(
        undefined,
        { session_id: 'cs_test_123', status: 'installing' },
        validConfig,
        mockRedis
      )
    ).rejects.toThrow(/Unauthorized/)
  })

  it('returns 422 validation error with invalid status value', async () => {
    await expect(
      handleProvisionCallback(
        `Bearer ${validSecret}`,
        { session_id: 'cs_test_123', status: 'invalid_status' },
        validConfig,
        mockRedis
      )
    ).rejects.toThrow()
  })
})
