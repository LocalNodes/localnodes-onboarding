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
  { label: 'How it works', to: '/#decide', active: false },
  { label: 'Open source', to: '/#yours', active: false },
  { label: 'Demo sites', to: '/#demo', active: false }
]
</script>

<template>
  <!-- UHeader makes the title its own link to "/", named by `title` when the
       slot has no text (the logo is an image). A link of ours inside it made a
       link inside a link: two Tab stops, the first named "Nuxt UI" (fresh3
       23-29, second-model review C1). -->
  <!-- On the home page the logo sits left and the links and the button sit together on the
       right; elsewhere the links stay in the centre. The mobile menu opens on <body>, so it
       takes the dark context itself. -->
  <UHeader
    title="LocalNodes home"
    to="/"
    :class="onLanding ? 'dark home-dark home-header bg-default border-default' : ''"
    :ui="onLanding ? { left: 'lg:flex-none', right: 'lg:flex-1 lg:justify-end', content: 'dark home-dark' } : undefined"
  >
    <template #title>
      <AppLogo :reversed="onLanding" />
    </template>

    <UNavigationMenu v-if="!onLanding" :items="navItems" />

    <template #right>
      <UNavigationMenu v-if="onLanding" :items="navItems" class="hidden lg:flex" />
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
