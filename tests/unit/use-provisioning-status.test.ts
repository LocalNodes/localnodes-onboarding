// The /success page's status poll, failure, retry, stop and welcome (fresh3
// 23-20; ONB-01, ONB-02, D-13, D-15, D-17, T-3, ruling C; 23-UI-SPEC.md
// sections 4 to 7 and "Reason codes"). Every behaviour bullet of the plan's
// Task 1 has a named test below:
//   - "polling stops on complete", "… on stopped", "… on failed with a retry
//     offered" and "keeps polling on failed with no retry and not stopped"
//     (bullet 1; the last one follows 23-14: the page drives the 10-minute
//     settle and a stop in progress by polling)
//   - "the first step reads Card saved", "the failed state shows the two T-3
//     lines", "the stopped state shows the Board 6 copy and no retry button"
//     (bullet 2)
//   - "retry() POSTs the session id to /api/retry-provisioning and resumes
//     polling" (bullet 3)
//   - "REASON_SENTENCES has an entry for every REASON_CODES value" (bullet 4)
//   - "the returned object has no sign-in field" (bullet 5)
//
// 23-38 (Task 2, with the orchestrator's ruling point 1 (c), 2026-11-08): the
// line "We're finishing up and will email you about what happens next." shows
// under the alert only when the state is failed, canRetry false, stopped false
// and the attempt is 2. Its tests: "the next-step line is the approved
// sentence", "the composable exposes the attempt number from the status
// reply", the "next-step line matrix", "a failure with no retry offered and
// not yet stopped, on attempt 2, shows the alert and the next-step line", "…
// on attempt 1, shows the alert only", and "the next-step line is read only by
// ProvisioningFailed.vue".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createSSRApp, defineComponent, h, ref, nextTick, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'

// Mock $fetch globally before importing the composable (Nuxt auto-import)
vi.stubGlobal('$fetch', vi.fn())

// Mock @vueuse/core so we can drive the polling callback manually and avoid
// real timers. The pure helpers (getStageIndex, etc.) don't use these at
// runtime, so mocking @vueuse/core does not affect them.
//
// - useTimeoutPoll: capture the poll callback (don't auto-run it via a real
//   timer). `pollHarness.run()` invokes the captured callback so tests stay
//   deterministic. `pause` and `resume` are spies so we can assert polling
//   stops and starts again.
// - useCountdown: return a controllable `remaining` ref + spy `pause`/`start`.
const pollHarness: {
  fn: (() => void | Promise<void>) | null
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  run: () => Promise<void>
} = {
  fn: null,
  pause: vi.fn(),
  resume: vi.fn(),
  run: async () => {
    if (pollHarness.fn) await pollHarness.fn()
  }
}

const countdownHarness = {
  remaining: ref(240),
  pause: vi.fn(),
  start: vi.fn()
}

vi.mock('@vueuse/core', () => ({
  useTimeoutPoll: (fn: () => void | Promise<void>, _interval: number, _opts?: unknown) => {
    pollHarness.fn = fn
    return { pause: pollHarness.pause, resume: pollHarness.resume, isActive: ref(false) }
  },
  useCountdown: (_initial: number) => ({
    remaining: countdownHarness.remaining,
    pause: countdownHarness.pause,
    resume: vi.fn(),
    start: countdownHarness.start,
    stop: vi.fn(),
    reset: vi.fn()
  })
}))

import {
  STAGES,
  getStageIndex,
  formatTimeRemaining,
  mapStagesToState,
  shouldStopPolling,
  timeLine,
  useProvisioningStatus
} from '~/composables/useProvisioningStatus'
import { REASON_SENTENCES, SUCCESS_COPY, reasonSentence } from '~/utils/reason-copy'
import { PROVISION_STATUSES, REASON_CODES } from '../../shared/provisioning'
import ProvisioningProgress from '../../app/components/ProvisioningProgress.vue'
import SuccessPage from '../../app/pages/success.vue'
import ProvisioningComplete from '../../app/components/ProvisioningComplete.vue'
import ProvisioningFailed from '../../app/components/ProvisioningFailed.vue'
import PaymentHeld from '../../app/components/PaymentHeld.vue'
import PaymentDeclined from '../../app/components/PaymentDeclined.vue'
import PaymentNotConfirmed from '../../app/components/PaymentNotConfirmed.vue'
import { heldBody, pageTitle } from '~/utils/reason-copy'
import { formatHeldUntil } from '../../shared/billing-time'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

// ---- Copy: word for word from 23-UI-SPEC.md ----

describe('the /success words (23-UI-SPEC sections 4 to 7)', () => {
  it('REASON_SENTENCES has an entry for every REASON_CODES value, and nothing else', () => {
    expect(Object.keys(REASON_SENTENCES).sort()).toEqual([...REASON_CODES].sort())
    expect(Object.keys(REASON_SENTENCES)).toHaveLength(14)
    for (const code of REASON_CODES) expect(REASON_SENTENCES[code]).toMatch(/^[A-Z].*\.$/)
  })

  it('each reason sentence is the UI-SPEC row, word for word', () => {
    expect(REASON_SENTENCES).toEqual({
      invalid_request: 'Your sign-up details couldn\'t be used to set up a site.',
      coolify_unreachable: 'Our hosting service didn\'t answer.',
      subdomain_taken: 'Someone else took the address you chose while we were setting up.',
      create_failed: 'We couldn\'t create your site on our hosting service.',
      env_failed: 'We couldn\'t finish configuring your site.',
      deploy_failed: 'We couldn\'t start your site.',
      deploy_timeout: 'Starting your site took longer than we allow.',
      install_timeout: 'Your site started, but setting it up took longer than we allow.',
      manifest_failed: 'We couldn\'t pass your sign-up details to the setup step.',
      install_failed: 'We couldn\'t finish installing your site.',
      db_not_empty: 'A previous attempt left something behind that stopped this one.',
      platform_enable_failed: 'We couldn\'t turn on your site\'s features.',
      organizer_failed: 'Your site is built, but we couldn\'t create your account on it.',
      unknown: 'Something went wrong on our side.'
    })
  })

  it('a missing or unrecognised reason gets the unknown sentence, and no sentence carries a code', () => {
    expect(reasonSentence(null)).toBe('Something went wrong on our side.')
    expect(reasonSentence(undefined)).toBe('Something went wrong on our side.')
    expect(reasonSentence('made_up_code')).toBe('Something went wrong on our side.')
    expect(reasonSentence('deploy_failed')).toBe('We couldn\'t start your site.')
    for (const sentence of Object.values(REASON_SENTENCES)) {
      for (const code of REASON_CODES) expect(sentence).not.toContain(code)
    }
  })

  it('the progress, failure, stopped and welcome strings are the UI-SPEC rows', () => {
    expect(SUCCESS_COPY.progress).toEqual({
      title: 'Setting Up Your Site',
      intro: 'This usually takes about 4 minutes. You can leave this page; we\'ll email you.',
      retriedIntro: 'Trying again. This usually takes about 4 minutes.',
      underSteps: 'We\'ll email your sign-in link when your site is ready.',
      readError: 'Couldn\'t check your site\'s progress right now. We\'ll keep trying, and we\'ll email you.',
      // "Empty (no session)" (orchestrator, rule C, 2026-11-08).
      emptyTitle: 'Nothing to Show Here',
      emptyBody: 'There\'s nothing to show yet. Open the sign-in link from your email to set up your community\'s site.',
      emptyLink: 'Back to the home page'
    })
    expect(SUCCESS_COPY.failed).toEqual({
      title: 'Setting Up Your Site',
      alert: 'Setting up your site didn\'t finish. You haven\'t been charged.',
      retryLine: 'You can try once more for free. If it doesn\'t work a second time, we\'ll stop and you won\'t be charged.',
      retry: 'Retry site setup',
      retrying: 'Retrying…',
      retryingAnnouncement: 'Retrying site setup.',
      retryFailed: 'We couldn\'t start the retry. Try again in a moment.',
      nextStep: 'We\'re finishing up and will email you about what happens next.'
    })
    expect(SUCCESS_COPY.stopped).toEqual({
      title: 'We Couldn\'t Set Up Your Site',
      alert: 'We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.',
      line: 'We\'ve emailed you the details.',
      home: 'Back to the LocalNodes home page'
    })
    expect(SUCCESS_COPY.welcome).toEqual({
      title: 'Your Community\'s Site Is Ready',
      siteLine: 'Your site:',
      signIn: 'Check your email for your sign-in link.',
      open: 'Open your site',
      opensAnotherSite: '(opens another site)',
      stepsHeading: 'Your first three steps',
      steps: ['Set your password.', 'Open your group.', 'Upload your first files.'],
      guide: 'Read the organizer guide',
      home: 'Back to the LocalNodes home page'
    })
  })

  it('the next-step line is the approved sentence (orchestrator, rule C, 2026-11-08, conditional on 23-38)', () => {
    expect(SUCCESS_COPY.failed.nextStep).toBe('We\'re finishing up and will email you about what happens next.')
  })

  it('the time line reads "About N minutes left." and is not a ticking clock', () => {
    expect(timeLine(240)).toBe('About 4 minutes left.')
    expect(timeLine(180)).toBe('About 3 minutes left.')
    expect(timeLine(150)).toBe('About 3 minutes left.')
    expect(timeLine(121)).toBe('About 3 minutes left.')
    expect(timeLine(120)).toBe('About 2 minutes left.')
    expect(timeLine(60)).toBe('About 1 minute left.')
    expect(timeLine(1)).toBe('About 1 minute left.')
    expect(timeLine(0)).toBe('')
  })

  it('the fixture puts the failure component and the reason copy under the sign-up wording check', () => {
    const fixture = JSON.parse(read('tests/fixtures/banned-claims.json'))
    expect(fixture.signupSources).toEqual(expect.arrayContaining([
      'app/pages/success.vue',
      'app/components/ProvisioningProgress.vue',
      'app/components/ProvisioningComplete.vue',
      'app/components/ProvisioningFailed.vue',
      'app/utils/reason-copy.ts'
    ]))
  })
})

