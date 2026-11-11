import { useTimeoutPoll, useCountdown } from '@vueuse/core'
import { ref, computed, watch } from 'vue'
import { PROVISION_STATUSES, type ProvisionStatus } from '#shared/provisioning'
import { timeLine } from '~/utils/reason-copy'

// The /success page's status poll (fresh3 23-20; ONB-01, ONB-02, D-13, T-3).
// The status list is shared/provisioning.ts's PROVISION_STATUSES, the same list
// the server validates callbacks against, so the copies cannot drift (research
// Pitfall 14). The status reply is 23-14's six keys (status, siteUrl, reason,
// canRetry, stopped, startedAt) plus attempt (23-38: 1 for the first build, 2
// after the free retry). There is no sign-in link here or anywhere on the page
// (D-13): the sign-in link only ever goes by email.
//
// B-1 (23-32): the list now has ready (the site is built and the first payment
// is being taken), held (the bank asked the organizer to confirm it) and
// declined (the card was refused). Ready and held show the step "Taking your
// first payment"; complete comes only once the payment went through and the
// site was handed over.
//
// 23-37: a held reply adds heldUntil (ISO) and canConfirm (true only for the
// browser that made the sign-up; it decides whether the held screen shows the
// "Confirm my payment" form), and a declined reply adds heldExpired (a 3DS
// hold that ran out, not a declined card). The page keeps polling while held
// and stops on declined.
//
// 23-43 Task 7: a 3DS hold that ran out adds removed (the delete is confirmed),
// noCapture (no payment was taken: P3's "You weren't charged" only then) and
// refundProven (a captured payment's refund passed D2's check). refunding (the
// waiting screen, P6) and refunded (P2) add lateActivation. The page keeps
// polling while removing, while refunding, and while a removed sign-up with a
// capture waits for its refund's proof.

export { timeLine }

// ---- Types ----

/** A status from the shared list, or 'unknown' before the first good read. */
export type RawStatus = ProvisionStatus | 'unknown'

interface StatusResponse {
  status: string
  siteUrl?: string | null
  reason?: string | null
  canRetry?: boolean
  stopped?: boolean
  startedAt?: string
  /** 1 for the first build, 2 after the free retry (23-38). */
  attempt?: number
  /** Held only (23-37): when the hold ends, ISO. */
  heldUntil?: string
  /** Held only (23-37): this browser made the sign-up. */
  canConfirm?: boolean
  /** Declined only (23-37): the 3DS hold ran out unconfirmed. */
  heldExpired?: boolean
  /** A 3DS hold that ran out (23-43 Task 7): the workflow confirmed the delete. */
  removed?: boolean
  /** A 3DS hold that ran out (23-43 Task 7): no payment was captured. */
  noCapture?: boolean
  /** A 3DS hold that ran out (23-43 Task 7): a captured payment's refund passed D2's check. */
  refundProven?: boolean
  /** Refunding and refunded only (23-43 Task 7): the site activated after the refund began. */
  lateActivation?: boolean
  /** No state and no checkout marker: an id that is not ours, or one that has expired (23-20 follow-up). */
  notFound?: boolean
}

// ---- Exported pure helpers (testable without Vue context) ----

const isProvisionStatus = (value: unknown): value is ProvisionStatus =>
  typeof value === 'string' && (PROVISION_STATUSES as readonly string[]).includes(value)

/**
 * Maps the shared statuses to the 5 steps the person sees (23-UI-SPEC section
 * 4). Every status but 'failed', 'declined', 'refunding' and 'refunded' belongs
 * to exactly one step; a test checks this against PROVISION_STATUSES.
 */
export const STAGES = [
  { id: 'triggered', label: 'Card saved', statuses: ['triggered'] },
  { id: 'provisioning', label: 'Setting up your server', statuses: ['provisioning'] },
  { id: 'installing', label: 'Installing your site', statuses: ['installing', 'creating_user', 'sending_email'] },
  { id: 'payment', label: 'Taking your first payment', statuses: ['ready', 'held'] },
  { id: 'complete', label: 'Your site is ready', statuses: ['complete'] }
] as const satisfies ReadonlyArray<{ id: string, label: string, statuses: readonly ProvisionStatus[] }>

/** The payment outcomes that are no build step (23-43 Task 7). */
const NO_STEP: readonly RawStatus[] = ['failed', 'declined', 'refunding', 'refunded']

/**
 * Get the stage index for a raw status.
 * Returns -1 for 'failed', 'declined', 'refunding' and 'refunded', 0 for 'unknown' (no data yet).
 */
