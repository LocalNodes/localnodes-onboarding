<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'
import { PUBLIC_PAGES } from '~/utils/public-pages'

// One header on every page: the landing's dark band, the reversed lock-up
// (fresh3 BRAND.md section 4), the logo left and the links and button together
// on the right, in the landing's 1200px container (main.css). On the public
// reading pages (/ and /for) the band takes the landing's colours (its stylesheet,
// under its html class); on the sign-up task pages it takes the Nuxt dark tokens
// (ln-tokens.css) until the regenerated tokens bring the same teal there.
const route = useRoute()
const onLanding = computed(() => PUBLIC_PAGES.includes(route.path))
// The menu closes itself when the address changes; a tap on the menu's early-access button while
// the address is already /#early-access changes nothing, so that button closes it too.
const menuOpen = ref(false)
function closeMenu() {
  menuOpen.value = false
}
// Off the public pages the button is outlined: those pages carry their own
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
  <!-- On every page the logo sits left and the links and the button sit together on the
       right; no page centres the links. The mobile menu opens on <body>, so it takes the dark
       context itself.
       Below 400 CSS px the logo, the button and the menu button don't fit in one row, so the button
       moves into the menu body there (the page must not scroll sideways at 320). From 400 up the
       header is as before. The menu gets its own name: Nuxt UI's English text has none for it. -->
  <UHeader
    v-model:open="menuOpen"
    title="LocalNodes home"
    to="/"
    class="dark home-dark home-header bg-default border-default"
    :ui="{ left: 'lg:flex-none', right: 'lg:flex-1 lg:justify-end', content: 'dark home-dark' }"
    :menu="{ title: 'Menu', description: 'Site links and the early-access button' }"
  >
    <template #title>
      <AppLogo reversed />
    </template>

    <template #right>
      <UNavigationMenu :items="navItems" class="hidden lg:flex" />
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