// ---- Pure helpers (no Vue reactivity needed) ----

describe('useProvisioningStatus - pure helpers', () => {
  describe('STAGES constant', () => {
    it('defines exactly 5 stages (23-32 adds Taking your first payment)', () => {
      expect(STAGES).toHaveLength(5)
    })

    it('the first step reads Card saved, and the five steps are the UI-SPEC section 4 names', () => {
      expect(STAGES.map(s => s.label)).toEqual(['Card saved', 'Setting up your server', 'Installing your site', 'Taking your first payment', 'Your site is ready'])
      expect(STAGES[0].statuses).toContain('triggered')
    })

    it('maps "provisioning" to stage 1', () => {
      expect(STAGES[1].statuses).toContain('provisioning')
    })

    it('maps "installing", "creating_user", "sending_email" to stage 2', () => {
      expect(STAGES[2].statuses).toContain('installing')
      expect(STAGES[2].statuses).toContain('creating_user')
      expect(STAGES[2].statuses).toContain('sending_email')
    })

    it('the fourth step is { id: payment, label: Taking your first payment, statuses: [ready, held] } (23-32)', () => {
      expect(STAGES[3]).toEqual({ id: 'payment', label: 'Taking your first payment', statuses: ['ready', 'held'] })
    })

    it('maps "complete" to stage 4', () => {
      expect(STAGES[4].statuses).toEqual(['complete'])
    })

    it('the status list comes from shared/provisioning.ts: the steps cover every status but failed, declined, refunding and refunded, once each', () => {
      const covered = STAGES.flatMap(s => [...s.statuses])
      expect([...covered, 'failed', 'declined', 'refunding', 'refunded'].sort()).toEqual([...PROVISION_STATUSES].sort())
      expect(read('app/composables/useProvisioningStatus.ts')).toMatch(/import \{[^}]*PROVISION_STATUSES[^}]*\} from '#shared\/provisioning'/)
      expect(read('app/composables/useProvisioningStatus.ts')).not.toMatch(/\| 'triggered'/)
    })
  })

  describe('getStageIndex', () => {
    it.each([
      ['triggered', 0], ['provisioning', 1], ['installing', 2], ['creating_user', 2],
      ['sending_email', 2], ['ready', 3], ['held', 3], ['complete', 4], ['failed', -1], ['declined', -1], ['refunding', -1], ['refunded', -1], ['unknown', 0]
    ] as const)('returns the stage for "%s"', (status, index) => {
      expect(getStageIndex(status)).toBe(index)
    })
  })

  describe('shouldStopPolling', () => {
    it('stops on complete', () => {
      expect(shouldStopPolling({ status: 'complete' })).toBe(true)
    })
    it('stops on stopped', () => {
      expect(shouldStopPolling({ status: 'failed', canRetry: false, stopped: true })).toBe(true)
    })
    it('stops on failed with a retry offered (it waits for the person)', () => {
      expect(shouldStopPolling({ status: 'failed', canRetry: true, stopped: false })).toBe(true)
    })
    it('keeps going on failed with no retry and not stopped (a site failure inside its 10-minute window, or a stop still running; 23-14)', () => {
      expect(shouldStopPolling({ status: 'failed', canRetry: false, stopped: false })).toBe(false)
    })
    it('stops on declined: nothing changes after it (23-32)', () => {
      expect(shouldStopPolling({ status: 'declined' })).toBe(true)
    })
    it('stops on a notFound reply (23-20 follow-up)', () => {
      expect(shouldStopPolling({ status: 'unknown', notFound: true })).toBe(true)
      expect(shouldStopPolling({ status: 'unknown', notFound: false })).toBe(false)
    })

    it.each(['triggered', 'provisioning', 'installing', 'creating_user', 'sending_email', 'ready', 'held', 'unknown'])('keeps going on "%s"', (status) => {
      expect(shouldStopPolling({ status })).toBe(false)
    })
  })

  describe('formatTimeRemaining', () => {
    it.each([[240, '4:00'], [225, '3:45'], [60, '1:00'], [9, '0:09'], [0, '0:00'], [119, '1:59']])('formats %i seconds as "%s"', (s, out) => {
      expect(formatTimeRemaining(s)).toBe(out)
    })
  })

  describe('mapStagesToState', () => {
    it('marks stages before, at and after the current index', () => {
      const result = mapStagesToState(2)
      expect(result.map(s => s.state)).toEqual(['completed', 'completed', 'active', 'pending', 'pending'])
    })

    it('marks all stages as "pending" when currentStageIndex is -1 (failed)', () => {
      expect(mapStagesToState(-1).every(s => s.state === 'pending')).toBe(true)
    })

    it('preserves label and id from STAGES', () => {
      const result = mapStagesToState(0)
      expect(result[0].id).toBe('triggered')
      expect(result[0].label).toBe('Card saved')
    })
  })
})

// ---- Stateful composable tests (drive the mocked poll callback manually) ----

