import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'

// Mock $fetch globally before importing the composable (Nuxt auto-import)
vi.stubGlobal('$fetch', vi.fn())

// Mock @vueuse/core so we can drive the polling callback manually and avoid
// real timers. The pure helpers (getStageIndex, etc.) don't use these at
// runtime, so mocking @vueuse/core does not affect them.
//
// - useTimeoutPoll: capture the poll callback (don't auto-run it via a real
//   timer). `pollHarness.run()` invokes the captured callback so tests stay
//   deterministic. `pause` is a spy so we can assert polling stops.
// - useCountdown: return a controllable `remaining` ref + spy `pause`.
const pollHarness: {
  fn: (() => void | Promise<void>) | null
  pause: ReturnType<typeof vi.fn>
  run: () => Promise<void>
} = {
  fn: null,
  pause: vi.fn(),
  run: async () => {
    if (pollHarness.fn) await pollHarness.fn()
  }
}

const countdownHarness = {
  remaining: ref(240),
  pause: vi.fn()
}

vi.mock('@vueuse/core', () => ({
  useTimeoutPoll: (fn: () => void | Promise<void>, _interval: number, _opts?: unknown) => {
    pollHarness.fn = fn
    return { pause: pollHarness.pause, resume: vi.fn(), isActive: ref(false) }
  },
  useCountdown: (_initial: number) => ({
    remaining: countdownHarness.remaining,
    pause: countdownHarness.pause,
    resume: vi.fn(),
    start: vi.fn(),
    stop: vi.fn()
  })
}))

// ---- Pure function tests (no Vue reactivity needed) ----

// We'll test the exported helper functions directly
// These are extracted for testability from the composable

import {
  STAGES,
  getStageIndex,
  formatTimeRemaining,
  isTerminalStatus,
  mapStagesToState,
  useProvisioningStatus
} from '~/composables/useProvisioningStatus'

describe('useProvisioningStatus - pure helpers', () => {
  describe('STAGES constant', () => {
    it('defines exactly 4 stages', () => {
      expect(STAGES).toHaveLength(4)
    })

    it('maps "triggered" to stage 0 - "Payment confirmed"', () => {
      expect(STAGES[0].label).toBe('Payment confirmed')
      expect(STAGES[0].statuses).toContain('triggered')
    })

    it('maps "provisioning" to stage 1 - "Setting up your server"', () => {
      expect(STAGES[1].label).toBe('Setting up your server')
      expect(STAGES[1].statuses).toContain('provisioning')
    })

    it('maps "installing", "creating_user", "sending_email" to stage 2 - "Installing your garden"', () => {
      expect(STAGES[2].label).toBe('Installing your garden')
      expect(STAGES[2].statuses).toContain('installing')
      expect(STAGES[2].statuses).toContain('creating_user')
      expect(STAGES[2].statuses).toContain('sending_email')
    })

    it('maps "complete" to stage 3 - "Your garden is ready!"', () => {
      expect(STAGES[3].label).toBe('Your garden is ready!')
      expect(STAGES[3].statuses).toContain('complete')
    })
  })

  describe('getStageIndex', () => {
    it('returns 0 for "triggered"', () => {
      expect(getStageIndex('triggered')).toBe(0)
    })

    it('returns 1 for "provisioning"', () => {
      expect(getStageIndex('provisioning')).toBe(1)
    })

    it('returns 2 for "installing"', () => {
      expect(getStageIndex('installing')).toBe(2)
    })

    it('returns 2 for "creating_user"', () => {
      expect(getStageIndex('creating_user')).toBe(2)
    })

    it('returns 2 for "sending_email"', () => {
      expect(getStageIndex('sending_email')).toBe(2)
    })

    it('returns 3 for "complete"', () => {
      expect(getStageIndex('complete')).toBe(3)
    })

    it('returns -1 for "failed"', () => {
      expect(getStageIndex('failed')).toBe(-1)
    })

    it('returns 0 for "unknown" (no data yet)', () => {
      expect(getStageIndex('unknown')).toBe(0)
    })
  })

  describe('isTerminalStatus', () => {
    it('returns true for "complete"', () => {
      expect(isTerminalStatus('complete')).toBe(true)
    })

    it('returns true for "failed"', () => {
      expect(isTerminalStatus('failed')).toBe(true)
    })

    it('returns false for "triggered"', () => {
      expect(isTerminalStatus('triggered')).toBe(false)
    })

    it('returns false for "provisioning"', () => {
      expect(isTerminalStatus('provisioning')).toBe(false)
    })

    it('returns false for "installing"', () => {
      expect(isTerminalStatus('installing')).toBe(false)
    })

    it('returns false for "unknown"', () => {
      expect(isTerminalStatus('unknown')).toBe(false)
    })
  })

  describe('formatTimeRemaining', () => {
    it('formats 240 seconds as "4:00"', () => {
      expect(formatTimeRemaining(240)).toBe('4:00')
    })

    it('formats 225 seconds as "3:45"', () => {
      expect(formatTimeRemaining(225)).toBe('3:45')
    })

    it('formats 60 seconds as "1:00"', () => {
      expect(formatTimeRemaining(60)).toBe('1:00')
    })

    it('formats 9 seconds as "0:09"', () => {
      expect(formatTimeRemaining(9)).toBe('0:09')
    })

    it('formats 0 seconds as "0:00"', () => {
      expect(formatTimeRemaining(0)).toBe('0:00')
    })

    it('formats 119 seconds as "1:59"', () => {
      expect(formatTimeRemaining(119)).toBe('1:59')
    })
  })

  describe('mapStagesToState', () => {
    it('marks stages before currentStageIndex as "completed"', () => {
      const result = mapStagesToState(2)
      expect(result[0].state).toBe('completed')
      expect(result[1].state).toBe('completed')
    })

    it('marks stage at currentStageIndex as "active"', () => {
      const result = mapStagesToState(2)
      expect(result[2].state).toBe('active')
    })

    it('marks stages after currentStageIndex as "pending"', () => {
      const result = mapStagesToState(1)
      expect(result[2].state).toBe('pending')
      expect(result[3].state).toBe('pending')
    })

    it('marks all stages as "pending" when currentStageIndex is -1 (failed)', () => {
      const result = mapStagesToState(-1)
      expect(result.every(s => s.state === 'pending')).toBe(true)
    })

    it('marks all stages completed/active when at final stage', () => {
      const result = mapStagesToState(3)
      expect(result[0].state).toBe('completed')
      expect(result[1].state).toBe('completed')
      expect(result[2].state).toBe('completed')
      expect(result[3].state).toBe('active')
    })

    it('preserves label and id from STAGES', () => {
      const result = mapStagesToState(0)
      expect(result[0].id).toBe('triggered')
      expect(result[0].label).toBe('Payment confirmed')
    })
  })
})

