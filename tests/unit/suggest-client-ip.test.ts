// Security follow-up (2026-11-09): POST /api/suggest-topic-types keys its
// per-IP limit on the IP Vercel's proxy sets (server/utils/client-ip.ts), not
// on the first X-Forwarded-For value, which a client can prepend to.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FakeRedis } from './helpers/fake-redis'
import { suggestTopicTypes, type SuggestDeps } from '../../server/utils/topic-types'
import { hashIp } from '../../server/utils/early-access'
import { trustedClientIp } from '../../server/utils/client-ip'

const DESCRIPTION = 'We are a tenants association that shares meeting notes and repair guides.'

function deps(redis: FakeRedis, ip: string | undefined): SuggestDeps {
  const reply = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: '["Meeting notes"]' }] } }] }) }
  return {
    fetch: vi.fn(async () => reply) as unknown as SuggestDeps['fetch'],
    apiKey: 'test-gemini-key-not-real',
    model: 'test-model-1',
    inviteId: 'invite-aaaaaaaaaaaaaaaaaaaa',
    ipHash: hashIp(ip),
    redis,
    timeoutMs: 8000
  }
}

const ipKeys = (redis: FakeRedis) => redis.keys().filter(k => k.includes('suggest:ip:'))

describe('suggest-topic-types: the per-IP limit keys on the IP Vercel\'s proxy sets', () => {
  it('a spoofed leading X-Forwarded-For value can\'t rotate the limit key', async () => {
    const redis = new FakeRedis()
    for (const spoof of ['6.6.6.6', '7.7.7.7', '203.0.113.9', '']) {
      const xff = spoof ? `${spoof}, 1.2.3.4` : '1.2.3.4'
      const ip = trustedClientIp(new Headers({ 'x-forwarded-for': xff, 'x-real-ip': '1.2.3.4' }), '10.0.0.1')
      await suggestTopicTypes({ description: DESCRIPTION }, deps(redis, ip))
    }
    expect(ipKeys(redis)).toEqual([`rl:early-access:suggest:ip:${hashIp('1.2.3.4')}`])
  })

  it('control: two real client IPs do get two keys', async () => {
    const redis = new FakeRedis()
    for (const real of ['1.2.3.4', '5.6.7.8']) {
      await suggestTopicTypes({ description: DESCRIPTION }, deps(redis, trustedClientIp(new Headers({ 'x-real-ip': real }), '10.0.0.1')))
    }
    expect(ipKeys(redis)).toHaveLength(2)
  })

  it('the route keys on trustedClientIp, never on X-Forwarded-For (source guard)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/api/suggest-topic-types.post.ts'), 'utf8')
    const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(code).toMatch(/ipHash: hashIp\(trustedClientIp\(event\.headers, event\.node\.req\.socket\?\.remoteAddress\)\)/)
    expect(code).not.toMatch(/xForwardedFor|x-forwarded-for|getRequestIP/i)
  })
})