describe('useProvisioningStatus - composable', () => {
  beforeEach(() => {
    vi.mocked($fetch).mockReset()
    pollHarness.fn = null
    pollHarness.pause.mockClear()
    pollHarness.resume.mockClear()
    countdownHarness.pause.mockClear()
    countdownHarness.start.mockClear()
    countdownHarness.remaining.value = 240
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fetch and pauses polling when sessionId is undefined', async () => {
    const provisioning = useProvisioningStatus(undefined)
    expect(pollHarness.pause).toHaveBeenCalled()
    await pollHarness.run()
    expect(vi.mocked($fetch)).not.toHaveBeenCalled()
    expect(provisioning.status.value).toBe('unknown')
  })

  it('exposes status, siteUrl, reason, canRetry, stopped and retry', () => {
    const p = useProvisioningStatus('cs_test_123')
    expect(p.status.value).toBe('unknown')
    expect(p.siteUrl.value).toBeNull()
    expect(p.reason.value).toBeNull()
    expect(p.canRetry.value).toBe(false)
    expect(p.stopped.value).toBe(false)
    expect(typeof p.retry).toBe('function')
    expect(vi.mocked($fetch)).not.toHaveBeenCalled()
  })

  it('the composable exposes the attempt number from the status reply: 1 until a reply says otherwise (23-38)', async () => {
    const p = useProvisioningStatus('cs_test_123')
    expect(p.attempt.value).toBe(1)
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'install_failed', canRetry: false, stopped: false, attempt: 2 })
    await pollHarness.run()
    expect(p.attempt.value).toBe(2)
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'install_failed', canRetry: false, stopped: false })
    await pollHarness.run()
    expect(p.attempt.value).toBe(1)
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'install_failed', canRetry: false, stopped: false, attempt: 'two' })
    await pollHarness.run()
    expect(p.attempt.value).toBe(1)
  })

  it('the returned object has no sign-in field', () => {
    const p = useProvisioningStatus('cs_test_123') as Record<string, unknown>
    expect(Object.keys(p).filter(k => /login|signin|sign_in|password/i.test(k))).toEqual([])
    expect('loginUrl' in p).toBe(false)
  })

  it('reflects a fetched in-progress status into status + derived stages', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'provisioning' })
    const { status, stages, currentStageIndex, isComplete, isFailed, activeStageLabel } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    await nextTick()
    expect(vi.mocked($fetch)).toHaveBeenCalledWith('/api/provision-status', { query: { session_id: 'cs_test_123' } })
    expect(status.value).toBe('provisioning')
    expect(currentStageIndex.value).toBe(1)
    expect(isComplete.value).toBe(false)
    expect(isFailed.value).toBe(false)
    expect(stages.value[0].state).toBe('completed')
    expect(stages.value[1].state).toBe('active')
    expect(activeStageLabel.value).toBe('Setting up your server')
    expect(pollHarness.pause).not.toHaveBeenCalled()
  })

  it('a status the shared list does not know is read as unknown', async () => {
    // refunded became a page status in 23-43 Task 7; tearing_down is server-only.
    vi.mocked($fetch).mockResolvedValue({ status: 'tearing_down' })
    const { status } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    expect(status.value).toBe('unknown')
  })

  it('polling stops on complete, and the site address is kept', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'complete', siteUrl: 'https://repair.localnodes.xyz' })
    const { isComplete, siteUrl } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    await nextTick()
    expect(isComplete.value).toBe(true)
    expect(siteUrl.value).toBe('https://repair.localnodes.xyz')
    expect(pollHarness.pause).toHaveBeenCalled()
    expect(countdownHarness.pause).toHaveBeenCalled()
  })

  it('polling stops on stopped', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'failed', reason: 'deploy_failed', canRetry: false, stopped: true })
    const { stopped, canRetry } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    expect(stopped.value).toBe(true)
    expect(canRetry.value).toBe(false)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('polling stops on failed with a retry offered, with the reason kept', async () => {
    vi.mocked($fetch).mockResolvedValue({ status: 'failed', reason: 'deploy_timeout', canRetry: true, stopped: false })
    const { isFailed, reason, canRetry, currentStageIndex } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    await nextTick()
    expect(isFailed.value).toBe(true)
    expect(reason.value).toBe('deploy_timeout')
    expect(canRetry.value).toBe(true)
    expect(currentStageIndex.value).toBe(-1)
    expect(pollHarness.pause).toHaveBeenCalled()
    expect(countdownHarness.pause).toHaveBeenCalled()
  })

  it('keeps polling on failed with no retry and not stopped, and shows the stop when it lands', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'install_failed', canRetry: false, stopped: false })
    const { isFailed, stopped } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    expect(isFailed.value).toBe(true)
    expect(pollHarness.pause).not.toHaveBeenCalled()

    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'install_failed', canRetry: false, stopped: true })
    await pollHarness.run()
    expect(stopped.value).toBe(true)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('a site failure inside its window that turns complete ends complete, with the reason cleared', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'organizer_failed', canRetry: false, stopped: false })
    const { isComplete, reason } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'complete', siteUrl: 'https://repair.localnodes.xyz', reason: null })
    await pollHarness.run()
    expect(isComplete.value).toBe(true)
    expect(reason.value).toBeNull()
  })

  it('retry() POSTs the session id to /api/retry-provisioning and resumes polling', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'deploy_failed', canRetry: true, stopped: false })
    const p = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    expect(pollHarness.pause).toHaveBeenCalledTimes(1)

    let resolveRetry!: (v: unknown) => void
    vi.mocked($fetch).mockImplementationOnce(() => new Promise((r) => { resolveRetry = r }) as never)
    const pending = p.retry()
    expect(p.retrying.value).toBe(true)
    expect(vi.mocked($fetch)).toHaveBeenLastCalledWith('/api/retry-provisioning', {
      method: 'POST',
      body: { session_id: 'cs_test_123' }
    })
    resolveRetry({ ok: true })
    await pending

    expect(p.retrying.value).toBe(false)
    expect(p.retryFailed.value).toBe(false)
    expect(p.retried.value).toBe(true)
    expect(p.status.value).toBe('triggered')
    expect(p.canRetry.value).toBe(false)
    expect(p.reason.value).toBeNull()
    expect(p.isFailed.value).toBe(false)
    expect(pollHarness.resume).toHaveBeenCalledTimes(1)
    expect(countdownHarness.start).toHaveBeenCalled()
  })

  it('a second retry press while one is in flight sends nothing more', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', canRetry: true, stopped: false })
    const p = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    vi.mocked($fetch).mockImplementationOnce(() => new Promise(() => {}) as never)
    void p.retry()
    void p.retry()
    expect(vi.mocked($fetch).mock.calls.filter(c => c[0] === '/api/retry-provisioning')).toHaveLength(1)
  })

  it('a refused retry shows the retry-failed line, keeps the failure on screen and polls again', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'failed', reason: 'deploy_failed', canRetry: true, stopped: false })
    const p = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    vi.mocked($fetch).mockRejectedValueOnce(Object.assign(new Error('HTTP 503'), { statusCode: 503 }))
    await p.retry()
    expect(p.retrying.value).toBe(false)
    expect(p.retryFailed.value).toBe(true)
    expect(p.retried.value).toBe(false)
    expect(p.isFailed.value).toBe(true)
    expect(pollHarness.resume).toHaveBeenCalledTimes(1)
  })

  it('a status that cannot be read shows the read error and keeps the last good state; the next good read clears it', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'provisioning' })
    const { status, readError } = useProvisioningStatus('cs_test_123')
    await pollHarness.run()
    vi.mocked($fetch).mockRejectedValueOnce(new Error('network down'))
    await expect(pollHarness.run()).resolves.toBeUndefined()
    expect(status.value).toBe('provisioning')
    expect(readError.value).toBe(true)
    expect(pollHarness.pause).not.toHaveBeenCalled()
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'installing' })
    await pollHarness.run()
    expect(readError.value).toBe(false)
    expect(status.value).toBe('installing')
  })

  // 23-20 follow-up (2026-11-08): an id the server does not know shows the
  // empty state and stops polling; "unknown" with no notFound is still waiting.
  it('a notFound reply sets notFound, stops polling and never moves a step', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'unknown', notFound: true })
    const p = useProvisioningStatus('cs_unknown')
    await pollHarness.run()
    expect(p.notFound.value).toBe(true)
    expect(p.status.value).toBe('unknown')
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('an unknown reply without notFound is a session still waiting: polling goes on', async () => {
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'unknown' })
    const p = useProvisioningStatus('cs_waiting')
    await pollHarness.run()
    expect(p.notFound.value).toBe(false)
    expect(pollHarness.pause).not.toHaveBeenCalled()
  })

  it('exposes the time line derived from the countdown', () => {
    countdownHarness.remaining.value = 225
    const { timeRemaining, minutesLine } = useProvisioningStatus('cs_test_123')
    expect(timeRemaining.value).toBe('3:45')
    expect(minutesLine.value).toBe('About 4 minutes left.')
  })
})

// ---- Mounted components (Vue's server renderer, small Nuxt UI stand-ins) ----

const stubs: Record<string, Component> = {
  UButton: defineComponent({
    props: ['label', 'loading', 'to', 'disabled'],
    setup: (p, { attrs, slots }) => () => p.to
      ? h('a', { ...attrs, href: p.to }, slots.default?.() ?? p.label)
      : h('button', { ...attrs, disabled: p.disabled || undefined }, slots.default?.() ?? p.label)
  }),
  UAlert: defineComponent({
    props: ['description', 'title', 'color'],
    setup: (p, { attrs, slots }) => () => h('div', { ...attrs, 'data-alert': p.color }, [
      p.title ? h('p', { 'data-alert-title': '' }, p.title) : null,
      slots.description ? slots.description() : (p.description ? h('p', p.description) : null)
    ])
  }),
  UIcon: defineComponent(() => () => h('span', { 'aria-hidden': 'true' })),
  ULink: defineComponent({ props: ['to'], setup: (p, { attrs, slots }) => () => h('a', { ...attrs, href: p.to }, slots.default?.()) }),
  NuxtLink: defineComponent({ props: ['to'], setup: (p, { attrs, slots }) => () => h('a', { ...attrs, href: p.to }, slots.default?.()) })
}

async function mount(component: Component, props: Record<string, unknown> = {}): Promise<string> {
  const app = createSSRApp(component, props)
  for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
  app.directive('motion', { getSSRProps: () => ({}) })
  return renderToString(app)
}

/** Every opening tag with tabindex -1 (the focus targets) in rendered HTML. */
const focusTargets = (html: string) => html.match(/<[a-z][a-z0-9]*\b[^>]*\stabindex="-1"[^>]*>/g) ?? []

/** The visible text of rendered HTML, with entities decoded. */
const textOf = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

