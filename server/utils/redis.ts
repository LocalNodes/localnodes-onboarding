import { Redis } from '@upstash/redis'
import type { ProvisioningState } from '../../shared/provisioning'

let _redis: Redis | null = null

export function useRedis(): Redis {
  if (!_redis) {
    const config = useRuntimeConfig()
    if (!config.upstashRedisUrl || !config.upstashRedisToken) {
      throw new Error('Upstash Redis credentials not configured')
    }
    _redis = new Redis({
      url: config.upstashRedisUrl,
      token: config.upstashRedisToken
    })
  }
  return _redis
}

// The state shape and the status and reason lists live once in shared/provisioning.ts.
export type { ProvisioningState } from '../../shared/provisioning'

const PROVISION_TTL = 86400 // 24 hours

export async function setProvisioningState(
  sessionId: string,
  state: Partial<ProvisioningState>,
  redis?: Redis
): Promise<void> {
  const r = redis || useRedis()
  const key = `provision:${sessionId}`
  await r.hset(key, { ...state, updatedAt: new Date().toISOString() })
  await r.expire(key, PROVISION_TTL)
}

export async function getProvisioningState(
  sessionId: string,
  redis?: Redis
): Promise<ProvisioningState | null> {
  const r = redis || useRedis()
  const data = await r.hgetall<ProvisioningState>(`provision:${sessionId}`)
  return data && Object.keys(data).length > 0 ? data : null
}
