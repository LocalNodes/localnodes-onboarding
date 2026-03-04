import type { ProvisioningState } from './redis'

interface RedisLike {
  set: (key: string, value: string, options: { nx: boolean; ex: number }) => Promise<string | null>
  hset: (key: string, data: Record<string, unknown>) => Promise<number>
  expire: (key: string, seconds: number) => Promise<number>
}

interface DispatchResult {
  runId: number
  runUrl: string
}

type DispatchFn = (params: {
  subdomain: string
  siteName: string
  email: string
  stripeSessionId: string
}) => Promise<DispatchResult>

export interface TriggerDeps {
  redis: RedisLike
  dispatchProvisioningWorkflow: DispatchFn
}

const PROVISION_TTL = 86400 // 24 hours

/**
 * Trigger provisioning for a Stripe checkout session.
 *
 * Uses Redis SETNX for idempotency -- only the first invocation for a given
 * session ID will dispatch the GitHub Actions workflow.
 *
 * This is a pure function that accepts dependencies for testability.
 */
export async function triggerProvisioning(
  session: {
    id: string
    metadata: { subdomain: string; communityName: string; email: string }
    customer_email: string
  },
  deps: TriggerDeps
): Promise<{ alreadyProcessing: boolean }> {
  const { redis, dispatchProvisioningWorkflow } = deps
  const lockKey = `provision:${session.id}:lock`

  // Step 1: Atomic set-if-not-exists with 1-hour TTL
  const acquired = await redis.set(lockKey, 'locked', { nx: true, ex: 3600 })
  if (!acquired) {
    return { alreadyProcessing: true }
  }

  const now = new Date().toISOString()

  // Step 2: Set initial provisioning state
  const key = `provision:${session.id}`
  await redis.hset(key, {
    status: 'triggered',
    subdomain: session.metadata.subdomain,
    email: session.customer_email || session.metadata.email,
    siteName: session.metadata.communityName,
    stripeSessionId: session.id,
    startedAt: now,
    updatedAt: now
  })
  await redis.expire(key, PROVISION_TTL)

  // Step 3: Dispatch GitHub Actions workflow
  const { runId, runUrl } = await dispatchProvisioningWorkflow({
    subdomain: session.metadata.subdomain,
    siteName: session.metadata.communityName,
    email: session.customer_email || session.metadata.email,
    stripeSessionId: session.id
  })

  // Step 4: Update state with run details
  await redis.hset(key, {
    status: 'provisioning',
    githubRunId: String(runId),
    githubRunUrl: runUrl,
    updatedAt: new Date().toISOString()
  })
  await redis.expire(key, PROVISION_TTL)

  return { alreadyProcessing: false }
}