describe('mounted', () => {
  it('the step list: the first step reads Card saved, with no strikethrough or white text', async () => {
    const html = await mount(ProvisioningProgress, { stages: mapStagesToState(1) })
    expect(textOf(html)).toMatch(/^Card saved Setting up your server Installing your site Taking your first payment Your site is ready$/)
    expect(html).not.toMatch(/line-through|text-white/)
    expect(html).toMatch(/<ol/)
  })

  it('the failed state shows the two T-3 lines, the reason sentence and one primary Retry site setup', async () => {
    const html = await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: true, stopped: false, retrying: false, retryFailed: false })
    const text = textOf(html)
    expect(text).toContain('Setting Up Your Site')
    expect(text).toContain('Setting up your site didn\'t finish. You haven\'t been charged.')
    expect(text).toContain('We couldn\'t start your site.')
    expect(text).toContain('You can try once more for free. If it doesn\'t work a second time, we\'ll stop and you won\'t be charged.')
    expect(text.match(/Retry site setup/g)).toHaveLength(1)
    // The alert box takes focus and carries no alert role (23-39, F8).
    const target = focusTargets(html)
    expect(target).toHaveLength(1)
    expect(target[0]).not.toMatch(/\srole=/)
    expect(text).not.toContain('deploy_failed')
    expect(text).not.toContain('We couldn\'t start the retry.')
  })

  it('the failed state with no reason shows "Something went wrong on our side."', async () => {
    const text = textOf(await mount(ProvisioningFailed, { reason: null, canRetry: true, stopped: false, retrying: false, retryFailed: false }))
    expect(text).toContain('Something went wrong on our side.')
  })

  it('while retrying the button reads Retrying… and is disabled', async () => {
    const html = await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: true, stopped: false, retrying: true, retryFailed: false })
    expect(textOf(html)).toContain('Retrying…')
    expect(textOf(html)).not.toContain('Retry site setup')
    expect(html).toMatch(/<button[^>]*disabled/)
  })

  it('a refused retry shows a second danger alert above the button, and the button comes back', async () => {
    const text = textOf(await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: true, stopped: false, retrying: false, retryFailed: true }))
    expect(text).toContain('We couldn\'t start the retry. Try again in a moment.')
    expect(text.indexOf('We couldn\'t start the retry.')).toBeLessThan(text.indexOf('Retry site setup'))
  })

  it('a failure with no retry offered and not yet stopped, on attempt 2, shows the alert and the next-step line: no retry line and no button', async () => {
    const html = await mount(ProvisioningFailed, { reason: 'install_failed', canRetry: false, stopped: false, retrying: false, retryFailed: false, attempt: 2 })
    const text = textOf(html)
    expect(text).toContain('Setting up your site didn\'t finish. You haven\'t been charged.')
    expect(text).toContain('We couldn\'t finish installing your site.')
    expect(text).toMatch(/We couldn't finish installing your site\. We're finishing up and will email you about what happens next\.$/)
    expect(html).toMatch(/<p class="mt-4 text-base text-muted">We(&#39;|')re finishing up and will email you about what happens next\.<\/p>/)
    expect(text).not.toContain('You can try once more for free.')
    expect(text).not.toContain('Retry site setup')
    expect(html).not.toMatch(/<button/)
  })

  it('a failure with no retry offered and not yet stopped, on attempt 1 (a site failure inside its window), shows the alert only', async () => {
    const html = await mount(ProvisioningFailed, { reason: 'install_failed', canRetry: false, stopped: false, retrying: false, retryFailed: false, attempt: 1 })
    const text = textOf(html)
    expect(text).toMatch(/We couldn't finish installing your site\.$/)
    expect(text).not.toContain('finishing up')
    expect(text).not.toContain('You can try once more for free.')
    expect(html).not.toMatch(/<button/)
  })

  describe('next-step line matrix: shown exactly once, after the reason, if and only if failed, canRetry false, stopped false and attempt 2', () => {
    const NEXT = 'We\'re finishing up and will email you about what happens next.'
    const cases: Array<[string | null, boolean, boolean, boolean, boolean, number]> = []
    for (const reason of [null, 'install_failed', 'deploy_failed'])
      for (const canRetry of [false, true])
        for (const stopped of [false, true])
          for (const retrying of [false, true])
            for (const retryFailed of [false, true])
              for (const attempt of [1, 2]) cases.push([reason, canRetry, stopped, retrying, retryFailed, attempt])

    it.each(cases)('reason %s, canRetry %s, stopped %s, retrying %s, retryFailed %s, attempt %s', async (reason, canRetry, stopped, retrying, retryFailed, attempt) => {
      const text = textOf(await mount(ProvisioningFailed, { reason, canRetry, stopped, retrying, retryFailed, attempt }))
      const shown = text.split(NEXT).length - 1
      if (!canRetry && !stopped && attempt === 2) {
        expect(shown).toBe(1)
        expect(text.indexOf(NEXT)).toBeGreaterThan(text.indexOf(reasonSentence(reason)))
        expect(text.endsWith(NEXT)).toBe(true)
      } else {
        expect(shown).toBe(0)
      }
    })
  })

  // F8 (fresh3 23-39; orchestrator 2026-11-08; 23-UI-SPEC section 5): the alert
  // box that takes focus carries no alert role, so the focus move reads it
  // once. Alerts that take no focus keep the role: the retry-request-failed
  // alert, and the stopped alert (focus goes to the stopped h1).
  describe('F8: the focused failure box carries no alert role; the alerts that take no focus keep it', () => {
    const cases: Array<[string | null, boolean, boolean, boolean, number]> = []
    for (const reason of [null, 'install_failed', 'deploy_failed'])
      for (const canRetry of [false, true])
        for (const retrying of [false, true])
          for (const retryFailed of [false, true])
            for (const attempt of [1, 2]) cases.push([reason, canRetry, retrying, retryFailed, attempt])

    it.each(cases)('not stopped: reason %s, canRetry %s, retrying %s, retryFailed %s, attempt %s', async (reason, canRetry, retrying, retryFailed, attempt) => {
      const html = await mount(ProvisioningFailed, { reason, canRetry, stopped: false, retrying, retryFailed, attempt })
      const target = focusTargets(html)
      expect(target, 'one focus target').toHaveLength(1)
      expect(target[0], 'the focus target has no role').not.toMatch(/\srole=/)
      // Only the retry-request-failed alert (shown with a retry offered) keeps the role.
      expect((html.match(/role="alert"/g) ?? []).length).toBe(canRetry && retryFailed ? 1 : 0)
    })

    it('with the retry request failed, its alert keeps the alert role, once, around its sentence', async () => {
      const html = await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: true, stopped: false, retrying: false, retryFailed: true })
      expect(html.match(/role="alert"/g)).toHaveLength(1)
      const alert = html.slice(html.indexOf('>', html.indexOf('role="alert"')) + 1)
      expect(textOf(alert)).toMatch(/^We couldn't start the retry\. Try again in a moment\./)
    })

    it('stopped: the alert keeps the alert role, once, and the h1 is the focus target', async () => {
      const html = await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: false, stopped: true, retrying: false, retryFailed: false })
      expect(html.match(/role="alert"/g)).toHaveLength(1)
      const target = focusTargets(html)
      expect(target).toHaveLength(1)
      expect(target[0]).toMatch(/^<h1\b/)
    })

    it('source: focusCurrent still focuses the alert box when not stopped and the h1 when stopped', () => {
      const src = read('app/components/ProvisioningFailed.vue')
      const start = src.indexOf('async function focusCurrent(')
      expect(start).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n}', start))
      expect(body).toMatch(/if \(props\.stopped\) stoppedHeading\.value\?\.focus\(\)/)
      expect(body).toMatch(/else alertBox\.value\?\.focus\(\)/)
      expect(src).toMatch(/<div\s+ref="alertBox"[^>]*tabindex="-1"/)
      expect(src).toMatch(/<h1\s+ref="stoppedHeading"[^>]*tabindex="-1"/)
      expect(src).toMatch(/onMounted\(focusCurrent\)/)
    })
  })

  it('the stopped state shows the Board 6 copy and no retry button', async () => {
    const html = await mount(ProvisioningFailed, { reason: 'deploy_failed', canRetry: false, stopped: true, retrying: false, retryFailed: false })
    const text = textOf(html)
    expect(text).toContain('We Couldn\'t Set Up Your Site')
    expect(text).toContain('We couldn\'t set up your site. You weren\'t charged, and we\'ve removed your saved card.')
    expect(text).toContain('We\'ve emailed you the details.')
    expect(text).toContain('Back to the LocalNodes home page')
    expect(html).toMatch(/href="\/"/)
    expect(text).not.toContain('Retry site setup')
    expect(text).not.toContain('You can try once more for free.')
    expect(text).not.toContain('Setting up your site didn\'t finish.')
    expect(html).not.toMatch(/<button/)
  })

  it('the welcome shows the h1, the address, the sign-in line, Open your site, three steps in order and the guide link; no sign-in link or password button', async () => {
    const html = await mount(ProvisioningComplete, { siteUrl: 'https://repair.localnodes.xyz' })
    const text = textOf(html)
    expect(text).toContain('Your Community\'s Site Is Ready')
    expect(text).toContain('Your site: repair.localnodes.xyz')
    expect(text).toContain('Check your email for your sign-in link.')
    expect(text).toContain('Open your site (opens another site)')
    expect(html).toMatch(/href="https:\/\/repair\.localnodes\.xyz"/)
    expect(text).toContain('Your first three steps')
    expect(html).toMatch(/<ol[^>]*>.*Set your password\..*Open your group\..*Upload your first files\..*<\/ol>/s)
    expect(text).toContain('Read the organizer guide')
    expect(html).toMatch(/href="https:\/\/repair\.localnodes\.xyz\/guide"/)
    // Step 1 is "Set your password." (plain text); the old button was "Set Your Password".
    expect(text).not.toContain('Set Your Password')
    expect(html).not.toMatch(/login|user\/reset/i)
    expect(html).not.toMatch(/target="_blank"/)
  })

  it('the welcome with no site address drops the address line and offers Back to the LocalNodes home page instead of Open your site', async () => {
    const html = await mount(ProvisioningComplete, { siteUrl: null })
    const text = textOf(html)
    expect(text).toContain('Your Community\'s Site Is Ready')
    expect(text).toContain('Check your email for your sign-in link.')
    expect(text).not.toContain('Your site:')
    expect(text).not.toContain('Open your site')
    expect(text).toContain('Back to the LocalNodes home page')
    expect(html).toMatch(/href="\/"/)
  })
})

