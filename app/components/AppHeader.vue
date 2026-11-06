<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// On the landing page the header sits on the dark hero band, so it takes the
// `dark` context and the reversed lock-up (fresh3 BRAND.md section 4). The
// sign-up task pages (/onboarding, /success, /cancel) stay light.
// TODO(22.1-08): the exact band colour (palette B brand 950, BRAND.md section 5)
// arrives through the Nuxt dark tokens.
const route = useRoute()
const onLanding = computed(() => route.path === '/')

// active: false — hash links all match the / route, which would mark every
// item active at once.
const navItems: NavigationMenuItem[] = [
  { label: 'Who it\'s for', to: '/#who-its-for', active: false },
  { label: 'Demos', to: '/#see-it-in-action', active: false },
  { label: 'Open source', to: '/#open-source', active: false }
]
</script>

<template>
  <UHeader :class="onLanding ? 'dark bg-default border-default' : ''">
    <template #title>
      <NuxtLink to="/" aria-label="LocalNodes home">
        <AppLogo :reversed="onLanding" />
      </NuxtLink>
    </template>

    <UNavigationMenu :items="navItems" />

    <template #right>
      <UButton
        label="Set up your site"
        to="/onboarding"
        color="primary"
      />
    </template>

    <template #body>
      <UNavigationMenu :items="navItems" orientation="vertical" class="-mx-2.5" />
    </template>
  </UHeader>
</template>
