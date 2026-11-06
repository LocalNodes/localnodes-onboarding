<script setup lang="ts">
// Footer (fresh3 LANDING.md 3.9, D-16): the badge line, both licences in the
// short form "Open source (GPL and AGPL)", never a GPL-only line; demo links
// labelled demos; no stats or community list. Shared with the sign-up pages,
// so it carries no frame or buyer words (D-05).
const year = new Date().getFullYear()
</script>

<template>
  <footer class="border-t border-default bg-default">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3 text-sm text-muted">
          <NuxtLink to="/" aria-label="LocalNodes home">
            <AppLogo size="sm" />
          </NuxtLink>
          <span aria-hidden="true">·</span>
          <span>Home base for communities that run things together.</span>
        </div>
        <nav aria-label="Footer" class="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <a href="https://cascadia.localnodes.xyz" target="_blank" rel="noopener noreferrer" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Cascadia demo<span class="sr-only"> (opens in a new tab)</span>
          </a>
          <a href="https://github.com/LocalNodes" target="_blank" rel="noopener noreferrer" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Code on GitHub<span class="sr-only"> (opens in a new tab)</span>
          </a>
          <NuxtLink to="/#privacy" class="text-muted hover:text-primary underline-offset-2 hover:underline">
            Privacy
          </NuxtLink>
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