// ---- The page, read as source ----

describe('the /success page', () => {
  const page = () => read('app/pages/success.vue')

  it('is forced light, keeps one polite live region and switches between progress, failure and welcome', () => {
    expect(page()).toMatch(/definePageMeta\(\{ colorMode: 'light' \}\)/)
    expect(page().match(/aria-live="polite"/g)).toHaveLength(1)
    expect(page()).toMatch(/<ProvisioningProgress/)
    expect(page()).toMatch(/<ProvisioningFailed/)
    expect(page()).toMatch(/<ProvisioningComplete/)
    expect(page()).toMatch(/max-w-2xl/)
  })

  it('there is no sign-in link or password button anywhere in app/', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(vue|ts)$/.test(name)) files.push(full)
      }
    }
    walk(join(root, 'app'))
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/loginUrl|Set Your Password/)
    }
  })

  it('the empty state (no session) reads its h1 and body from SUCCESS_COPY, and the old system words are gone', () => {
    expect(page()).toMatch(/\{\{ progress\.emptyTitle \}\}/)
    expect(page()).toMatch(/\{\{ progress\.emptyBody \}\}/)
    expect(page()).not.toMatch(/No active session|completing checkout| -- /)
  })

  it('passes the attempt number to the failure screen (23-38)', () => {
    expect(page()).toMatch(/<ProvisioningFailed[^>]*:attempt="attempt"/s)
  })

  it('the next-step line is read only by ProvisioningFailed.vue; its words live only in reason-copy.ts', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(vue|ts)$/.test(name)) files.push(full)
      }
    }
    walk(join(root, 'app'))
    const rel = (f: string) => f.slice(root.length + 1)
    expect(files.filter(f => /nextStep/.test(readFileSync(f, 'utf8'))).map(rel).sort()).toEqual(['app/components/ProvisioningFailed.vue', 'app/utils/reason-copy.ts'])
    expect(files.filter(f => /finishing up and will email/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['app/utils/reason-copy.ts'])
    expect(page()).not.toMatch(/nextStep|finishing up/)
  })

  it('the decorative animation is hidden from assistive technology', () => {
    expect(read('app/components/GardenAnimation.vue')).toMatch(/<div\s+aria-hidden="true"/)
  })
})

// ---- 23-37: the held and declined screens (23-UI-SPEC sections 6a and 6b) ----
//
// Tom's answer 3: the "Confirm my payment" button shows only to the browser
// that made the sign-up (canConfirm from the status reply), as a form POST to
// /api/confirm-payment, so the hosted invoice URL is in no page's HTML. The
// held body's time is the end of the hold, formatted in the reader's own zone
// (Q-time); the tests pin the zone so the words can be checked.

const HELD_UNTIL_ISO = '2026-11-09T16:15:00.000Z'

describe('the held and declined words (23-UI-SPEC sections 6a and 6b, approved 2026-11-08)', () => {
  it('held: title, body with one time slot, button', () => {
    expect(SUCCESS_COPY.held.title).toBe('Confirm Your Payment')
    expect(SUCCESS_COPY.held.button).toBe('Confirm my payment')
    expect(heldBody('November 9, 2026 at 9:15am MST')).toBe('Your bank needs you to confirm the first payment. We\'ve emailed you a link. Your site is ready and waits for you until November 9, 2026 at 9:15am MST.')
  })

  it('the held body\'s slot is filled by formatHeldUntil', () => {
    expect(heldBody(formatHeldUntil(Date.parse(HELD_UNTIL_ISO), 'UTC'))).toContain('waits for you until November 9, 2026 at 4:15pm UTC.')
  })

  it('declined: title, alert, button', () => {
    expect(SUCCESS_COPY.declined).toEqual({
      title: 'Your Card Was Declined',
      alert: 'Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.',
      button: 'Try again'
    })
  })
})

describe('useProvisioningStatus - held and declined (23-37)', () => {
  beforeEach(() => {
    vi.mocked($fetch).mockReset()
    pollHarness.fn = null
    pollHarness.pause.mockClear()
    pollHarness.resume.mockClear()
  })

  it('exposes heldUntil and canConfirm, null and false by default', () => {
    const p = useProvisioningStatus('cs_test_123')
    expect(p.heldUntil.value).toBeNull()
    expect(p.canConfirm.value).toBe(false)
    expect(p.heldExpired.value).toBe(false)
  })

  it('a held reply sets heldUntil and canConfirm, and polling continues', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'held', canRetry: false, stopped: false, attempt: 1, heldUntil: HELD_UNTIL_ISO, canConfirm: true })
    await pollHarness.run()
    expect(p.isHeld.value).toBe(true)
    expect(p.heldUntil.value).toBe(HELD_UNTIL_ISO)
    expect(p.canConfirm.value).toBe(true)
    expect(pollHarness.pause).not.toHaveBeenCalled()
  })

  it('canConfirm is true only for the boolean true', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'held', heldUntil: HELD_UNTIL_ISO, canConfirm: 'true' })
    await pollHarness.run()
    expect(p.canConfirm.value).toBe(false)
  })

  it('a declined reply stops polling; heldExpired comes from the reply', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'declined', canRetry: false, stopped: false, attempt: 1, heldExpired: false })
    await pollHarness.run()
    expect(p.isDeclined.value).toBe(true)
    expect(p.heldExpired.value).toBe(false)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('held then paid: heldUntil and canConfirm are cleared when the reply is no longer held', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'held', heldUntil: HELD_UNTIL_ISO, canConfirm: true })
    await pollHarness.run()
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'ready' })
    await pollHarness.run()
    expect(p.heldUntil.value).toBeNull()
    expect(p.canConfirm.value).toBe(false)
  })

  it('the payment step ("Taking your first payment") is the active step for ready', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'ready' })
    await pollHarness.run()
    expect(p.activeStageLabel.value).toBe('Taking your first payment')
    expect(p.stages.value.find(s => s.state === 'active')?.label).toBe('Taking your first payment')
  })
})

describe('mounted: the held screen (6a)', () => {
  const props = (canConfirm: boolean) => ({ heldUntil: HELD_UNTIL_ISO, canConfirm, sessionId: 'cs_test_held', timeZone: 'America/Denver' })

  it('the browser that made the sign-up: h1, the body with the time, and a POST form with the hidden session id and one primary "Confirm my payment"', async () => {
    const html = await mount(PaymentHeld, props(true))
    const text = textOf(html)
    expect(text).toContain('Confirm Your Payment')
    expect(text).toContain('Your bank needs you to confirm the first payment. We\'ve emailed you a link. Your site is ready and waits for you until November 9, 2026 at 9:15am MST.')
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/confirm-payment"|<form[^>]*action="\/api\/confirm-payment"[^>]*method="post"/)
    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="session_id"[^>]*value="cs_test_held"/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Confirm my payment<\/button>/)
    expect(text.match(/Confirm my payment/g)).toHaveLength(1)
  })

  it('any other session: the h1 and the body only; no form and no button', async () => {
    const html = await mount(PaymentHeld, props(false))
    expect(textOf(html)).toContain('Your bank needs you to confirm the first payment.')
    expect(html).not.toMatch(/<form|<button|Confirm my payment/)
  })

  it('no \'invoice.stripe.com\' in the HTML for either session', async () => {
    for (const canConfirm of [true, false]) expect(await mount(PaymentHeld, props(canConfirm))).not.toContain('invoice.stripe.com')
  })

  it('the h1 is the focus target (tabindex -1), and nothing carries role="alert" (F8)', async () => {
    const html = await mount(PaymentHeld, props(true))
    const targets = focusTargets(html)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/^<h1/)
    expect(html).not.toMatch(/role="alert"/)
  })

  it('the body is in the neutral alert look', async () => {
    expect(await mount(PaymentHeld, props(false))).toMatch(/data-alert="neutral"/)
  })

  it('the component focuses its h1 on mount, as stopped and welcome do', () => {
    const src = read('app/components/PaymentHeld.vue')
    expect(src).toMatch(/onMounted\(/)
    expect(src).toMatch(/heading\.value\?\.focus\(\)/)
  })
})

