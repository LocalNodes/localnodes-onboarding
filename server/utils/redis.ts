import { Redis } from '@upstash/redis'

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

export interface ProvisioningState {
  status: 'triggered' | 'provisioning' | 'installing' | 'creating_user' | 'sending_email' | 'complete' | 'failed'
  subdomain: string
  email: string
  siteName: string
  stripeSessionId: string
  githubRunId?: string
  githubRunUrl?: string
  siteUrl?: string
  loginUrl?: string
  error?: string
  startedAt: string
  updatedAt: string
}

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
