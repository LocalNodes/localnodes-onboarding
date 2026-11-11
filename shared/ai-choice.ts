// The AI choice on the sign-up form (Phase 23, plan 23-18; D-19, D-21).
// Plain module, no Nitro or Nuxt globals: the key route and checkout import
// the messages, and the form (23-19) renders the copy from here.
//
// Every string is a row of 23-UI-SPEC.md section 3, word for word. Do not
// reword one here; change the UI-SPEC first. npm run check:claims scans this
// file with the sign-up rules (signupSources in tests/fixtures/banned-claims.json).

export const AI_CHOICES = ['default', 'gemini', 'openrouter'] as const
export type AiChoice = typeof AI_CHOICES[number]

/**
 * The OpenRouter choice is hidden until a model passes the citation bar
 * (23-18 follow-up, 2026-11-08: no OpenRouter model passed the re-score under
 * Tom's rule). runtimeConfig openRouterChoiceEnabled, set by
 * NUXT_OPENROUTER_CHOICE_ENABLED, is on only for true or 'true'; anything
 * else ("1", unset, false) is off. While off, the form hides Option 3 and the
 * key route and checkout refuse openrouter. The OpenRouter code stays.
 */
export function isOpenRouterChoiceEnabled(value: unknown): boolean {
  return value === true || value === 'true'
}

/** The two choices where the organizer brings a key. */
export const OWN_KEY_KINDS = ['gemini', 'openrouter'] as const
export type OwnKeyKind = typeof OWN_KEY_KINDS[number]

export const AI_CHOICE_COPY = {
  legend: 'Which AI should your site use?',
  help: 'This sets up your site\'s AI assistant and search.',
  options: [
    { value: 'default', label: 'The LocalNodes default', description: 'No setup. We cover the cost, with a limit per site.' },
    { value: 'gemini', label: 'Your own Gemini key', description: 'Use a key from your own Google Cloud project.' },
    { value: 'openrouter', label: 'Your own OpenRouter key', description: 'Use a key from your own OpenRouter account.' }
  ] as ReadonlyArray<{ value: AiChoice, label: string, description: string }>,
  keyLabel: { gemini: 'Gemini key', openrouter: 'OpenRouter key' } as Record<OwnKeyKind, string>,
  keyHelp: 'Paste your key. We check it once, then keep it only until your site is set up. We never show it again.',
  checkButton: 'Check key',
  checkButtonWorking: 'Checking…',
  keyChecked: 'Key checked',
  replaceKey: 'Replace key',
  geminiCheckbox: 'This key is from a Google Cloud project with billing turned on',
  /** Shown under Option 3 (D-21). */
  openRouterZdrLine: 'Turn on Zero Data Retention in your OpenRouter privacy settings, so the companies that run the AI don\'t keep your community\'s text.',
  /**
   * Shown under Option 3 (orchestrator, rule C, 2026-11-08) until todo
   * 2026-11-08-openrouter-member-recall closes; then it is removed.
   */
  openRouterRecallLine: 'Works with your own OpenRouter key; answers may find fewer members-only notes than the default for now.'
} as const

/** Key failed (also the reply for an empty or malformed key). */
export const KEY_FAILED_MESSAGE = 'That key didn\'t work. Check you copied all of it, then try again.'
/** Too many key checks. */
export const TOO_MANY_KEY_CHECKS_MESSAGE = 'Too many checks. Wait a few minutes, then try again.'
/** Key not checked at submit: checkout found no checked key of the chosen kind for this session. */
export const KEY_NOT_CHECKED_MESSAGE = 'Check your key before continuing.'
/** Gemini checkbox not ticked. */
export const GEMINI_BILLING_MESSAGE = 'Confirm the key\'s project has billing turned on.'
/** Server error: the same row the invite pages use (app/utils/invite-flow.ts). */
export const SERVER_ERROR_MESSAGE = 'Something went wrong on our side. Try again in a minute.'

/** The lines shown under the selected option, in order. Only Option 3 has any. */
export function aiChoiceNotes(choice: AiChoice): string[] {
  if (choice === 'openrouter') return [AI_CHOICE_COPY.openRouterZdrLine, AI_CHOICE_COPY.openRouterRecallLine]
  return []
}