describe('mounted: the declined screen (6b)', () => {
  it('h1, the danger alert with the approved body, and one primary "Try again" to /invite; no retry button, no reason sentence', async () => {
    const html = await mount(PaymentDeclined, {})
    const text = textOf(html)
    expect(text).toContain('Your Card Was Declined')
    expect(text).toContain('Your card was declined, so we didn\'t finish setting up your site. You weren\'t charged.')
    expect(html).toMatch(/<a[^>]*href="\/invite"[^>]*>Try again<\/a>/)
    expect(html).toMatch(/data-alert="error"/)
    expect(text).not.toContain('Retry site setup')
    for (const sentence of Object.values(REASON_SENTENCES)) expect(text).not.toContain(sentence)
  })

  it('the h1 is the focus target, and the alert carries no role="alert" (F8)', async () => {
    const html = await mount(PaymentDeclined, {})
    const targets = focusTargets(html)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/^<h1/)
    expect(html).not.toMatch(/role="alert"/)
    expect(read('app/components/PaymentDeclined.vue')).toMatch(/heading\.value\?\.focus\(\)/)
  })
})

describe('the /success page: held and declined (23-37)', () => {
  const page = () => read('app/pages/success.vue')

  it('branch order: no session, declined, held, stopped or failed, complete, waiting', () => {
    const src = page()
    const at = (re: RegExp) => src.search(re)
    // The empty branch covers no session and an unknown one (23-20 follow-up).
    expect(src).toMatch(/const empty = computed\(\(\) => !sessionId \|\| notFound\.value\)/)
    const order = [
      at(/v-if="!sessionId \|\| notFound"/),
      at(/<PaymentDeclined/),
      at(/<PaymentHeld/),
      at(/<ProvisioningFailed/),
      at(/<ProvisioningComplete/),
      at(/<GardenAnimation/)
    ]
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('the browser titles: "Confirm Your Payment - LocalNodes" and "Your Card Was Declined - LocalNodes"', () => {
    expect(page()).toMatch(/isHeld\.value\) return pageTitle\(SUCCESS_COPY\.held\.title\)/)
    expect(page()).toMatch(/return pageTitle\(SUCCESS_COPY\.declined\.title\)/)
    expect(pageTitle(SUCCESS_COPY.held.title)).toBe('Confirm Your Payment - LocalNodes')
    expect(pageTitle(SUCCESS_COPY.declined.title)).toBe('Your Card Was Declined - LocalNodes')
  })

  it('passes canConfirm, heldUntil and the session id to the held screen', () => {
    expect(page()).toMatch(/<PaymentHeld[^>]*:can-confirm="canConfirm"/s)
    expect(page()).toMatch(/<PaymentHeld[^>]*:held-until="heldUntil"/s)
    expect(page()).toMatch(/<PaymentHeld[^>]*:session-id="sessionId"/s)
  })

  it('the polite region announces step names only: never while declined', () => {
    expect(page()).toMatch(/if \(!isFailed\.value && !isDeclined\.value && !isRefunding\.value && !isRefunded\.value\) announcement\.value/)
  })

  it('\'invoice.stripe.com\' and hostedInvoiceUrl appear nowhere in app/', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(vue|ts)$/.test(name)) files.push(full)
      }
    }
    walk(join(root, 'app'))
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/invoice\.stripe\.com|hostedInvoiceUrl/)
  })
})

// ---- 23-37 follow-up: the "Payment not confirmed" screen (orchestrator, rule C,
// 2026-11-08: browser title and h1 "We've Removed Your Site"; 23-UI-SPEC
// "Billing copy (B-1)", row "Payment not confirmed (page, /success)") ----

describe('the payment not confirmed words', () => {
  it('title, alert, button', () => {
    expect(SUCCESS_COPY.notConfirmed).toEqual({
      title: 'We\'ve Removed Your Site',
      alert: 'We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.',
      button: 'Try again'
    })
    expect(pageTitle(SUCCESS_COPY.notConfirmed.title)).toBe('We\'ve Removed Your Site - LocalNodes')
  })
})

describe('mounted: the payment not confirmed screen', () => {
  it('h1, the danger alert with the approved sentence, and one primary "Try again" to /invite; no declined words, no retry', async () => {
    const html = await mount(PaymentNotConfirmed, { removed: true, noCapture: true })
    const text = textOf(html)
    expect(text).toContain('We\'ve Removed Your Site')
    expect(text).toContain('We didn\'t get your payment confirmation in time, so we\'ve removed your site. You weren\'t charged.')
    expect(html).toMatch(/<a[^>]*href="\/invite"[^>]*>Try again<\/a>/)
    expect(text.match(/Try again/g)).toHaveLength(1)
    expect(html).toMatch(/data-alert="error"/)
    expect(text).not.toContain('Your card was declined')
    expect(text).not.toContain('Retry site setup')
  })

  it('the h1 is the focus target, focused on mount, and nothing carries role="alert" (F8)', async () => {
    const html = await mount(PaymentNotConfirmed, { removed: true, noCapture: true })
    const targets = focusTargets(html)
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatch(/^<h1/)
    expect(html).not.toMatch(/role="alert"/)
    expect(read('app/components/PaymentNotConfirmed.vue')).toMatch(/heading\.value\?\.focus\(\)/)
  })
})

describe('the /success page: payment not confirmed', () => {
  const page = () => read('app/pages/success.vue')

  it('a held_expired sign-up gets its own branch, right after the declined one and before held', () => {
    const src = page()
    expect(src).toMatch(/<PaymentNotConfirmed\s+v-else-if="isDeclined && heldExpired"/)
    const declined = src.search(/<PaymentDeclined/)
    const notConfirmed = src.search(/<PaymentNotConfirmed/)
    const held = src.search(/<PaymentHeld/)
    expect(declined).toBeGreaterThan(0)
    expect(notConfirmed).toBeGreaterThan(declined)
    expect(held).toBeGreaterThan(notConfirmed)
  })

  it('the browser title is "We\'ve Removed Your Site - LocalNodes"', () => {
    expect(page()).toMatch(/isDeclined\.value && heldExpired\.value\) return pageTitle\(SUCCESS_COPY\.notConfirmed\.title\)/)
  })
})

// ---- The page, mounted: an unknown session (23-20 follow-up, 2026-11-08) ----

describe('the /success page with a session id the server does not know', () => {
  const g = globalThis as Record<string, unknown>
  const GLOBALS = ['useRoute', 'useProvisioningStatus', 'definePageMeta', 'useSeoMeta']
  let seo: Record<string, unknown>
  afterEach(() => { for (const k of GLOBALS) delete g[k] })

  /** Renders /success?session_id=… with the composable's state after one status reply. */
  async function render(sessionId: string | undefined, reply?: Record<string, unknown>) {
    seo = {}
    g.useRoute = () => ({ query: sessionId ? { session_id: sessionId } : {} })
    g.definePageMeta = vi.fn()
    g.useSeoMeta = (meta: Record<string, unknown>) => { seo = meta }
    const state = useProvisioningStatus(sessionId)
    if (reply) {
      vi.mocked($fetch).mockResolvedValueOnce(reply)
      await pollHarness.run()
    }
    g.useProvisioningStatus = () => state
    const app = createSSRApp(SuccessPage)
    for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
    app.component('UContainer', defineComponent((_, { slots }) => () => h('div', slots.default?.())))
    app.component('GardenAnimation', defineComponent(() => () => h('div', { 'data-garden': '' })))
    for (const [name, c] of Object.entries({ ProvisioningProgress, ProvisioningFailed, ProvisioningComplete, PaymentHeld, PaymentDeclined, PaymentNotConfirmed })) app.component(name, c)
    app.directive('motion', { getSSRProps: () => ({}) })
    const html = await renderToString(app)
    const title = seo.title as { value?: string } | string | undefined
    return { text: textOf(html), title: typeof title === 'string' ? title : title?.value }
  }

  it('shows "Nothing to Show Here", its body and the home link, and none of the build steps', async () => {
    const { text, title } = await render('cs_unknown', { status: 'unknown', notFound: true })
    expect(text).toContain(SUCCESS_COPY.progress.emptyTitle)
    expect(text).toContain(SUCCESS_COPY.progress.emptyBody)
    expect(text).toContain(SUCCESS_COPY.progress.emptyLink)
    for (const stage of STAGES) expect(text).not.toContain(stage.label)
    expect(text).not.toContain(SUCCESS_COPY.progress.title)
    expect(text).not.toContain(SUCCESS_COPY.progress.underSteps)
    expect(title).toBe(pageTitle(SUCCESS_COPY.progress.emptyTitle))
  })

  it('with no session id at all the page shows the same empty state, with the same browser title', async () => {
    const { text, title } = await render(undefined)
    expect(text).toContain(SUCCESS_COPY.progress.emptyTitle)
    for (const stage of STAGES) expect(text).not.toContain(stage.label)
    expect(title).toBe(pageTitle(SUCCESS_COPY.progress.emptyTitle))
  })

  it('a session checkout marked, still waiting for its webhook, shows the build steps as before', async () => {
    const { text, title } = await render('cs_waiting', { status: 'unknown' })
    expect(text).not.toContain(SUCCESS_COPY.progress.emptyTitle)
    expect(text).toContain('Card saved')
    expect(title).toBe(pageTitle(SUCCESS_COPY.progress.title))
  })
})

