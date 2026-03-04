import { describe, it, expect } from 'vitest'
import * as v from 'valibot'
import { onboardingSchema } from '~/utils/onboarding-schema'

describe('onboardingSchema', () => {
  it('validates valid input', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: 'Test Community',
      email: 'test@example.com',
      password: 'password123'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.communityName).toBe('Test Community')
      expect(result.output.email).toBe('test@example.com')
      expect(result.output.password).toBe('password123')
    }
  })

  it('rejects short community name', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: 'ab',
      email: 'test@example.com',
      password: 'password123'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.issues.map(i => i.message)
      expect(messages).toContain('Community name must be at least 3 characters')
    }
  })

  it('rejects community name over 50 characters', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: 'A'.repeat(51),
      email: 'test@example.com',
      password: 'password123'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.issues.map(i => i.message)
      expect(messages).toContain('Community name must be under 50 characters')
    }
  })

  it('rejects invalid email', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: 'Test Community',
      email: 'notanemail',
      password: 'password123'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.issues.map(i => i.message)
      expect(messages).toContain('Please enter a valid email address')
    }
  })

  it('rejects short password', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: 'Test Community',
      email: 'test@example.com',
      password: '1234567'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const messages = result.issues.map(i => i.message)
      expect(messages).toContain('Password must be at least 8 characters')
    }
  })

  it('rejects all empty fields with multiple errors', () => {
    const result = v.safeParse(onboardingSchema, {
      communityName: '',
      email: '',
      password: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      // Should have errors for all three fields
      expect(result.issues.length).toBeGreaterThanOrEqual(3)
      const messages = result.issues.map(i => i.message)
      expect(messages).toContain('Community name must be at least 3 characters')
      expect(messages).toContain('Please enter a valid email address')
      expect(messages).toContain('Password must be at least 8 characters')
    }
  })
})
