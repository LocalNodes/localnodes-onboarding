<script setup lang="ts">
// "Test network" chip (Tom, 2026-11-06, PR #9, option A): a feature that works
// end to end on the test network (Sepolia) but isn't on sign-up sites yet.
// Outlined, so it reads apart from the filled "Coming" chip. The claims check
// reads it through `data-badge`; a fund claim needs this chip or "Coming" in
// its sentence (tests/fixtures/banned-claims.json, `badgedClaims`).
</script>

<template>
  <span data-badge class="inline-flex items-center align-middle border border-accented bg-default text-highlighted rounded-full px-3 py-1 text-sm font-semibold whitespace-nowrap">Test network</span>
</template>