// ---- 23-43 Task 7: removing, refunding and refunded (23-UI-SPEC.md "Billing
// copy additions for 23-43", P2, P3 and P6, word for word; the orchestrator's
// round-2 answer: while a refund is unproven the P3 fallback is P6's sentence,
// and P2's only after D2's check passed) ----

describe('the removing, refunding and refunded words (P3, P6, P2)', () => {
  it('removing (P3): title, alert, button', () => {
    expect(SUCCESS_COPY.removing).toEqual({
      title: 'Removing Your Site',
      alert: 'We didn\'t get your payment confirmation in time, so we\'re removing your site. You weren\'t charged.',
      button: 'Try again'
    })
    expect(pageTitle(SUCCESS_COPY.removing.title)).toBe('Removing Your Site - LocalNodes')
  })

  it('refunding (P6): title, alert, and the lateActivation alert; no button', () => {
    expect(SUCCESS_COPY.refunding).toEqual({
      title: 'Refunding Your Payment',
      alert: 'We couldn\'t finish setting up your site, so we\'re refunding your payment.',
      lateAlert: 'We\'re refunding your payment.'
    })
    expect(pageTitle(SUCCESS_COPY.refunding.title)).toBe('Refunding Your Payment - LocalNodes')
  })

  it('refunded (P2): title, alert, the lateActivation alert, button', () => {
    expect(SUCCESS_COPY.refunded).toEqual({
      title: 'We\'ve Refunded Your Payment',
      alert: 'We couldn\'t finish setting up your site, so we\'ve refunded your payment in full.',
      lateAlert: 'We\'ve refunded your payment in full.',
      button: 'Try again'
    })
    expect(pageTitle(SUCCESS_COPY.refunded.title)).toBe('We\'ve Refunded Your Payment - LocalNodes')
  })
})

describe('shouldStopPolling: removing, refunding and refunded (23-43 Task 7)', () => {
  it('keeps going while removing (a 3DS hold that ran out, the deletion not yet confirmed)', () => {
    expect(shouldStopPolling({ status: 'declined', heldExpired: true, removed: false, noCapture: true })).toBe(false)
  })
  it('stops once removed with no capture', () => {
    expect(shouldStopPolling({ status: 'declined', heldExpired: true, removed: true, noCapture: true })).toBe(true)
  })
  it('a removed sign-up with a capture keeps going until its refund is proven, then stops', () => {
    expect(shouldStopPolling({ status: 'declined', heldExpired: true, removed: true, noCapture: false, refundProven: false })).toBe(false)
    expect(shouldStopPolling({ status: 'declined', heldExpired: true, removed: true, noCapture: false, refundProven: true })).toBe(true)
  })
  it('a declined card still stops at once', () => {
    expect(shouldStopPolling({ status: 'declined', heldExpired: false })).toBe(true)
  })
  it('keeps going on refunding (the waiting screen); stops on refunded', () => {
    expect(shouldStopPolling({ status: 'refunding' })).toBe(false)
    expect(shouldStopPolling({ status: 'refunded' })).toBe(true)
  })
})

describe('useProvisioningStatus: removing, refunding and refunded (23-43 Task 7)', () => {
  beforeEach(() => {
    vi.mocked($fetch).mockReset()
    pollHarness.fn = null
    pollHarness.pause.mockClear()
    pollHarness.resume.mockClear()
    countdownHarness.pause.mockClear()
  })

  it('exposes removed, noCapture, refundProven and lateActivation, false by default, and isRefunding and isRefunded', () => {
    const p = useProvisioningStatus('cs_test_123')
    for (const k of ['removed', 'noCapture', 'refundProven', 'lateActivation', 'isRefunding', 'isRefunded'] as const) expect(p[k].value, k).toBe(false)
  })

  it('removing, then removed: polling goes on while removing and stops once removed', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'declined', heldExpired: true, removed: false, noCapture: true, refundProven: false })
    await pollHarness.run()
    expect(p.heldExpired.value).toBe(true)
    expect(p.removed.value).toBe(false)
    expect(p.noCapture.value).toBe(true)
    expect(pollHarness.pause).not.toHaveBeenCalled()
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'declined', heldExpired: true, removed: true, noCapture: true, refundProven: false })
    await pollHarness.run()
    expect(p.removed.value).toBe(true)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('the flags are read as booleans only, and only on the replies that carry them', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'declined', heldExpired: true, removed: 'true', noCapture: 'true', refundProven: 'true' })
    await pollHarness.run()
    expect([p.removed.value, p.noCapture.value, p.refundProven.value]).toEqual([false, false, false])
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'ready', removed: true, noCapture: true, lateActivation: true })
    await pollHarness.run()
    expect([p.removed.value, p.noCapture.value, p.lateActivation.value]).toEqual([false, false, false])
  })

  it('refunding keeps polling; refunded stops it; lateActivation comes from the reply', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'refunding', lateActivation: true })
    await pollHarness.run()
    expect(p.isRefunding.value).toBe(true)
    expect(p.lateActivation.value).toBe(true)
    expect(pollHarness.pause).not.toHaveBeenCalled()
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'refunded', lateActivation: false })
    await pollHarness.run()
    expect(p.isRefunded.value).toBe(true)
    expect(p.isRefunding.value).toBe(false)
    expect(p.lateActivation.value).toBe(false)
    expect(pollHarness.pause).toHaveBeenCalled()
  })

  it('refunding and refunded are no build step: the step index is -1 and the countdown pauses', async () => {
    const p = useProvisioningStatus('cs_test_123')
    vi.mocked($fetch).mockResolvedValueOnce({ status: 'refunding' })
    await pollHarness.run()
    expect(p.currentStageIndex.value).toBe(-1)
    await nextTick()
    expect(countdownHarness.pause).toHaveBeenCalled()
  })
})

