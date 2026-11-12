// Words for the /success page (fresh3 23-20; ONB-01, ONB-02, D-13, D-15, D-17,
// T-3, ruling C). Every string is a row of 23-UI-SPEC.md sections 4 to 7 and
// its "Reason codes" table, word for word: Title Case for the page titles and
// h1s, sentence case for the rest. Do not reword a string here; change the
// UI-SPEC first. npm run check:claims scans this file with the sign-up rules
// (signupSources in tests/fixtures/banned-claims.json).
//
// REASON_SENTENCES is the only place a failure code meets its sentence. The
// code itself is never shown, put in a link or logged to the page (T-23-01).
// REASON_SENTENCES are the build-failure sentences only (D-15): no payment
// wording. The payment screens (held, declined; 23-37) have their own rows.
import type { ReasonCode } from '#shared/provisioning'

export const REASON_SENTENCES: Record<ReasonCode, string> = {
  invalid_request: 'Your sign-up details couldn\'t be used to set up a site.',
  coolify_unreachable: 'Our hosting service didn\'t answer.',
  subdomain_taken: 'Someone else took the address you chose while we were setting up.',
  create_failed: 'We couldn\'t create your site on our hosting service.',
  env_failed: 'We couldn\'t finish configuring your site.',
  deploy_failed: 'We couldn\'t start your site.',
  deploy_timeout: 'Setting up your site took too long.',
  install_timeout: 'Setting up your site took too long.',
  manifest_failed: 'We couldn\'t finish setting up your site.',
  install_failed: 'We couldn\'t finish setting up your site.',
  db_not_empty: 'We couldn\'t finish setting up your site.',
  platform_enable_failed: 'We couldn\'t turn on your site\'s features.',
  organizer_failed: 'Your site is built, but we couldn\'t add you to it as its organizer.',
  web3_enable_failed: 'We couldn\'t turn on your site\'s features.',
  web3_check_failed: 'We couldn\'t turn on your site\'s features.',
  unknown: 'Something went wrong on our side.'
}

/** The sentence for a reason; a missing or unrecognised one reads as unknown. */
export function reasonSentence(reason: string | null | undefined): string {
  return reason && Object.hasOwn(REASON_SENTENCES, reason)
    ? REASON_SENTENCES[reason as ReasonCode]
    : REASON_SENTENCES.unknown
}

export const SUCCESS_COPY = {
  // Section 4, progress.
  progress: {
    title: 'Setting Up Your Site',
    intro: 'This usually takes a few minutes. We\'ll email you when it\'s ready.',
    retriedIntro: 'This usually takes a few minutes. We\'ll email you when it\'s ready.',
    underSteps: 'We\'ll email your sign-in link when your site is ready.',
    readError: 'Couldn\'t check your site\'s progress right now. We\'ll keep trying, and we\'ll email you.',
    // "Empty (no session)" (orchestrator, rule C, 2026-11-08).
    emptyTitle: 'Nothing to Show Here',
    emptyBody: 'There\'s nothing to show yet. Open the sign-in link from your email to set up your community\'s site.',
    emptyLink: 'Back to the home page'
  },
  // Section 5, failure and retry (T-3, ruling C).
  failed: {
    title: 'Setting Up Your Site',
    alert: 'Setting up your site didn\'t finish. You haven\'t been charged.',
    retryLine: 'Try setting up your site once more. If it still doesn\'t work, we\'ll stop. You won\'t be charged.',
    retry: 'Retry site setup',
    retrying: 'Retrying…',
    retryingAnnouncement: 'Retrying site setup.',
    retryFailed: 'We couldn\'t start the retry. Try again in a moment.',
    // (orchestrator, rule C, 2026-11-08, conditional on 23-38: true because the
    // sweep runs the stop when no one reads the status). Shown only on attempt 2
    // while the failure is unretried and unstopped (ruling point 1 (c), 2026-11-08).
    nextStep: 'We\'re finishing up and will email you about what happens next.'
  },
  // Section 6, stopped (T-3 replaces "Refunded").
  stopped: {
    title: 'We Couldn\'t Set Up Your Site',
    alert: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.',
    line: 'We\'ve emailed you the details.',
    home: 'Back to the LocalNodes home page'
  },
  // Section 6a, payment needs confirming (B-1, 3DS; approved under rule C,
  // 2026-11-08 afternoon, with Tom's answer 3: the button only for the browser
  // that made the sign-up). The body's time slot is filled by heldBody().
  held: {
    title: 'Confirm Your Payment',
    body: 'Your bank needs you to confirm the first payment. We\'ve emailed you a link. Your site is ready and waits for you until {time}.',
    button: 'Confirm my payment'
  },
  // Section 6b, card declined (B-1; Tom's words, approved under rule C).
  declined: {
    title: 'Your Card Was Declined',
    alert: 'Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.',
    button: 'Try again'
  },
  // Payment not confirmed: the 3DS hold ran out and the site was removed
  // ("Billing copy (B-1)", Q-held-expiry rows; browser title and h1 approved by
  // the orchestrator under rule C, 2026-11-08, to match the mail's subject).
  notConfirmed: {
    title: 'We\'ve Removed Your Site',
    alert: 'We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.',
    button: 'Try again'
  },
  // 23-43 Task 7, word for word from 23-UI-SPEC.md "Billing copy additions for
  // 23-43" (orchestrator, rule C, 2026-11-09). P3: a 3DS hold that ran out while
  // the delete is not yet confirmed; "You weren't charged" only when the status
  // reply's noCapture is true (otherwise P6's or P2's sentence, below).
  removing: {
    title: 'Removing Your Site',
    alert: 'We didn\'t get your payment confirmation in time, so we\'re removing your site. You weren\'t charged.',
    button: 'Try again'
  },
  // P6: shown only while the refund is in progress (status refunding), and as
  // the P3 fallback while a capture's refund is unproven. With lateActivation,
  // lateAlert only. No button.
  refunding: {
    title: 'Refunding Your Payment',
    alert: 'We couldn\'t finish setting up your site, so we\'re refunding your payment.',
    lateAlert: 'We\'re refunding your payment.'
  },
  // P2: only after the refund succeeded (D2: for exactly the amount captured).
  // With lateActivation, lateAlert only (the P1/P2 truth rule), plus "Try again".
  refunded: {
    title: 'We\'ve Refunded Your Payment',
    alert: 'We couldn\'t finish setting up your site, so we\'ve refunded your payment in full.',
    lateAlert: 'We\'ve refunded your payment in full.',
    button: 'Try again'
  },
  // Section 7, welcome (D-13: the sign-in link only ever goes by email).
  welcome: {
    title: 'Your Community\'s Site Is Ready',
    siteLine: 'Your site:',
    signIn: 'Check your email for your sign-in link.',
    open: 'Open your site',
    opensAnotherSite: '(opens another site)',
    stepsHeading: 'Your first three steps',
    steps: ['Set your password.', 'Open your group.', 'Upload your first files.'],
    guide: 'Read the organizer guide',
    home: 'Back to the LocalNodes home page'
  }
} as const

/** The browser title shape every sign-up page uses: "‹Page Title› - LocalNodes". */
export const pageTitle = (title: string) => `${title} - LocalNodes`

/**
 * The held screen's body (section 6a) with its one time slot filled: the end
 * of the hold, from shared/billing-time.ts formatHeldUntil in the reader's own
 * zone ("November 9, 2026 at 4:15pm MST"; Q-time, 2026-11-08).
 */
export function heldBody(time: string): string {
  return SUCCESS_COPY.held.body.replace('{time}', time)
}