// ---- Stateful composable tests (drive the mocked poll callback manually) ----

describe('useProvisioningStatus - composable', () => {
  beforeEach(() => {
    vi.mocked($fetch).mockReset()
    pollHarness.fn = null
    pollHarness.pause.mockClear()
    countdownHarness.pause.mockClear()
    countdownHarness.remaining.value = 240
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fetch and pauses polling when sessionId is undefined', async () => {
    const provisioning = useProvisioningStatus(undefined)

    // The !sessionId guard pauses polling synchronously on setup.
    expect(pollHarness.pause).toHaveBeenCalled()

    // Even if the poll callback fires, the guard prevents any $fetch.
    await pollHarness.run()
    expect(vi.mocked($fetch)).not.toHaveBeenCalled()

    // State stays at the initial "no data yet" value.
    expect(provisioning.status.value).toBe('unknown')
  })

  it('starts at "unknown" with no fetch having occurred yet', () => {
    const { status, isComplete, isFailed } = useProvisioningStatus('cs_test_123')
    expect(status.value).toBe('unknown')
    expect(isComplete.value).toBe(false)
    expect(isFailed.value).toBe(false)
    expect(vi.mocked($fetch)).not.toHaveBeenCalled()
  })

  it('reflects a fetched in-progress status into status + derived stages', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'provisioning' })

    const { status, stages, currentStageIndex, isComplete, isFailed } =
      useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()

    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/provision-status', {
      query: { session_id: 'cs_test_123' }
    })
    expect(status.value).toBe('provisioning')
    expect(currentStageIndex.value).toBe(1)
    expect(isComplete.value).toBe(false)
    expect(isFailed.value).toBe(false)
    // stage 0 completed, stage 1 active
    expect(stages.value[0].state).toBe('completed')
    expect(stages.value[1].state).toBe('active')
  })

  it('captures siteUrl/loginUrl from the response payload', async () => {
    vi.mocked($fetch).mockResolvedValue({
      status: 'complete',
      siteUrl: 'https://garden.localnodes.xyz',
      loginUrl: 'https://garden.localnodes.xyz/login'
    })

    const { siteUrl, loginUrl } = useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()

    expect(siteUrl.value).toBe('https://garden.localnodes.xyz')
    expect(loginUrl.value).toBe('https://garden.localnodes.xyz/login')
  })

  it('treats "complete" as terminal: isComplete true and polling paused', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'complete' })

    const { status, isComplete, isFailed } = useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()

    expect(status.value).toBe('complete')
    expect(isComplete.value).toBe(true)
    expect(isFailed.value).toBe(false)
    // terminal status pauses polling and the countdown
    expect(pollHarness.pause).toHaveBeenCalled()
    expect(countdownHarness.pause).toHaveBeenCalled()
  })

  it('treats "failed" as terminal: isFailed true, error captured, polling paused', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'failed', error: 'provisioning blew up' })

    const { status, isFailed, isComplete, error, currentStageIndex } =
      useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()

    expect(status.value).toBe('failed')
    expect(isFailed.value).toBe(true)
    expect(isComplete.value).toBe(false)
    expect(error.value).toBe('provisioning blew up')
    expect(currentStageIndex.value).toBe(-1)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('stops fetching once a terminal status has been reached', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'complete' })

    useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()
    expect(vi.mocked($fetch)).toHaveBeenCalledTimes(1)

    // A subsequent poll tick should short-circuit on the isTerminalStatus guard.
    await pollHarness.run()
    expect(vi.mocked($fetch)).toHaveBeenCalledTimes(1)
  })

  it('keeps prior state when $fetch rejects (network-error resilience)', async () => {
    // First poll succeeds and advances to "provisioning".
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'provisioning' })

    const { status, isComplete, isFailed } = useProvisioningStatus('cs_test_123')

    await pollHarness.run()
    await nextTick()
    expect(status.value).toBe('provisioning')

    // Next poll rejects; the catch {} must swallow it and leave state intact.
    vi.mocked($fetch).mockRejectedValueOnce(new Error('network down'))

    await expect(pollHarness.run()).resolves.toBeUndefined()
    await nextTick()

    // Status did not blank out or crash; it retains the last known good value.
    expect(status.value).toBe('provisioning')
    expect(isComplete.value).toBe(false)
    expect(isFailed.value).toBe(false)
  })

  it('exposes a formatted timeRemaining derived from the countdown', () => {
    countdownHarness.remaining.value = 225
    const { timeRemaining } = useProvisioningStatus('cs_test_123')
    expect(timeRemaining.value).toBe('3:45')
  })
})
