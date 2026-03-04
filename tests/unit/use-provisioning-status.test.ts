import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- Pure function tests (no Vue reactivity needed) ----

// We'll test the exported helper functions directly
// These are extracted for testability from the composable

import {
  STAGES,
  getStageIndex,
  formatTimeRemaining,
  isTerminalStatus,
  mapStagesToState
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
