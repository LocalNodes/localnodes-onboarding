<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// On the landing page the header sits on the dark hero band, so it takes the
// `dark` context and the reversed lock-up (fresh3 BRAND.md section 4). The
// sign-up task pages (/onboarding, /success, /cancel) stay light.
// The band colour (palette B brand 950, BRAND.md section 5) comes from the Nuxt
// dark tokens (ln-tokens.css).
const route = useRoute()
const onLanding = computed(() => route.path === '/')
// Off the landing page the button is outlined: those pages carry their own
// primary action (BRAND.md section 5: one primary button per screen).

// active: false — hash links all match the / route, which would mark every
// item active at once.
const navItems: NavigationMenuItem[] = [
  { label: 'Who it\'s for', to: '/#who-its-for', active: false },
  { label: 'Demos', to: '/#see-it-in-action', active: false },
  { label: 'Open source', to: '/#open-source', active: false }
]
</script>

<template>
  <!-- UHeader makes the title its own link to "/", named by `title` when the
       slot has no text (the logo is an image). A link of ours inside it made a
       link inside a link: two Tab stops, the first named "Nuxt UI" (fresh3
       23-29, second-model review C1). -->
  <UHeader title="LocalNodes home" to="/" :class="onLanding ? 'dark bg-default border-default' : ''">
    <template #title>
      <AppLogo :reversed="onLanding" />
    </template>

    <UNavigationMenu :items="navItems" />

    <template #right>
      <UButton
        label="Get early access"
        to="/#early-access"
        :color="onLanding ? 'primary' : 'neutral'"
        :variant="onLanding ? 'solid' : 'outline'"
      />
    </template>

    <template #body>
      <UNavigationMenu :items="navItems" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
