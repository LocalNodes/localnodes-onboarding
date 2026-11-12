// The shape of a pilot continue token (fresh3 23, pilot end): base64url of the
// sealed subscription id and end (server/utils/pilot-end.ts). Plain module,
// shared by the server, which opens the token, and the /pilot/continue page,
// which only checks the shape so a mangled link gets its message with no request.
export const PILOT_CONTINUE_TOKEN_RE = /^[A-Za-z0-9_-]{40,1024}$/

/**
 * What the continue route answers. lapsed: the free end has passed and the
 * site can still be kept; checkout: the answer to a late yes, with the address
 * of Stripe's payment page; confirming: that page was paid and Stripe is still
 * confirming it.
 */
export type PilotContinueState = 'ends' | 'lapsed' | 'checkout' | 'confirming' | 'continued' | 'ended' | 'invalid' | 'unavailable'
