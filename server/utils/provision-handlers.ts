import * as v from 'valibot'
import type { ProvisioningState } from './redis'

interface RedisLike {
  hset: (key: string, data: Record<string, unknown>) => Promise<number>
  expire: (key: string, seconds: number) => Promise<number>
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
}

const PROVISION_TTL = 86400 // 24 hours

const VALID_STATUSES = [
  'triggered', 'provisioning', 'installing',
  'creating_user', 'sending_email', 'complete', 'failed'
] as const

const callbackBodySchema = v.object({
  session_id: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist([...VALID_STATUSES]),
  site_url: v.optional(v.string()),
  login_url: v.optional(v.string()),
  error: v.optional(v.string())
})

/**
 * Handle GET /api/provision-status requests.
 * Pure function for testability.
 */
export async function handleProvisionStatus(
  sessionId: string | undefined,
  redis: RedisLike
): Promise<{
  status: string
  siteUrl?: string | null
  loginUrl?: string | null
  error?: string | null
  startedAt?: string
}> {
  if (!sessionId) {
    const err = new Error('session_id is required')
    ;(err as any).statusCode = 400
    throw err
  }

  const data = await redis.hgetall(`provision:${sessionId}`) as ProvisioningState | null

  if (!data || Object.keys(data).length === 0) {
    return { status: 'unknown' }
  }

  return {
    status: data.status,
    siteUrl: data.siteUrl || null,
    loginUrl: data.loginUrl || null,
    error: data.error || null,
    startedAt: data.startedAt
  }
}

/**
 * Handle POST /api/provision-callback requests.
 * Pure function for testability.
 */
export async function handleProvisionCallback(
  authHeader: string | undefined,
  body: unknown,
  config: { provisionCallbackSecret: string },
  redis: RedisLike
): Promise<{ updated: true }> {
  // Verify callback secret
  if (authHeader !== `Bearer ${config.provisionCallbackSecret}`) {
    const err = new Error('Unauthorized')
    ;(err as any).statusCode = 401
    throw err
  }

  // Validate body
  const parsed = v.parse(callbackBodySchema, body)

  const key = `provision:${parsed.session_id}`
  await redis.hset(key, {
    status: parsed.status,
    ...(parsed.site_url && { siteUrl: parsed.site_url }),
    ...(parsed.login_url && { loginUrl: parsed.login_url }),
    ...(parsed.error && { error: parsed.error }),
    updatedAt: new Date().toISOString()
  })
  await redis.expire(key, PROVISION_TTL)

  return { updated: true }
}
