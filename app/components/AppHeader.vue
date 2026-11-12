<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

// On the landing page the header sits on the dark hero band, so it takes the
// `dark` context and the reversed lock-up (fresh3 BRAND.md section 4). The
// sign-up task pages (/onboarding, /success, /cancel) stay light.
// The band colour (palette B brand 950, BRAND.md section 5) comes from the Nuxt
// dark tokens (ln-tokens.css).
const route = useRoute()
const onLanding = computed(() => route.path === '/')
// The menu closes itself when the address changes; a tap on the menu's early-access button while
// the address is already /#early-access changes nothing, so that button closes it too.
const menuOpen = ref(false)
function closeMenu() {
  menuOpen.value = false
}
// Off the landing page the button is outlined: those pages carry their own
// primary action (BRAND.md section 5: one primary button per screen).

// active: false — hash links all match the / route, which would mark every
// item active at once.
const navItems: NavigationMenuItem[] = [
  { label: 'How it works', to: '/#together', active: false },
  { label: 'Open source', to: '/#yours', active: false },
  { label: 'Demo sites', to: '/#demo', active: false }
]
</script>

<template>
  <!-- UHeader makes the title its own link to "/", named by `title` when the
       slot has no text (the logo is an image). A link of ours inside it made a
       link inside a link: two Tab stops, the first named "Nuxt UI". -->
  <!-- On the home page the logo sits left and the links and the button sit together on the
       right; elsewhere the links stay in the centre. The mobile menu opens on <body>, so it
       takes the dark context itself.
       Below 400 CSS px the logo, the button and the menu button don't fit in one row, so the button
       moves into the menu body there (the page must not scroll sideways at 320). From 400 up the
       header is as before. The menu gets its own name: Nuxt UI's English text has none for it. -->
  <UHeader
    v-model:open="menuOpen"
    title="LocalNodes home"
    to="/"
    :class="onLanding ? 'dark home-dark home-header bg-default border-default' : ''"
    :ui="onLanding ? { left: 'lg:flex-none', right: 'lg:flex-1 lg:justify-end', content: 'dark home-dark' } : undefined"
    :menu="{ title: 'Menu', description: 'Site links and the early-access button' }"
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
        class="max-[399.98px]:hidden"
      />
    </template>

    <template #body>
      <UNavigationMenu :items="navItems" orientation="vertical" class="-mx-2.5" />
      <UButton
        label="Get early access"
        to="/#early-access"
        :color="onLanding ? 'primary' : 'neutral'"
        :variant="onLanding ? 'solid' : 'outline'"
        block
        class="mt-4 min-[400px]:hidden"
        @click="closeMenu"
      />
    </template>
  </UHeader>
</template>
