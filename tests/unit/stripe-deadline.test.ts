// Code review fix round 1, C3 (23-43-CODE-REVIEW.md; the round-2 ruling H1):
// a Stripe call's total deadline must abort the transport, not only stop the
// app waiting. stripe-node 20.4.0's RequestOptions has no signal
// (types/lib.d.ts RequestOptions), and its default Node client only has an
// inactivity timer (cjs/net/NodeHttpClient.js:46). So the client is built on
// Stripe.createFetchHttpClient (cjs/stripe.core.js:115, built in) with a fetch
// that joins the call's deadline signal (stripe-deadline.ts), and stripeCall
// hands its signal through.
//
// The transport is real here: stripe-node's own FetchHttpClient and Node's
// fetch against a throwaway HTTP server on 127.0.0.1. Only the fetch function
// is wrapped by a spy, so the test sees the signal the transport was given.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import Stripe from 'stripe'
import { DeadlineError, STRIPE_TIMEOUT_MS, stripeCall, stripeOptions } from '../../server/utils/lifecycle'
import { deadlineFetch, stripeHttpClient, withStripeSignal } from '../../server/utils/stripe-deadline'

type Mode = 'hang' | 'trickle' | 'json'

interface Local {
  port: number
  closed: () => number
  server: Server
}

const servers: Server[] = []
const opened: ServerResponse[] = []

/** A local stand-in for api.stripe.com: hang (a connect that never answers), trickle (headers, then a body that never ends) or json. */
async function local(mode: Mode): Promise<Local> {
  let closed = 0
  const server = createServer((req, res) => {
    req.on('close', () => { closed++ })
    res.on('close', () => { closed++ })
    opened.push(res)
    if (mode === 'hang') return
    if (mode === 'trickle') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Request-Id': 'req_local' })
      res.write('{"id": "in_1", ')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Request-Id': 'req_local' })
    res.end(JSON.stringify({ id: 'cs_local', object: 'checkout.session', url: 'https://checkout.stripe.com/c/pay/cs_local' }))
  })
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  return { port: (server.address() as AddressInfo).port, closed: () => closed, server }
}

function client(port: number, fetchFn: typeof fetch) {
  return new Stripe('sk_test_local', { host: '127.0.0.1', port, protocol: 'http', maxNetworkRetries: 0, httpClient: stripeHttpClient(fetchFn) })
}

/** A spy over the real fetch: records the signal the transport handed it. */
function spyFetch() {
  const seen: AbortSignal[] = []
  const fn = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.signal) seen.push(init.signal)
    return globalThis.fetch(input, init)
  })
  return { fn: fn as unknown as typeof fetch, seen, spy: fn }
}

afterEach(async () => {
  opened.splice(0).forEach(r => r.destroy())
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
})

