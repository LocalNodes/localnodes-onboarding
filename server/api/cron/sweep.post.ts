import { handleCronSweep } from '../../utils/cron-sweep'
import { makeBillingDeps, makePilotNoticeDeps, makeStopDeps } from '../../utils/billing-wiring'

// QStash's signed POST every 5 minutes (23-38). The signature is checked in
// server/utils/cron-sweep.ts against the raw body and the configured URL,
// before any client is built. Not gated: QStash calls it while the launch is
// closed. The schedule is a one-time runbook step (23-21), never created from
// code.
//
// The URL the signature is checked against is runtimeConfig cronSweepUrl
// (NUXT_CRON_SWEEP_URL) only, never this request's own URL or headers, so a
// spoofed host can't change it. The clients are built only in the factory,
// which handleCronSweep calls after the signature passes.
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const signature = getHeader(event, 'upstash-signature')
  const body = (await readRawBody(event)) ?? ''

  const result = await handleCronSweep(
    {
      signature,
      body,
      url: String(config.cronSweepUrl ?? ''),
      currentSigningKey: String(config.qstashCurrentSigningKey ?? ''),
      nextSigningKey: String(config.qstashNextSigningKey ?? '')
    },
    () => ({
      // The stop deps (23-37): the mailer, the invite secret, the app delete and the paid path.
      ...makeStopDeps(config),
      redis: useRedis(),
      // The first payment and the activation still owed (23-32), awaited here.
      billing: makeBillingDeps(config).deps,
      // The free pilot's end notice, 14 days ahead (pilot-end.ts), at most once per 6 hours.
      pilot: makePilotNoticeDeps(config),
      log: msg => console.warn(msg)
    })
  )

  setResponseHeader(event, 'Cache-Control', 'no-store')
  setResponseStatus(event, result.status)
  return result.body
})
