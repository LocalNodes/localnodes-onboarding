// The invite pages' logic (fresh3 23-28, D-01, D-24), tested without a browser:
// what the link landing reads from the address, what each answer from
// /api/invite/request and /api/invite/verify turns into, and the approved copy
// word for word (23-UI-SPEC sections 1 and 2).
import { describe, it, expect, vi } from 'vitest'
import {
  INVITE_COPY,
  RESEND_WAIT_SECONDS,
  consumeSignInLink,
  isPlausibleEmail,
  requestSignInLink,
  tokenFromHash
} from '~/utils/invite-flow'

const TOKEN = 'A'.repeat(20) + 'b-_' + '9'.repeat(20) // 43 base64url characters

/** A fetcher that throws the way ofetch does: statusCode and status on the error. */
function failing(statusCode: number) {
  return vi.fn(async () => {
    throw Object.assign(new Error(`fetch failed ${statusCode}`), { statusCode, status: statusCode })
  })
}

describe('tokenFromHash: the link keeps its token in the fragment as #t=<token>', () => {
  it('reads the token from "#t=<43 characters>"', () => {
    expect(tokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN)
  })
  it('gives null for an empty address fragment', () => {
    expect(tokenFromHash('')).toBeNull()
    expect(tokenFromHash('#')).toBeNull()
  })
  it('gives null when the fragment is not the t= form', () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBeNull()
    expect(tokenFromHash(`#token=${TOKEN}`)).toBeNull()
  })
  it('gives null for a token of the wrong length or with other characters', () => {
    expect(tokenFromHash('#t=short')).toBeNull()
    expect(tokenFromHash(`#t=${TOKEN}x`)).toBeNull()
    expect(tokenFromHash(`#t=${'!'.repeat(43)}`)).toBeNull()
  })
  it('never reads a token from a query string', () => {
    expect(tokenFromHash(`?t=${TOKEN}`)).toBeNull()
  })
})

describe('isPlausibleEmail', () => {
  it('accepts an ordinary address and trims spaces', () => {
    expect(isPlausibleEmail('name@example.org')).toBe(true)
    expect(isPlausibleEmail('  name@example.org ')).toBe(true)
  })
  it('refuses a missing @, a missing domain and an empty field', () => {
    for (const bad of ['', 'name', 'name@', '@example.org', 'name@example', 'a b@example.org']) {
      expect(isPlausibleEmail(bad), bad).toBe(false)
    }
  })
})

describe('requestSignInLink', () => {
  it('posts the address and the honeypot value to /api/invite/request', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, message: 'whatever the server says' }))
    const result = await requestSignInLink(fetcher, 'name@example.org', '')
    expect(result).toEqual({ kind: 'sent' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/invite/request', {
      method: 'POST',
      body: { email: 'name@example.org', hpField: '' }
    })
  })
  it('a filled honeypot is sent as it is and still gets the sent result', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    await expect(requestSignInLink(fetcher, 'bot@example.org', 'filled')).resolves.toEqual({ kind: 'sent' })
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ body: { hpField: 'filled' } })
  })
  it('the result never carries the server message or the address back', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, message: 'sent to name@example.org' }))
    const result = await requestSignInLink(fetcher, 'name@example.org', '')
    expect(JSON.stringify(result)).not.toContain('example.org')
  })
  it('a 400 means the address was not an email address', async () => {
    await expect(requestSignInLink(failing(400), 'x', '')).resolves.toEqual({ kind: 'invalid' })
  })
  it('a 429 means too many tries', async () => {
    await expect(requestSignInLink(failing(429), 'name@example.org', '')).resolves.toEqual({ kind: 'too-many' })
  })
  it('any other failure is a server error, and a network error too', async () => {
    await expect(requestSignInLink(failing(500), 'name@example.org', '')).resolves.toEqual({ kind: 'server-error' })
    await expect(requestSignInLink(failing(502), 'name@example.org', '')).resolves.toEqual({ kind: 'server-error' })
    const noStatus = vi.fn(async () => { throw new Error('offline') })
    await expect(requestSignInLink(noStatus, 'name@example.org', '')).resolves.toEqual({ kind: 'server-error' })
  })
})

describe('consumeSignInLink: only a call here spends the token', () => {
  it('posts {token} to /api/invite/verify and answers ok', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }))
    await expect(consumeSignInLink(fetcher, TOKEN)).resolves.toBe('ok')
    expect(fetcher).toHaveBeenCalledWith('/api/invite/verify', { method: 'POST', body: { token: TOKEN } })
  })
  it('a refusal (400) is "refused", the one answer for forged, used and expired', async () => {
    await expect(consumeSignInLink(failing(400), TOKEN)).resolves.toBe('refused')
  })
  it('a server error leaves the button usable and is not a refusal', async () => {
    await expect(consumeSignInLink(failing(500), TOKEN)).resolves.toBe('server-error')
    const offline = vi.fn(async () => { throw new Error('offline') })
    await expect(consumeSignInLink(offline, TOKEN)).resolves.toBe('server-error')
  })
  it('a 200 whose body says not ok is treated as a refusal', async () => {
    const fetcher = vi.fn(async () => ({ ok: false }))
    await expect(consumeSignInLink(fetcher, TOKEN)).resolves.toBe('refused')
  })
})

describe('approved copy (23-UI-SPEC sections 1 and 2), word for word', () => {
  it('invite entry', () => {
    expect(INVITE_COPY.entry).toMatchObject({
      title: 'Use Your Invite',
      intro: 'Enter the email your invite went to. We\'ll send you a link to start setting up your community\'s site.',
      fieldLabel: 'Email',
      button: 'Send my sign-in link',
      buttonWorking: 'Sending…',
      sentHeading: 'Check your email',
      sentReply: 'If this address is invited, we\'ve sent a sign-in link. It works once, for 15 minutes.',
      waitSentence: 'You can send it again in a minute.',
      resendButton: 'Send it again',
      resendAnnouncement: 'You can send the link again.',
      invalidEmail: 'This isn\'t an email address. Check it has an @ and a domain, like name@example.org.',
      summaryHeading: 'Fix these to continue',
      tooManyTries: 'Too many tries from this connection. Wait a few minutes, then try again.',
      serverError: 'Something went wrong on our side. Try again in a minute.',
      helpLink: 'How we handle your details'
    })
  })
  it('link landing', () => {
    expect(INVITE_COPY.verify).toMatchObject({
      title: 'Your Invite Link',
      intro: 'Your link is ready. Continue to start setting up your community\'s site.',
      button: 'Continue to sign-up',
      buttonWorking: 'Checking…',
      refused: 'This link has expired or was already used. Ask for a new one.',
      newLink: 'Get a new sign-in link',
      serverError: 'Something went wrong on our side. Try again in a minute.',
      goingOn: 'Taking you to sign-up.'
    })
  })
  it('the resend wait is 60 seconds', () => {
    expect(RESEND_WAIT_SECONDS).toBe(60)
  })
  it('the page titles are Title Case (R4)', () => {
    expect(INVITE_COPY.entry.title).toBe('Use Your Invite')
    expect(INVITE_COPY.verify.title).toBe('Your Invite Link')
  })
})
