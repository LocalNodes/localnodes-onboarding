// The transport side of a Stripe call's total deadline (23-43 code review fix
// round 1, C3; the round-2 ruling H1: "one total deadline ... covering connect
// and body"). Plain leaf module: no Nuxt, no lifecycle import, so stripe.ts and
// lifecycle.ts can both use it.
//
// Why a side channel. stripe-node 20.4.0's RequestOptions has no signal
// (node_modules/stripe/types/lib.d.ts, RequestOptions: apiKey, idempotencyKey,
// stripeAccount, stripeContext, apiVersion, maxNetworkRetries, timeout, host),
// and its default Node client only arms an inactivity timer
// (cjs/net/NodeHttpClient.js:46, req.setTimeout; the body read at :90 has none),
// so a call raced against a deadline kept its request alive after the race was
// lost. The built-in Stripe.createFetchHttpClient(fetchFn)
// (cjs/stripe.core.js:115, cjs/platform/PlatformFunctions.js:73) calls fetchFn
// per request with its own AbortController signal for the request timeout
// (cjs/net/FetchHttpClient.js:56-80). deadlineFetch wraps that fetch: inside
// withStripeSignal (stripeCall in lifecycle.ts) it joins the call's deadline
// signal to the client's own with AbortSignal.any, so the deadline aborts the
// connect and the body read (fetch's body stream honours the same signal).
// Outside any deadline (checkout, the price read, webhooks) it passes the
// request through untouched. AsyncLocalStorage carries the signal through
// stripe-node's promise chain; no new dependency.
import { AsyncLocalStorage } from 'node:async_hooks'
import Stripe from 'stripe'

const deadlineStore = new AsyncLocalStorage<AbortSignal>()

/** Run work with this deadline signal joined to every Stripe request it makes. */
export function withStripeSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return deadlineStore.run(signal, work)
}

/**
 * A fetch for Stripe's FetchHttpClient that honours the current deadline. The
 * base fetch is read at call time (globalThis.fetch by default).
 */
export function deadlineFetch(base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const fetchFn = base ?? globalThis.fetch
    const deadline = deadlineStore.getStore()
    if (!deadline) return fetchFn(input, init)
    const own = init?.signal
    const signal = own ? AbortSignal.any([own, deadline]) : deadline
    return fetchFn(input, { ...init, signal })
  }
}

/** The HTTP client every Stripe client here uses (stripe.ts useStripe). */
export function stripeHttpClient(base?: typeof fetch) {
  return Stripe.createFetchHttpClient(deadlineFetch(base))
}
