<script setup lang="ts">
// Footer (fresh3 LANDING.md 3.9, D-16): the badge line, both licences in the
// short form "Open source (GPL and AGPL)", never a GPL-only line; demo links
// labelled demos; no stats or community list. Shared with the sign-up pages,
// so it carries no frame or buyer words (D-05).
// "Open source" goes to the public repository (T-5, 2026-11-08). "Get help"
// (T-1, 2026-11-08) is a mailto: to hello@localnodes.xyz, in the same place on
// every screen, which is what WCAG 3.2.6 asks of a help link.
// On the public reading pages (/ and /for) the footer is a dark band like the header and the
// landing's closing section; on the sign-up pages it stays light. On the public pages it also
// takes the landing's own width and side gutter, so its left edge lines up with the header and
// the sections above it.
import { PUBLIC_PAGES } from '~/utils/public-pages'

const route = useRoute()
const onLanding = computed(() => PUBLIC_PAGES.includes(route.path))
const year = new Date().getFullYear()
</script>

<template>
  <footer class="border-t border-default bg-default" :class="onLanding ? 'dark home-dark' : ''">
    <div class="py-8 flex flex-col gap-6" :class="onLanding ? 'home-wrap' : 'max-w-7xl mx-auto px-4 sm:px-6 lg:px-8'">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3 text-sm text-muted">
          <NuxtLink to="/" aria-label="LocalNodes home">
            <AppLogo size="sm" :reversed="onLanding" />
          </NuxtLink>
          <span aria-hidden="true">·</span>
          <span>Home base for communities that run things together.</span>
        </div>
        <nav aria-label="Footer" class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <NuxtLink to="/for" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Who it's for
          </NuxtLink>
          <a href="https://cascadia.localnodes.xyz" target="_blank" rel="noopener noreferrer" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Cascadia demo<span class="sr-only"> (opens in a new tab)</span>
          </a>
          <a href="https://github.com/LocalNodes/os-knowledge-garden" target="_blank" rel="noopener noreferrer" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Open source<span class="sr-only"> (opens in a new tab)</span>
          </a>
          <NuxtLink to="/#privacy" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Privacy
          </NuxtLink>
          <a href="mailto:hello@localnodes.xyz" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Get help
          </a>
          <NuxtLink to="/#early-access" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Get early access
          </NuxtLink>
        </nav>
      </div>
      <p class="text-sm text-muted">
        &copy; {{ year }} LocalNodes. Open source (GPL and AGPL).
      </p>
    </div>
  </footer>
</template>
