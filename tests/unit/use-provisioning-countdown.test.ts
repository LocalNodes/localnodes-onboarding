import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression guard for the "countdown frozen at 4:00" bug.
//
// The sibling use-provisioning-status.test.ts fully mocks @vueuse/core, which is
// exactly why the frozen-timer bug shipped green. This file does NOT mock it --
// it drives the REAL useCountdown timer with fake timers.
//
// @vueuse computes `isClient` ONCE at module load as a const:
//   const isClient = typeof window !== 'undefined' && typeof document !== 'undefined'
// and useCountdown only auto-starts when (immediate && isClient). Under
// environment:'node' there is no DOM, so isClient would be false and the timer
// would never tick. ES `import` statements are hoisted and run before the module
// body, so a plain top-level stub is too late -- we must stub the DOM inside
// vi.hoisted(), which runs before the (hoisted) imports evaluate. `document`
// needs a createElement method or @vue/runtime-dom throws on import.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown }
  g.window ??= globalThis
  g.document ??= { createElement: () => ({}) }
})

// Non-terminal poll response so polling never flips to a terminal status (which
// would pause the countdown). The countdown itself is independent of the fetch.
vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ status: 'provisioning' }))

import { effectScope } from 'vue'
import { useProvisioningStatus } from '~/composables/useProvisioningStatus'

describe('useProvisioningStatus - real countdown (no @vueuse mock)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('actually decrements the countdown over time (timer is not frozen at 4:00)', () => {
    const scope = effectScope()
    const { remaining, timeRemaining } = scope.run(() =>
      useProvisioningStatus('cs_test_countdown')
    )!

    // Starts at the full 4 minutes.
    expect(remaining.value).toBe(240)
    expect(timeRemaining.value).toBe('4:00')

    // After 3 seconds the timer must have moved -- this FAILS against the old
    // `useCountdown(240)` (no immediate), which stays frozen at 240/"4:00".
    vi.advanceTimersByTime(3000)
    expect(remaining.value).toBeLessThan(240)
    expect(timeRemaining.value).not.toBe('4:00')
    expect(remaining.value).toBe(237)
    expect(timeRemaining.value).toBe('3:57')

    scope.stop()
  })

  it('keeps counting down past the first few seconds', () => {
    const scope = effectScope()
    const { remaining } = scope.run(() =>
      useProvisioningStatus('cs_test_countdown_2')
    )!

    vi.advanceTimersByTime(10_000)
    expect(remaining.value).toBe(230)

    scope.stop()
  })
})
