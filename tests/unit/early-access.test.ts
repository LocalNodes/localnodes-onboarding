// Early-access list (Tom, 2026-11-06, PR #9): validation, honeypot, rate
// limit, one reply for every accepted request, the email never logged.
import { describe, it, expect, vi } from 'vitest'
import { handleEarlyAccess, addResendContact, ACCEPTED, hashIp, type Deps } from '../../server/utils/early-access'

const EMAIL = 'organizer@example.com'

function deps(over: Partial<Deps> = {}) {
  const logs: string[] = []
  const d: Deps & { logs: string[] } = {
    configured: true,
    allow: vi.fn(async () => true),
    addContact: vi.fn(async () => {}),
    log: (m: string) => { logs.push(m) },
    logs,
    ...over
  }
  return d
}

describe('early access: handler', () => {
  it('adds a valid email, trimmed and lower-cased, with the optional fields', async () => {
    const d = deps()
    const r = await handleEarlyAccess({ email: '  Organizer@Example.com ', community: 'Repair Collective', groupKind: 'Co-op' }, '1.2.3.4', d)
    expect(r).toEqual({ status: 200, body: ACCEPTED })
    expect(d.addContact).toHaveBeenCalledWith({ email: EMAIL, community: 'Repair Collective', groupKind: 'Co-op' })
  })

  it('rejects an invalid email server-side without calling Resend', async () => {
    const d = deps()
    for (const email of ['', 'not-an-email', 'a@', 'x'.repeat(250) + '@example.com']) {
      const r = await handleEarlyAccess({ email }, '1.2.3.4', d)
      expect(r.status).toBe(400)
    }
    expect(await handleEarlyAccess(null, '1.2.3.4', d)).toMatchObject({ status: 400 })
    expect(await handleEarlyAccess({ email: EMAIL, community: 'x'.repeat(81) }, '1.2.3.4', d)).toMatchObject({ status: 400 })
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('a filled honeypot gets the same reply and adds nothing', async () => {
    const d = deps()
    const r = await handleEarlyAccess({ email: EMAIL, hpField: 'http://spam.example' }, '1.2.3.4', d)
    expect(r).toEqual({ status: 200, body: ACCEPTED })
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('an email already on the list (Resend refuses) gets the same reply as a new one', async () => {
    const fresh = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', deps())
    const dupe = deps({ addContact: vi.fn(async () => { throw Object.assign(new Error(`Contact ${EMAIL} already exists`), { statusCode: 409 }) }) })
    const again = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', dupe)
    expect(again).toEqual(fresh)
    expect(JSON.stringify(again)).not.toContain(EMAIL)
  })

  it('never logs the email address, even when Resend errors with it in the message', async () => {
    const spy = vi.spyOn(console, 'log')
    const err = vi.spyOn(console, 'error')
    const d = deps({ addContact: vi.fn(async () => { throw Object.assign(new Error(`bad ${EMAIL}`), { statusCode: 422 }) }) })
    await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    expect(d.logs.join('\n')).not.toContain(EMAIL)
    expect(d.logs.join('\n')).toContain('422')
    expect(spy.mock.calls.flat().join(' ')).not.toContain(EMAIL)
    expect(err.mock.calls.flat().join(' ')).not.toContain(EMAIL)
    spy.mockRestore(); err.mockRestore()
  })

  it('returns 429 once the per-IP limit is spent, and rate-limits by a hash, not the IP', async () => {
    const seen: string[] = []
    const d = deps({ allow: vi.fn(async (h: string) => { seen.push(h); return false }) })
    const r = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    expect(r.status).toBe(429)
    expect(d.addContact).not.toHaveBeenCalled()
    expect(seen[0]).toBe(hashIp('1.2.3.4'))
    expect(seen[0]).not.toContain('1.2.3.4')
  })

  it('says not open yet (503) when the list is not configured, adding nothing', async () => {
    const d = deps({ configured: false })
    const r = await handleEarlyAccess({ email: EMAIL }, '1.2.3.4', d)
    expect(r.status).toBe(503)
    expect(d.addContact).not.toHaveBeenCalled()
  })
})

describe('early access: Resend contact', () => {
  it('posts to /contacts with the segment id, subscribed, and the properties', async () => {
    const fetcher = vi.fn(async () => ({ object: 'contact', id: 'c1' }))
    await addResendContact({ email: EMAIL, community: 'Repair Collective', groupKind: 'Co-op' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, opts] = fetcher.mock.calls[0] as unknown as [string, { headers: Record<string, string>, body: Record<string, unknown> }]
    expect(url).toBe('https://api.resend.com/contacts')
    expect(opts.headers.Authorization).toBe('Bearer re_test')
    expect(opts.body).toEqual({ email: EMAIL, unsubscribed: false, segments: [{ id: 'seg_1' }], properties: { community_name: 'Repair Collective', group_kind: 'Co-op' } })
  })

  it('retries once without properties when Resend refuses them, so the address is kept', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('property not found'), { statusCode: 422 }))
      .mockResolvedValueOnce({ object: 'contact', id: 'c1' })
    await addResendContact({ email: EMAIL, community: 'Repair Collective', groupKind: '' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect((fetcher.mock.calls[1] as unknown as [string, { body: Record<string, unknown> }])[1].body).toEqual({ email: EMAIL, unsubscribed: false, segments: [{ id: 'seg_1' }] })
  })

  it('sends no properties when the optional fields are empty', async () => {
    const fetcher = vi.fn(async () => ({}))
    await addResendContact({ email: EMAIL, community: '', groupKind: '' }, 're_test', 'seg_1', fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body).not.toHaveProperty('properties')
  })
})
