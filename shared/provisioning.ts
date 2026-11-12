// Provisioning vocabulary shared by the server and the browser composable
// (app/composables/useProvisioningStatus.ts): the status list, the reason-code
// list and the state shape. One definition, so the lists cannot drift
// (research Pitfall 14). Provision contract v1, 23-03's interfaces block.
//
// No Node built-in may be imported here: the browser loads this file, and Vite
// refuses node:* in client code (23-20 moved callbackToken, which needs
// node:crypto, to server/utils/provision-handlers.ts for that reason).

// B-1 (23-32): a site that has installed reports ready, never complete. The
// sign-up app then takes the first payment: held while the bank asks the
// organizer to confirm (3DS), declined when the card is refused. Only the
// sign-up app writes complete, after the payment and the site's
// /localnodes/activate answer (23-35).
export const PROVISION_STATUSES = [
  'triggered',
  'provisioning',
  'installing',
  'creating_user',
  'sending_email',
  'ready',
  'held',
  'declined',
  'complete',
  'failed',
  // 23-43 Task 7: the page's own statuses for the automatic refund. The status
  // read projects the server's refunding (any sub-step) to refunding and a
  // proven refund (D2) to refunded; a site can never send either (CALLBACK_STATUSES).
  'refunding',
  'refunded'
] as const

export type ProvisionStatus = (typeof PROVISION_STATUSES)[number]

/**
 * What a site or the workflow may send to /api/provision-callback: the
 * building statuses, ready and failed. An explicit allow-list, not a filter
 * over PROVISION_STATUSES (23-43): a status added for the sign-up app's own
 * use (held, declined, complete, and the server-only tearing_down, torn_down,
 * refunding, refunded in server/utils/lifecycle.ts) can never become something
 * a site may send.
 */
export const CALLBACK_STATUSES = [
  'triggered',
  'provisioning',
  'installing',
  'creating_user',
  'sending_email',
  'ready',
  'failed'
] as const satisfies readonly ProvisionStatus[]

export type CallbackStatus = (typeof CALLBACK_STATUSES)[number]

/** Every community site lives at {subdomain}.localnodes.xyz. */
export const SITE_BASE_DOMAIN = 'localnodes.xyz'

/** The subdomain rule the checkout uses (shared/signup.ts): a DNS label, 3 to 63 characters. */
export const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * The closed table of failure reasons. The first ten come from the workflow
 * (23-03, "unknown" is the fallback); the last six from the entrypoint (23-12;
 * the two web3 codes from practice sites, pilot web3 plan B2 and B3).
 * Free text never travels: an unknown code is stored as "unknown".
 */
export const REASON_CODES = [
  'invalid_request',
  'coolify_unreachable',
  'subdomain_taken',
  'create_failed',
  'env_failed',
  'deploy_failed',
  'deploy_timeout',
  'install_timeout',
  'manifest_failed',
  'unknown',
  'install_failed',
  'db_not_empty',
  'platform_enable_failed',
  'organizer_failed',
  'web3_enable_failed',
  'web3_check_failed'
] as const

export type ReasonCode = (typeof REASON_CODES)[number]

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value)
}

/** 16 random bytes as base64url: 22 characters. */
export const PROVISION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

/**
 * What the sign-up app keeps for one site, in the hash provision:{stripeSessionId}.
 * There is no address, no site name and no sign-in link here (D-13): the
 * organizer's details live only in the signup:{provisionId} record.
 */
export interface ProvisioningState {
  status: ProvisionStatus
  subdomain: string
  provisionId: string
  /** 1 or 2: the current attempt. */
  attempt: number
  failedAttempts: number
  githubRunId?: number
  githubRunUrl?: string
  siteUrl?: string
  reason?: ReasonCode
  appUuid?: string
  canRetry?: boolean
  /** True once a sign-up has stopped after its second failure (T-3, 23-14). */
  stopped?: boolean
  /** The last attempt whose failure was counted (23-14). */
  countedAttempt?: number
  /** Milliseconds: a site's own "failed" counts after this, unless a "complete" comes first (23-14). */
  provisionalUntil?: number
  /** Written once the first invoice is paid (23-32); a provision with one is a paying customer and is never stopped. */
  subscriptionId?: string
  /** Where the first payment stands (23-32). */
  billing?: 'charging' | 'pending' | 'paid' | 'held' | 'declined' | 'rejected'
  /** Why billing is pending (api) or rejected (invalid, no_card). */
  billingError?: 'api' | 'invalid' | 'no_card' | 'no_price' | 'no_pilot_end' | 'pilot_not_free'
  /** Stripe API errors met so far; it also numbers the retried idempotency keys. */
  billingTries?: number
  /** The subscription before its first invoice is paid; 23-37's teardown cancels it. */
  pendingSubscriptionId?: string
  /** The first invoice; 23-37's teardown voids it. */
  invoiceId?: string
  /** Unix seconds: when Stripe created the subscription (the 23-hour hold counts from here). */
  subscriptionCreatedAt?: number
  paidAt?: string
  /** Milliseconds: a held payment must be confirmed before this (subscriptionCreatedAt + 23 hours). */
  heldUntil?: number
  activationTries?: number
  activatedAt?: string
  /** Why 23-37's teardown removes this site. */
  teardownReason?: 'declined' | 'held_expired' | 'build_failed'
  startedAt: string
  updatedAt: string
}
