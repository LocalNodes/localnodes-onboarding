// Security follow-up (2026-11-09): POST /api/invite/request keys its rate limit
// on the IP Vercel's proxy sets (server/utils/client-ip.ts), not on the first
// X-Forwarded-For value, which a client can prepend to. Same fix as early-access.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FakeRedis } from './helpers/fake-redis'
import { handleInviteRequest, type InviteMail, type RequestDeps } from '../../server/utils/invites'
import { hashIp } from '../../server/utils/early-access'
import { trustedClientIp } from '../../server/utils/client-ip'

const EMAIL = 'organizer@example.com'

function deps(redis: FakeRedis): RequestDeps {
  return {
    redis,
    secret: 'test-invite-hash-secret',
    sendMail: vi.fn(async (_m: InviteMail) => {}),
    keepAlive: () => {},
    floorMs: 0
  }
}

const limitKeys = (redis: FakeRedis) => redis.keys().filter(k => k.startsWith('rl:early-access:invite:'))

describe('invite request: the limit keys on the IP Vercel\'s proxy sets', () => {
  it('a spoofed leading X-Forwarded-For value can\'t rotate the limit key', async () => {
    const redis = new FakeRedis()
    for (const spoof of ['6.6.6.6', '7.7.7.7', '203.0.113.9', '']) {
      const xff = spoof ? `${spoof}, 1.2.3.4` : '1.2.3.4'
      const ip = trustedClientIp(new Headers({ 'x-forwarded-for': xff, 'x-real-ip': '1.2.3.4' }), '10.0.0.1')
      await handleInviteRequest({ email: EMAIL }, ip, deps(redis))
    }
    expect(limitKeys(redis)).toEqual([`rl:early-access:invite:${hashIp('1.2.3.4')}`])
  })

  it('control: two real client IPs do get two keys', async () => {
    const redis = new FakeRedis()
    for (const real of ['1.2.3.4', '5.6.7.8']) {
      await handleInviteRequest({ email: EMAIL }, trustedClientIp(new Headers({ 'x-real-ip': real }), '10.0.0.1'), deps(redis))
    }
    expect(limitKeys(redis)).toHaveLength(2)
  })

  it('the route keys on trustedClientIp, never on X-Forwarded-For (source guard)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/api/invite/request.post.ts'), 'utf8')
    const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(code).toMatch(/const ip = trustedClientIp\(event\.headers, event\.node\.req\.socket\?\.remoteAddress\)/)
    expect(code).not.toMatch(/xForwardedFor|x-forwarded-for|getRequestIP/i)
  })
})