export function getStageIndex(status: RawStatus): number {
  if (NO_STEP.includes(status)) return -1
  const idx = STAGES.findIndex(s => (s.statuses as readonly string[]).includes(status))
  return idx === -1 ? 0 : idx
}

/**
 * Should the poll stop after this reply? Yes on complete, on declined (nothing
 * changes after it), on stopped, and on a failure that offers the retry
 * (nothing changes until the person presses it).
 * A failure with no retry that isn't stopped keeps polling: that is a site's
 * own failure inside its 10-minute window (it may still turn complete), or a
 * stop still running. The server settles both on a status read, so the page
 * drives them by polling (23-14).
 */
export function shouldStopPolling(reply: { status: string, canRetry?: boolean, stopped?: boolean, notFound?: boolean, heldExpired?: boolean, removed?: boolean, noCapture?: boolean, refundProven?: boolean }): boolean {
  // An id the server does not know never turns into a build (23-20 follow-up).
  if (reply.notFound === true) return true
  if (reply.stopped === true) return true
  // A 3DS hold that ran out (23-43 Task 7): removing until the delete is
  // confirmed, and a captured payment's refund until it is proven.
  if (reply.status === 'declined' && reply.heldExpired === true) {
    return reply.removed === true && (reply.noCapture === true || reply.refundProven === true)
  }
  // refunding is the waiting screen; refunded is final (23-43 Task 7).
  if (reply.status === 'complete' || reply.status === 'declined' || reply.status === 'refunded') return true
  return reply.status === 'failed' && reply.canRetry === true
}

/**
 * Format seconds as "M:SS" (e.g., 225 -> "3:45").
 */
export function formatTimeRemaining(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/**
 * Map STAGES to an array with state labels based on the current stage index.
 * state: 'completed' (index < current), 'active' (index === current), 'pending' (index > current)
 * When currentStageIndex is -1 (failed), all stages are 'pending'.
 */
export function mapStagesToState(currentStageIndex: number) {
  return STAGES.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: (currentStageIndex < 0)
      ? 'pending' as const
      : i < currentStageIndex
        ? 'completed' as const
        : i === currentStageIndex
          ? 'active' as const
          : 'pending' as const
  }))
}

// ---- Composable ----

const PROVISIONING_SECONDS = 240

/**
 * Polls GET /api/provision-status every 3 seconds, maps the status to the five
 * steps, keeps a 4-minute countdown, and offers retry() for a failed build.
 *
 * @param sessionId - Stripe checkout session ID from URL query param
 */