describe('mounted: the removing and removed screens, with the P3 truth check', () => {
  it('removing, no capture: the P3 h1, the danger alert and one primary "Try again" to /invite', async () => {
    const html = await mount(PaymentNotConfirmed, { removed: false, noCapture: true })
    const text = textOf(html)
    expect(text).toContain(SUCCESS_COPY.removing.title)
    expect(text).toContain(SUCCESS_COPY.removing.alert)
    expect(text).not.toContain(SUCCESS_COPY.notConfirmed.title)
    expect(html).toMatch(/<a[^>]*href="\/invite"[^>]*>Try again<\/a>/)
    expect(html).toMatch(/data-alert="error"/)
  })

  it('removed, no capture: the existing "We\'ve Removed Your Site" screen', async () => {
    const text = textOf(await mount(PaymentNotConfirmed, { removed: true, noCapture: true }))
    expect(text).toContain(SUCCESS_COPY.notConfirmed.title)
    expect(text).toContain(SUCCESS_COPY.notConfirmed.alert)
    expect(text).not.toContain(SUCCESS_COPY.removing.title)
  })

  it.each([false, true])('a captured payment never shows You weren\'t charged (removed %s): while the refund is unproven, P6\'s sentence', async (removed) => {
    const text = textOf(await mount(PaymentNotConfirmed, { removed, noCapture: false, refundProven: false }))
    expect(text).not.toContain('You weren\'t charged')
    expect(text).toContain(SUCCESS_COPY.refunding.alert)
    expect(text).not.toContain(SUCCESS_COPY.refunded.alert)
    expect(text).toContain(removed ? SUCCESS_COPY.notConfirmed.title : SUCCESS_COPY.removing.title)
  })

  it.each([false, true])('a captured payment never shows You weren\'t charged (removed %s): P2\'s sentence only once the refund is proven', async (removed) => {
    const text = textOf(await mount(PaymentNotConfirmed, { removed, noCapture: false, refundProven: true }))
    expect(text).not.toContain('You weren\'t charged')
    expect(text).toContain(SUCCESS_COPY.refunded.alert)
    expect(text).not.toContain(SUCCESS_COPY.refunding.alert)
  })

  it('with no props at all the screen is the safe one: removing, and P6\'s sentence (no capture is never assumed)', async () => {
    const text = textOf(await mount(PaymentNotConfirmed, {}))
    expect(text).toContain(SUCCESS_COPY.removing.title)
    expect(text).not.toContain('You weren\'t charged')
    expect(text).toContain(SUCCESS_COPY.refunding.alert)
  })

  it('the h1 is the focus target in every variant, nothing carries role="alert" (F8), and the h1 takes focus again when removed turns true', async () => {
    for (const props of [{ removed: false, noCapture: true }, { removed: true, noCapture: true }, { removed: false, noCapture: false }]) {
      const html = await mount(PaymentNotConfirmed, props)
      const targets = focusTargets(html)
      expect(targets).toHaveLength(1)
      expect(targets[0]).toMatch(/^<h1/)
      expect(html).not.toMatch(/role="alert"/)
    }
    const src = read('app/components/PaymentNotConfirmed.vue')
    expect(src).toMatch(/onMounted\(/)
    expect(src).toMatch(/watch\(\(\) => props\.removed/)
    expect(src).toMatch(/heading\.value\?\.focus\(\)/)
  })
})

describe('mounted: the refunding (P6) and refunded (P2) screens', () => {
  const load = async () => (await import('../../app/components/PaymentRefunded.vue')).default

  it('refunding: the P6 h1 and the neutral alert; no button', async () => {
    const html = await mount(await load(), { refunded: false, lateActivation: false })
    const text = textOf(html)
    expect(text).toContain(SUCCESS_COPY.refunding.title)
    expect(text).toContain(SUCCESS_COPY.refunding.alert)
    expect(html).toMatch(/data-alert="neutral"/)
    expect(html).not.toMatch(/<a[^>]*href="\/invite"|<button/)
    expect(text).not.toContain(SUCCESS_COPY.refunded.title)
  })

  it('refunding with lateActivation: only "We\'re refunding your payment."', async () => {
    const text = textOf(await mount(await load(), { refunded: false, lateActivation: true }))
    expect(text).toContain(SUCCESS_COPY.refunding.lateAlert)
    expect(text).not.toContain('We couldn\'t finish setting up your site')
  })

  it('refunded: the P2 h1, the danger alert with the approved sentence and one primary "Try again" to /invite', async () => {
    const html = await mount(await load(), { refunded: true, lateActivation: false })
    const text = textOf(html)
    expect(text).toContain(SUCCESS_COPY.refunded.title)
    expect(text).toContain(SUCCESS_COPY.refunded.alert)
    expect(html).toMatch(/data-alert="error"/)
    expect(html).toMatch(/<a[^>]*href="\/invite"[^>]*>Try again<\/a>/)
    expect(text.match(/Try again/g)).toHaveLength(1)
    expect(text).not.toContain(SUCCESS_COPY.refunding.title)
  })

  it('refunded with lateActivation: the alert reads only "We\'ve refunded your payment in full." (the P1/P2 truth rule)', async () => {
    const text = textOf(await mount(await load(), { refunded: true, lateActivation: true }))
    expect(text).toContain(SUCCESS_COPY.refunded.lateAlert)
    expect(text).not.toContain('We couldn\'t finish setting up your site')
    expect(text).toContain('Try again')
  })

  it('the h1 is the focus target in both variants, nothing carries role="alert" (F8), and the h1 takes focus again when refunded turns true', async () => {
    for (const refunded of [false, true]) {
      const html = await mount(await load(), { refunded, lateActivation: false })
      const targets = focusTargets(html)
      expect(targets).toHaveLength(1)
      expect(targets[0]).toMatch(/^<h1/)
      expect(html).not.toMatch(/role="alert"/)
    }
    const src = read('app/components/PaymentRefunded.vue')
    expect(src).toMatch(/onMounted\(/)
    expect(src).toMatch(/watch\(\(\) => props\.refunded/)
    expect(src).toMatch(/heading\.value\?\.focus\(\)/)
  })
})

describe('the /success page: removing, refunding and refunded (23-43 Task 7)', () => {
  const page = () => read('app/pages/success.vue')

  it('branch order: no session, declined, removing, removed, refunding, refunded, held, stopped or failed, complete, waiting', () => {
    const src = page()
    const at = (re: RegExp) => src.search(re)
    const order = [
      at(/v-if="!sessionId \|\| notFound"/),
      at(/<PaymentDeclined\s+v-else-if="showDeclined"/),
      at(/<PaymentNotConfirmed\s+v-else-if="removing"/),
      at(/<PaymentNotConfirmed\s+v-else-if="isDeclined && heldExpired"/),
      at(/<PaymentRefunded\s+v-else-if="isRefunding"/),
      at(/<PaymentRefunded\s+v-else-if="isRefunded"/),
      at(/<PaymentHeld/),
      at(/<ProvisioningFailed/),
      at(/<ProvisioningComplete/),
      at(/<GardenAnimation/)
    ]
    expect(order.every(i => i >= 0), JSON.stringify(order)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(src).toMatch(/const removing = computed\(\(\) => isDeclined\.value && heldExpired\.value && !removed\.value\)/)
  })

  it('the browser titles follow the h1s', () => {
    const src = page()
    expect(src).toMatch(/removing\.value\) return pageTitle\(SUCCESS_COPY\.removing\.title\)/)
    expect(src).toMatch(/isRefunding\.value\) return pageTitle\(SUCCESS_COPY\.refunding\.title\)/)
    expect(src).toMatch(/isRefunded\.value\) return pageTitle\(SUCCESS_COPY\.refunded\.title\)/)
  })

  it('passes removed, noCapture, refundProven and lateActivation to the screens', () => {
    const src = page()
    expect(src).toMatch(/<PaymentNotConfirmed[^>]*:no-capture="noCapture"/s)
    expect(src).toMatch(/<PaymentNotConfirmed[^>]*:refund-proven="refundProven"/s)
    expect(src).toMatch(/<PaymentRefunded[^>]*:late-activation="lateActivation"/s)
  })
})

describe('the /success page, mounted: removing, refunding and refunded (23-43 Task 7)', () => {
  const g = globalThis as Record<string, unknown>
  const GLOBALS = ['useRoute', 'useProvisioningStatus', 'definePageMeta', 'useSeoMeta']
  let seo: Record<string, unknown>
  afterEach(() => { for (const k of GLOBALS) delete g[k] })

  async function render(reply: Record<string, unknown>) {
    const PaymentRefunded = (await import('../../app/components/PaymentRefunded.vue')).default
    seo = {}
    g.useRoute = () => ({ query: { session_id: 'cs_test_t7' } })
    g.definePageMeta = vi.fn()
    g.useSeoMeta = (meta: Record<string, unknown>) => { seo = meta }
    const state = useProvisioningStatus('cs_test_t7')
    vi.mocked($fetch).mockResolvedValueOnce({ canRetry: false, stopped: false, attempt: 1, siteUrl: null, reason: null, ...reply })
    await pollHarness.run()
    g.useProvisioningStatus = () => state
    const app = createSSRApp(SuccessPage)
    for (const [name, stub] of Object.entries(stubs)) app.component(name, stub)
    app.component('UContainer', defineComponent((_, { slots }) => () => h('div', slots.default?.())))
    app.component('GardenAnimation', defineComponent(() => () => h('div', { 'data-garden': '' })))
    for (const [name, c] of Object.entries({ ProvisioningProgress, ProvisioningFailed, ProvisioningComplete, PaymentHeld, PaymentDeclined, PaymentNotConfirmed, PaymentRefunded })) app.component(name, c)
    app.directive('motion', { getSSRProps: () => ({}) })
    const html = await renderToString(app)
    const title = seo.title as { value?: string } | string | undefined
    return { text: textOf(html), title: typeof title === 'string' ? title : title?.value }
  }

  it('removing: the P3 screen and title, no step list', async () => {
    const { text, title } = await render({ status: 'declined', heldExpired: true, removed: false, noCapture: true, refundProven: false })
    expect(text).toContain(SUCCESS_COPY.removing.alert)
    expect(title).toBe(pageTitle(SUCCESS_COPY.removing.title))
    for (const stage of STAGES) expect(text).not.toContain(stage.label)
  })

  it('removed: the existing screen and title', async () => {
    const { text, title } = await render({ status: 'declined', heldExpired: true, removed: true, noCapture: true, refundProven: false })
    expect(text).toContain(SUCCESS_COPY.notConfirmed.alert)
    expect(title).toBe(pageTitle(SUCCESS_COPY.notConfirmed.title))
  })

  it('a captured payment never shows You weren\'t charged, mounted through the page: P6\'s sentence until proven', async () => {
    const { text } = await render({ status: 'declined', heldExpired: true, removed: true, noCapture: false, refundProven: false })
    expect(text).not.toContain('You weren\'t charged')
    expect(text).toContain(SUCCESS_COPY.refunding.alert)
  })

  it('refunding: the P6 screen and title, no step list', async () => {
    const { text, title } = await render({ status: 'refunding', lateActivation: false })
    expect(text).toContain(SUCCESS_COPY.refunding.alert)
    expect(title).toBe(pageTitle(SUCCESS_COPY.refunding.title))
    for (const stage of STAGES) expect(text).not.toContain(stage.label)
  })

  it('refunded: the P2 screen and title', async () => {
    const { text, title } = await render({ status: 'refunded', lateActivation: false })
    expect(text).toContain(SUCCESS_COPY.refunded.alert)
    expect(title).toBe(pageTitle(SUCCESS_COPY.refunded.title))
  })

  it('a zero invoice (failed, stopped): the approved Stopped screen (P5)', async () => {
    const { text, title } = await render({ status: 'failed', stopped: true })
    expect(text).toContain(SUCCESS_COPY.stopped.alert)
    expect(title).toBe(pageTitle(SUCCESS_COPY.stopped.title))
  })
})
