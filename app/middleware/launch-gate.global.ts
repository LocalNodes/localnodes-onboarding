// Client side of the pre-launch gate (Codex P2, PR #9): the server middleware
// only sees full page loads, so client navigation to /onboarding, /success or
// /cancel is caught here and sent to the early-access form. The flag is the
// public runtime config value `launchOpen`, set from the same NUXT_LAUNCH_OPEN
// as the server's (nuxt.config.ts). Rules: shared/launch.ts.
//
// Invited people (Phase 23, D-01, D-03): the server's own decision reaches this
// middleware as the page state `ln-invited`, copied during SSR by
// app/plugins/invited-state.server.ts. It is passed as gateDecision's third
// argument, and only for a path the gate would refuse, as the server does. It
// steers navigation and nothing else: the server never trusts it. If the state
// can't be read, the person counts as not invited, which is the old behaviour.
import { gateDecision, isLaunchOpen, EARLY_ACCESS_URL } from '#shared/launch'

function invitedByServer(): boolean {
  try {
    return useState<boolean>('ln-invited', () => false).value === true
  } catch {
    return false
  }
}

export default defineNuxtRouteMiddleware((to) => {
  const open = isLaunchOpen(useRuntimeConfig().public.launchOpen)
  let decision = gateDecision(to.path, open)
  if (decision !== 'pass') decision = gateDecision(to.path, open, invitedByServer())
  if (decision === 'redirect') {
    const [path, hash] = EARLY_ACCESS_URL.split('#')
    return navigateTo({ path: path || '/', hash: `#${hash}` }, { replace: true })
  }
})