describe('C3: a Stripe deadline aborts the transport (stripe-node 20.4.0, createFetchHttpClient)', () => {
  it('a connect that never answers: at the deadline the fetch the transport made sees the abort, the reason is the DeadlineError, and the server sees the socket close', async () => {
    const srv = await local('hang')
    const f = spyFetch()
    const stripe = client(srv.port, f.fn)
    const started = performance.now()
    const call = stripeCall(o => stripe.invoices.retrieve('in_1', {}, o), 300)
    await expect(call).rejects.toBeInstanceOf(DeadlineError)
    expect(performance.now() - started).toBeLessThan(5000)
    expect(f.spy).toHaveBeenCalledTimes(1)
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]!.aborted).toBe(true)
    expect(f.seen[0]!.reason).toBeInstanceOf(DeadlineError)
    await vi.waitFor(() => expect(srv.closed()).toBeGreaterThan(0), { timeout: 3000, interval: 20 })
  })

  it('a body that trickles in: headers at once, the body never ends; the deadline aborts the body read too and the server sees the socket close', async () => {
    const srv = await local('trickle')
    const f = spyFetch()
    const stripe = client(srv.port, f.fn)
    const call = stripeCall(o => stripe.invoices.retrieve('in_1', {}, o), 300)
    await expect(call).rejects.toBeInstanceOf(DeadlineError)
    expect(f.seen[0]!.aborted).toBe(true)
    expect(f.seen[0]!.reason).toBeInstanceOf(DeadlineError)
    await vi.waitFor(() => expect(srv.closed()).toBeGreaterThan(0), { timeout: 3000, interval: 20 })
  })

  it('stripeCall still passes timeout STRIPE_TIMEOUT_MS and maxNetworkRetries 0, and its default deadline is STRIPE_TIMEOUT_MS', async () => {
    expect(stripeOptions()).toEqual({ timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: 0 })
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      let settled: unknown = 'pending'
      const fetchFn = vi.fn((_u: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      })
      // The fetch is called inside the store the deadline set up (the signal is joined synchronously).
      const call = stripeCall(() => withStripeSignalProbe(fetchFn as unknown as typeof fetch))
      call.then(v => { settled = v }, e => { settled = e })
      await vi.advanceTimersByTimeAsync(STRIPE_TIMEOUT_MS - 1)
      expect(settled).toBe('pending')
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBeInstanceOf(DeadlineError)
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a call outside any deadline (checkout, the price read, the webhook) behaves as before: the fetch gets only the client\'s own signal, the request answers, and the client is the fetch client', async () => {
    const srv = await local('json')
    const f = spyFetch()
    const stripe = client(srv.port, f.fn)
    const session = await stripe.checkout.sessions.create({ mode: 'setup', currency: 'usd', success_url: 'https://localnodes.xyz/success', cancel_url: 'https://localnodes.xyz/cancel' })
    expect(session.id).toBe('cs_local')
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0]!.aborted).toBe(false)
    expect(stripeHttpClient(f.fn).getClientName()).toBe('fetch')
  })

  it('deadlineFetch joins the deadline with the transport\'s own signal: either one aborts the request', async () => {
    const own = new AbortController()
    const deadline = new AbortController()
    let got: AbortSignal | undefined
    const base = vi.fn((_u: unknown, init?: RequestInit) => {
      got = init?.signal ?? undefined
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch
    await withStripeSignal(deadline.signal, () => deadlineFetch(base)('http://127.0.0.1/x', { signal: own.signal }))
    expect(got).toBeDefined()
    expect(got).not.toBe(own.signal)
    deadline.abort(new DeadlineError(1))
    expect(got!.aborted).toBe(true)
    // And the transport's own timeout still aborts it.
    let got2: AbortSignal | undefined
    const own2 = new AbortController()
    const base2 = vi.fn((_u: unknown, init?: RequestInit) => {
      got2 = init?.signal ?? undefined
      return Promise.resolve(new Response('{}'))
    }) as unknown as typeof fetch
    await withStripeSignal(new AbortController().signal, () => deadlineFetch(base2)('http://127.0.0.1/x', { signal: own2.signal }))
    own2.abort()
    expect(got2!.aborted).toBe(true)
  })
})

/** Calls a fetch through deadlineFetch from inside stripeCall's work, as stripe-node's client does. */
function withStripeSignalProbe(base: typeof fetch): Promise<Response> {
  return deadlineFetch(base)('http://127.0.0.1/probe', { signal: new AbortController().signal })
}

describe('C3 wiring: useStripe builds its client on the deadline-aware fetch client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('useStripe() uses createFetchHttpClient with deadlineFetch: a call under withStripeSignal reaches the transport with the deadline joined', async () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ stripeSecretKey: 'sk_test_wiring' }))
    vi.resetModules()
    const { useStripe } = await import('../../server/utils/stripe')
    const stripe = useStripe() as unknown as { getApiField: (k: string) => { getClientName: () => string } }
    expect(stripe.getApiField('httpClient').getClientName()).toBe('fetch')
    // The client's fetch is ours: under a deadline the global fetch it calls sees the joined signal.
    const deadline = new AbortController()
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }))
    const { withStripeSignal: inStore } = await import('../../server/utils/stripe-deadline')
    void inStore(deadline.signal, () => (useStripe() as Stripe).invoices.retrieve('in_1')).catch(() => {})
    await vi.waitFor(() => expect(seen).toBeDefined(), { timeout: 3000, interval: 10 })
    expect(seen!.aborted).toBe(false)
    deadline.abort(new DeadlineError(1))
    expect(seen!.aborted).toBe(true)
  })
})
