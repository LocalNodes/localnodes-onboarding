<script setup lang="ts">
// "Built for groups like": one light strip after the last act ("It's your site") and before
// the dark close, with a few kinds of community and one link to the page that lists them
// all: a second path for someone who has seen the whole product. It shares the last act's
// tint, so a hairline sets it apart. The words come from
// app/data/who-its-for.json, the same file that page reads, so the two never
// name different kinds. No heading: it is part of the page flow, not a section.
import data from '~/data/who-its-for.json'

const { lead, examples, linkText } = data.homeRow

/** "a, b and c" */
function joined(words: string[]): string {
  if (words.length < 2) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

const list = joined(examples)
</script>

<template>
  <div class="home-kinds home-band-tint">
    <div class="home-wrap home-kinds-row">
      <p class="home-kinds-text">
        <span class="home-kinds-lead">{{ lead }}</span> {{ list }}.
      </p>
      <NuxtLink to="/for" class="home-link home-kinds-link">{{ linkText }}</NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.home-kinds {
  border-top: 1px solid var(--ui-border);
}

.home-kinds-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
  padding-block: 24px;
}

.home-kinds-text {
  margin: 0;
  font-size: 16px;
  line-height: 1.5;
  color: var(--ui-text);
}

.home-kinds-lead {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

.home-kinds-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
}
</style>
