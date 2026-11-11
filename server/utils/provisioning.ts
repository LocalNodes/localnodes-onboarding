import { PROVISION_ID_PATTERN } from '../../shared/provisioning'
import { recordDispatchFailure, type RetryStopRedis } from './retry-stop'
import { createProvision, transition } from './lifecycle'

interface RedisLike {
  hgetall: (key: string) => Promise<Record<string, unknown> | null>
  /** CREATE_SCRIPT and the dispatched transition (23-43 Task 3). */
  eval: (script: string, keys: string[], args: unknown[]) => Promise<unknown>
  /** Used only when the dispatch throws (23-14). */
  del?: (...keys: string[]) => Promise<unknown>
  hincrby?: (key: string, field: string, increment: number) => Promise<number>
}

interface DispatchResult {
  runId: number
  runUrl: string
}

/**
 * What the dispatch needs, and no more: the site address, the opaque provision
 * id and the attempt number (D-12, D-05). The organizer's email, the community
 * name and the Stripe session id never leave this app in a workflow input.
 */
export type DispatchFn = (params: {
  subdomain: string
  provisionId: string
  attempt: number
}) => Promise<DispatchResult>

export interface TriggerDeps {
  redis: RedisLike
  dispatchProvisioningWorkflow: DispatchFn
}

/**
 * Trigger provisioning for a paid (or invited) Stripe checkout session.
 *
 * The checkout put a provision id in the session metadata (23-07). It is the
 * only identifier the workflow and the new site ever see. State stays keyed by
 * the Stripe session id, because the success page has that; the map
 * provision:by-id:{provisionId} -> session id lets a callback find it.
 *
 * The first writes are one Lua step (lifecycle.ts CREATE_SCRIPT, 23-43 Task
 * 3): it checks that neither provision:{sid} nor the 30-day marker
 * dedupe:{provisionId} exists (nor a build lock), then writes the by-id map,
 * the first hash, the marker with checkoutSession, their lifetimes and the
 * build lock provision:{sid}:lock for an hour, all or nothing. The record and
 * the marker, not the lock, are the de-duplication: a redelivery finds one of
 * them, even 25 hours later with the record expired, and dispatches nothing; a
 * Redis error before the step applied leaves nothing, so the webhook answers
 * 5xx and Stripe's redelivery starts the build once. Once a session has state,
 * this never dispatches again: a later run is the retry route's (23-14). A
 * process that dies between the create step and the dispatch still leaves a
 * triggered sign-up with no run (23-21's reconciliation row: triggered with
 * no githubRunId after 15 minutes).
 *
 * A dispatch that throws is recorded as a failed first attempt (reason
 * unknown, lock freed, one free retry left; ruling "Dispatch fails after the
 * invite is claimed"). It is not raised: a Stripe redelivery could not help,
 * and the person retries from the success page.
 *
 * This is a pure function that accepts dependencies for testability.
 */
export async function triggerProvisioning(
  session: {
    id: string
    metadata: { subdomain: string; provision_id?: string }
  },
  deps: TriggerDeps
): Promise<{ alreadyProcessing: boolean }> {
  const { redis, dispatchProvisioningWorkflow } = deps

  // A session with no usable provision id has no sign-up record, so the new
  // site's manifest would not exist. Refuse before taking the lock or writing
  // anything, so the failure is loud and nothing is half-started. The message
  // never includes the id.
  const provisionId = session.metadata?.provision_id
  if (typeof provisionId !== 'string' || !PROVISION_ID_PATTERN.test(provisionId)) {
    throw new Error('Cannot provision: the checkout session has no valid provision id')
  }

  // Steps 1 to 3 in one step: the build lock, the existing-state check, the
  // by-id map (before the dispatch, so a callback that arrives at once finds
  // its state), the first hash (no email, no site name) and the marker.
  const created = await createProvision(redis, {
    sid: session.id,
    provisionId,
    subdomain: session.metadata.subdomain,
    now: Date.now()
  })
  if (created === 'exists') {
    return { alreadyProcessing: true }
  }

  // Step 4: Dispatch GitHub Actions workflow
  let run: DispatchResult
  try {
    run = await dispatchProvisioningWorkflow({
      subdomain: session.metadata.subdomain,
      provisionId,
      attempt: 1
    })
  } catch {
    // The session id only: github.ts already keeps GitHub's answer out of its message.
    console.error('dispatch failed', { sessionId: session.id })
    await recordDispatchFailure(session.id, 1, { redis: redis as unknown as RetryStopRedis })
    return { alreadyProcessing: false }
  }
  const { runId, runUrl } = run

  // Step 5: the run details, through the dispatched transition (triggered,
  // attempt 1, to provisioning; the record's 24-hour life kept, never lowered).
  await transition(redis, session.id, 'dispatched', { provisionId, attempt: 1, githubRunId: runId, githubRunUrl: runUrl })

  return { alreadyProcessing: false }
}
