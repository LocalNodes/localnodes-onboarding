// The client IP a rate limit can trust (security follow-up, 2026-11-09).
// Plain module, no Nitro globals, so tests import it directly.
//
// h3's getRequestIP(event, { xForwardedFor: true }) returns the FIRST
// X-Forwarded-For value, which is the one a client controls when any proxy
// appends to the header. On Vercel the proxy sets x-real-ip to the client's
// public IP ("Client IP as calculated by Vercel Proxy", @vercel/functions
// headers.d.ts IP_HEADER_NAME; Vercel docs, Request headers: x-real-ip "is
// identical to the x-forwarded-for header", which Vercel overwrites "to prevent
// IP spoofing", https://vercel.com/docs/headers/request-headers, read
// 2026-11-09). ipAddress() from @vercel/functions reads exactly that header.
//
// Off Vercel (local dev, preview) there is no x-real-ip: fall back to the
// socket address, never to X-Forwarded-For, so a spoofed value can't rotate
// the limit key there either.
import { ipAddress } from '@vercel/functions'

export function trustedClientIp(headers: Headers, socketAddress: string | undefined): string | undefined {
  const fromVercel = ipAddress(headers)?.trim()
  return fromVercel || socketAddress || undefined
}
