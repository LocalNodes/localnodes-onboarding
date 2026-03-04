import { describe, it, expect } from 'vitest'

/**
 * Unit tests for check-subdomain server route logic.
 *
 * We test the pure logic functions extracted from the server route:
 * - Reserved subdomain checking
 * - Slug validation rules
 * - Domain matching against Coolify apps
 *
 * Full integration tests (actual HTTP requests) require the Nuxt dev server.
 */

// Reserved subdomains list (mirrors the server route constant)
const RESERVED_SUBDOMAINS = [
  'www', 'api', 'coolify', 'mail', 'smtp', 'admin', 'app',
  'dashboard', 'status', 'billing', 'support', 'help', 'docs'
]

// Slug validation regex (mirrors the server route Valibot schema)
const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 63 && SLUG_REGEX.test(slug)
}

function isReserved(slug: string): boolean {
  return RESERVED_SUBDOMAINS.includes(slug)
}

function isDomainTaken(slug: string, apps: any[]): boolean {
  const fqdn = `${slug}.localnodes.xyz`
  return apps.some(app => {
    if (!app.docker_compose_domains) return false
    const domains = typeof app.docker_compose_domains === 'string'
      ? app.docker_compose_domains
      : JSON.stringify(app.docker_compose_domains)
    return domains.includes(fqdn)
  })
}

describe('check-subdomain: slug validation', () => {
  it('accepts valid slugs', () => {
    expect(isValidSlug('cascadia')).toBe(true)
    expect(isValidSlug('my-community')).toBe(true)
    expect(isValidSlug('abc')).toBe(true)
    expect(isValidSlug('a1b2c3')).toBe(true)
    expect(isValidSlug('community-2026')).toBe(true)
  })

  it('rejects slugs that are too short (< 3 chars)', () => {
    expect(isValidSlug('ab')).toBe(false)
    expect(isValidSlug('a')).toBe(false)
    expect(isValidSlug('')).toBe(false)
  })

  it('rejects slugs with special characters', () => {
    expect(isValidSlug('my_community')).toBe(false)
    expect(isValidSlug('my.community')).toBe(false)
    expect(isValidSlug('my community')).toBe(false)
    expect(isValidSlug('my@community')).toBe(false)
  })

  it('rejects slugs starting with a hyphen', () => {
    expect(isValidSlug('-community')).toBe(false)
  })

  it('rejects slugs ending with a hyphen', () => {
    expect(isValidSlug('community-')).toBe(false)
  })

  it('rejects slugs with uppercase letters', () => {
    expect(isValidSlug('Cascadia')).toBe(false)
    expect(isValidSlug('MY-COMMUNITY')).toBe(false)
  })

  it('accepts slug at max DNS label length (63 chars)', () => {
    const slug = 'a'.repeat(63)
    expect(isValidSlug(slug)).toBe(true)
  })

  it('rejects slug exceeding max DNS label length (64+ chars)', () => {
    const slug = 'a'.repeat(64)
    expect(isValidSlug(slug)).toBe(false)
  })
})

describe('check-subdomain: reserved names', () => {
  it('identifies reserved subdomains', () => {
    expect(isReserved('www')).toBe(true)
    expect(isReserved('api')).toBe(true)
    expect(isReserved('coolify')).toBe(true)
    expect(isReserved('mail')).toBe(true)
    expect(isReserved('smtp')).toBe(true)
    expect(isReserved('admin')).toBe(true)
    expect(isReserved('app')).toBe(true)
    expect(isReserved('dashboard')).toBe(true)
    expect(isReserved('status')).toBe(true)
    expect(isReserved('billing')).toBe(true)
    expect(isReserved('support')).toBe(true)
    expect(isReserved('help')).toBe(true)
    expect(isReserved('docs')).toBe(true)
  })

  it('allows non-reserved subdomains', () => {
    expect(isReserved('cascadia')).toBe(false)
    expect(isReserved('boulder')).toBe(false)
    expect(isReserved('my-community')).toBe(false)
  })
})

describe('check-subdomain: domain matching', () => {
  const mockApps = [
    {
      uuid: 'abc123',
      docker_compose_domains: [
        { name: 'opensocial', domain: 'https://cascadia.localnodes.xyz' }
      ]
    },
    {
      uuid: 'def456',
      docker_compose_domains: JSON.stringify([
        { name: 'opensocial', domain: 'https://boulder.localnodes.xyz' }
      ])
    },
    {
      uuid: 'ghi789',
      docker_compose_domains: null
    }
  ]

  it('detects taken subdomain when docker_compose_domains is an array', () => {
    expect(isDomainTaken('cascadia', mockApps)).toBe(true)
  })

  it('detects taken subdomain when docker_compose_domains is a JSON string', () => {
    expect(isDomainTaken('boulder', mockApps)).toBe(true)
  })

  it('returns false for available subdomain', () => {
    expect(isDomainTaken('portland', mockApps)).toBe(false)
  })

  it('handles null docker_compose_domains gracefully', () => {
    expect(isDomainTaken('anything', [{ uuid: 'x', docker_compose_domains: null }])).toBe(false)
  })

  it('handles empty apps array', () => {
    expect(isDomainTaken('cascadia', [])).toBe(false)
  })

  it('handles apps with missing docker_compose_domains field', () => {
    expect(isDomainTaken('cascadia', [{ uuid: 'x' }])).toBe(false)
  })
})
