// The bring-your-own OpenRouter choice (fresh3 23-18 follow-up, 2026-11-08).
// No OpenRouter model passed the re-score under Tom's rule, so Option 3 is
// hidden until one does. The setting is server-only (runtimeConfig
// openRouterChoiceEnabled, NUXT_OPENROUTER_CHOICE_ENABLED) and is read at
// request time. This plugin runs only during server rendering and copies the
// answer into the page state `ln-openrouter-choice`; Nuxt serialises page
// state into the payload, so the browser starts with the same answer and the
// form (app/components/AiChoiceField.vue) shows or hides Option 3 from it.
//
// The state steers what the form shows, nothing more. The key route and
// checkout read the setting themselves and refuse openrouter while it is off.
import { isOpenRouterChoiceEnabled } from '#shared/ai-choice'

export default defineNuxtPlugin(() => {
  const shown = useState<boolean>('ln-openrouter-choice', () => false)
  shown.value = isOpenRouterChoiceEnabled(useRuntimeConfig().openRouterChoiceEnabled)
})