export function useProvisioningStatus(sessionId: string | undefined) {
  const status = ref<RawStatus>('unknown')
  const siteUrl = ref<string | null>(null)
  const reason = ref<string | null>(null)
  const canRetry = ref(false)
  const stopped = ref(false)
  /** Which build this is: 1, or 2 after the free retry (23-38). */
  const attempt = ref(1)
  const startedAt = ref<string | null>(null)
  /** The last status read failed; the page shows the neutral alert and keeps polling. */
  const readError = ref(false)
  /** A retry request is in flight. */
  const retrying = ref(false)
  /** The last retry request was refused or failed. */
  const retryFailed = ref(false)
  /** A retry was accepted: the progress screen reads "Trying again…". */
  const retried = ref(false)
  /** When the 3DS hold ends (ISO), while held (23-37). */
  const heldUntil = ref<string | null>(null)
  /** This browser made the sign-up, so the held screen shows its confirm form (23-37). */
  const canConfirm = ref(false)
  /** A declined sign-up whose 3DS hold ran out unconfirmed (23-37). */
  const heldExpired = ref(false)
  /** A 3DS hold that ran out whose delete the workflow confirmed (23-43 Task 7). */
  const removed = ref(false)
  /** A 3DS hold that ran out with no payment captured (23-43 Task 7, P3's truth check). */
  const noCapture = ref(false)
  /** A 3DS hold that ran out whose captured payment's refund passed D2's check (23-43 Task 7). */
  const refundProven = ref(false)
  /** Refunding or refunded, after the site activated late (23-43 Task 7): the shorter alert. */
  const lateActivation = ref(false)
  /**
   * The server does not know this session id (23-20 follow-up): the page shows
   * its empty state, never the build steps. "unknown" without it is a session
   * still waiting for its webhook.
   */
  const notFound = ref(false)

  const isComplete = computed(() => status.value === 'complete')
  const isFailed = computed(() => status.value === 'failed')
  const isHeld = computed(() => status.value === 'held')
  const isDeclined = computed(() => status.value === 'declined')
  const isRefunding = computed(() => status.value === 'refunding')
  const isRefunded = computed(() => status.value === 'refunded')
  const currentStageIndex = computed(() => getStageIndex(status.value))
  const stages = computed(() => mapStagesToState(currentStageIndex.value))
  const activeStageLabel = computed(() => STAGES[Math.max(0, currentStageIndex.value)]!.label)

  // Countdown timer: 240 seconds (4 minutes).
  // `immediate: true` is required to actually start ticking. @vueuse's
  // useCountdown defers to useIntervalFn, whose auto-start is guarded by
  // `immediate && isClient` -- so the per-second interval runs only in the
  // browser and is skipped during SSR (no dangling server-side timer).
  const { remaining, pause: pauseCountdown, start: startCountdown } = useCountdown(PROVISIONING_SECONDS, { immediate: true })

  const timeRemaining = computed(() => formatTimeRemaining(remaining.value))
  /** "About 3 minutes left." Changes once a minute; never announced. */
  const minutesLine = computed(() => timeLine(remaining.value))

  // Pause the countdown once the build has ended either way.
  watch(status, (s) => {
    if (s === 'complete' || s === 'failed' || s === 'refunding' || s === 'refunded') pauseCountdown()
  })

  // Polling: fetch status every 3 seconds
  const { pause, resume } = useTimeoutPoll(async () => {
    if (!sessionId) {
      pause()
      return
    }
    try {
      const data = await $fetch<StatusResponse>('/api/provision-status', {
        query: { session_id: sessionId }
      })

      readError.value = false
      status.value = isProvisionStatus(data.status) ? data.status : 'unknown'
      if (data.siteUrl) siteUrl.value = data.siteUrl
      reason.value = data.reason ?? null
      canRetry.value = data.canRetry === true
      stopped.value = data.stopped === true
      attempt.value = Number.isInteger(data.attempt) && (data.attempt as number) >= 1 ? data.attempt as number : 1
      if (data.startedAt) startedAt.value = data.startedAt
      const held = data.status === 'held'
      heldUntil.value = held && typeof data.heldUntil === 'string' ? data.heldUntil : null
      canConfirm.value = held && data.canConfirm === true
      heldExpired.value = data.status === 'declined' && data.heldExpired === true
      removed.value = heldExpired.value && data.removed === true
      noCapture.value = heldExpired.value && data.noCapture === true
      refundProven.value = heldExpired.value && data.refundProven === true
      lateActivation.value = (data.status === 'refunding' || data.status === 'refunded') && data.lateActivation === true
      notFound.value = data.notFound === true

      if (shouldStopPolling(data)) pause()
    } catch {
      // The status can't be read right now: keep the last good state, show the
      // neutral alert, and try again on the next tick.
      readError.value = true
    }
  }, 3000, { immediate: true })

  // Guard: if no sessionId, don't poll
  if (!sessionId) {
    pause()
  }

  /**
   * Run the build again for the same Stripe session (23-14). The server decides
   * whether a retry is allowed; this only calls the gated route. On success the
   * page goes back to the progress steps with a fresh countdown.
   */
  async function retry(): Promise<void> {
    if (!sessionId || retrying.value) return
    retrying.value = true
    retryFailed.value = false
    try {
      await $fetch('/api/retry-provisioning', {
        method: 'POST',
        body: { session_id: sessionId }
      })
      retried.value = true
      status.value = 'triggered'
      canRetry.value = false
      reason.value = null
      startCountdown()
    } catch {
      // Refused (409 already running or stopped) or not reached: the failure
      // stays on screen with the retry-failed line. The next status read shows
      // whatever the server now says (for example, stopped).
      retryFailed.value = true
    } finally {
      retrying.value = false
      resume()
    }
  }

  return {
    status,
    stages,
    currentStageIndex,
    activeStageLabel,
    isComplete,
    isFailed,
    isHeld,
    isDeclined,
    heldUntil,
    canConfirm,
    heldExpired,
    removed,
    noCapture,
    refundProven,
    lateActivation,
    isRefunding,
    isRefunded,
    notFound,
    siteUrl,
    reason,
    canRetry,
    stopped,
    attempt,
    startedAt,
    readError,
    retrying,
    retryFailed,
    retried,
    retry,
    timeRemaining,
    minutesLine,
    remaining,
    pause
  }
}
