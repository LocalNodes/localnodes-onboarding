<script setup lang="ts">
import type { NavigationMenuItem } from '@nuxt/ui'

const navItems: NavigationMenuItem[] = [
  { label: 'How it Works', to: '#how-it-works' },
  { label: 'Features', to: '#features' },
  { label: 'Pricing', to: '#pricing' },
  { label: 'Communities', to: '#communities' }
]
</script>

<template>
  <UHeader>
    <template #title>
      <NuxtLink to="/" class="flex items-center gap-2">
        <span class="font-bold text-xl text-teal-400">LocalNodes</span>
      </NuxtLink>
    </template>

    <UNavigationMenu :items="navItems" />

    <template #right>
      <UButton
        label="Get Started"
        to="/onboarding"
        color="primary"
      />
    </template>
  </UHeader>
</template>
