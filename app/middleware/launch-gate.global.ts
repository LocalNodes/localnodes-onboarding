// Client side of the pre-launch gate (Codex P2, PR #9): the server middleware
// only sees full page loads, so client navigation to /onboarding, /success or
// /cancel is caught here and sent to the early-access form. The flag is the
// public runtime config value `launchOpen`, set from the same NUXT_LAUNCH_OPEN
// as the server's (nuxt.config.ts). Rules: shared/launch.ts.
import { gateDecision, isLaunchOpen, EARLY_ACCESS_URL } from '#shared/launch'

export default defineNuxtRouteMiddleware((to) => {
  const open = isLaunchOpen(useRuntimeConfig().public.launchOpen)
  if (gateDecision(to.path, open) === 'redirect') {
    const [path, hash] = EARLY_ACCESS_URL.split('#')
    return navigateTo({ path: path || '/', hash: `#${hash}` }, { replace: true })
  }
})
