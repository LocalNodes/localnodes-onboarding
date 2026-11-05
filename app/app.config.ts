// LocalNodes design tokens (fresh3 22-UI-SPEC Part 1, "Nuxt wiring").
// Lives in app/ because Nuxt 4 only reads app.config from the srcDir (app/);
// the old root-level copy was never loaded, so Nuxt UI ran on its defaults.
// ln-teal / ln-amber are custom palettes defined in app/assets/css/main.css so
// the hexes equal the Drupal community site's exactly (Tailwind 4's built-in
// teal is OKLCH and doesn't equal #0f766e).
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'ln-teal',
      secondary: 'ln-amber',
      neutral: 'zinc'
    }
  }
})
