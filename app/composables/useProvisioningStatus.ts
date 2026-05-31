import { useTimeoutPoll, useCountdown } from '@vueuse/core'
import { ref, computed, watch } from 'vue'

// ---- Types ----

export type RawStatus =
  | 'triggered'
  | 'provisioning'
  | 'installing'
  | 'creating_user'
  | 'sending_email'
  | 'complete'
  | 'failed'
  | 'unknown'

interface StatusResponse {
  status: RawStatus
  siteUrl?: string | null
  loginUrl?: string | null
  error?: string | null
  startedAt?: string
}

// ---- Exported pure helpers (testable without Vue context) ----

/**
 * Maps raw Redis statuses to 4 human-facing named stages.
 * State machine: triggered -> provisioning -> installing -> creating_user -> sending_email -> complete | failed
 */
export const STAGES = [
  { id: 'triggered', label: 'Payment confirmed', statuses: ['triggered'] },
  { id: 'provisioning', label: 'Setting up your server', statuses: ['provisioning'] },
  { id: 'installing', label: 'Installing your garden', statuses: ['installing', 'creating_user', 'sending_email'] },
  { id: 'complete', label: 'Your garden is ready!', statuses: ['complete'] }
] as const

const TERMINAL_STATUSES: readonly string[] = ['complete', 'failed']

/**
 * Get the stage index for a raw status.
 * Returns -1 for 'failed', 0 for 'unknown' (no data yet).
 */
export function getStageIndex(status: RawStatus): number {
  if (status === 'failed') return -1
  const idx = STAGES.findIndex(s => (s.statuses as readonly string[]).includes(status))
  return idx === -1 ? 0 : idx
}

/**
 * Check if a status is terminal (complete or failed).
 */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status)
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
 * Composable that polls the provisioning status endpoint, maps raw statuses
 * to human-facing stages, and manages a countdown timer.
 *
 * @param sessionId - Stripe checkout session ID from URL query param
 */
export function useProvisioningStatus(sessionId: string | undefined) {
  const status = ref<RawStatus>('unknown')
  const siteUrl = ref<string | null>(null)
  const loginUrl = ref<string | null>(null)
  const error = ref<string | null>(null)
  const startedAt = ref<string | null>(null)

  const isComplete = computed(() => status.value === 'complete')
  const isFailed = computed(() => status.value === 'failed')
  const currentStageIndex = computed(() => getStageIndex(status.value))
  const stages = computed(() => mapStagesToState(currentStageIndex.value))

  // Countdown timer: 240 seconds (4 minutes).
  // `immediate: true` is required to actually start ticking. @vueuse's
  // useCountdown defers to useIntervalFn, whose auto-start is guarded by
  // `immediate && isClient` -- so the per-second interval runs only in the
  // browser and is skipped during SSR (no dangling server-side timer).
  const { remaining, pause: pauseCountdown } = useCountdown(PROVISIONING_SECONDS, { immediate: true })

  const timeRemaining = computed(() => formatTimeRemaining(remaining.value))

  // Pause countdown on any terminal status (complete OR failed), not just complete.
  watch(status, (s) => {
    if (isTerminalStatus(s)) pauseCountdown()
  })

  // Polling: fetch status every 3 seconds
  const { pause } = useTimeoutPoll(async () => {
    if (!sessionId || isTerminalStatus(status.value)) {
      pause()
      return
    }
    try {
      const data = await $fetch<StatusResponse>('/api/provision-status', {
        query: { session_id: sessionId }
      })

      status.value = data.status
      if (data.siteUrl) siteUrl.value = data.siteUrl
      if (data.loginUrl) loginUrl.value = data.loginUrl
      if (data.error) error.value = data.error
      if (data.startedAt) startedAt.value = data.startedAt

      if (isTerminalStatus(data.status)) {
        pause()
      }
    } catch {
      // Network error: don't change status, retry on next tick
    }
  }, 3000, { immediate: true })

  // Guard: if no sessionId, don't poll
  if (!sessionId) {
    pause()
  }

  return {
    status,
    stages,
    currentStageIndex,
    isComplete,
    isFailed,
    siteUrl,
    loginUrl,
    error,
    startedAt,
    timeRemaining,
    remaining,
    pause
  }
}
