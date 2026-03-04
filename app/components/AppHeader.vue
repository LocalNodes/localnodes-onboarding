<template>
  <UHeader>
    <template #left>
      <NuxtLink to="/" class="flex items-center gap-2">
        <span class="font-bold text-xl text-teal-400">LocalNodes</span>
      </NuxtLink>
    </template>

    <template #center>
      <UNavigationMenu :items="navItems" />
    </template>

    <template #right>
      <UButton
        label="Get Started"
        to="/onboarding"
        color="primary"
      />
    </template>
  </UHeader>
</template>

<script setup lang="ts">
const navItems = [
  [{ label: 'How it Works', to: '#how-it-works' }],
  [{ label: 'Features', to: '#features' }],
  [{ label: 'Pricing', to: '#pricing' }],
  [{ label: 'Communities', to: '#communities' }]
]
</script>
