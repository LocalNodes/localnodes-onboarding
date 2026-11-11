// LocalNodes design tokens (fresh3 22.1-08, DES-01 / D-03).
// Lives in app/ because Nuxt 4 only reads app.config from the srcDir (app/);
// the old root-level copy was never loaded, so Nuxt UI ran on its defaults.
// ln-brand / ln-accent / ln-neutral are role-named palettes defined in
// app/assets/css/ln-tokens.css, which fresh3's token generator writes
// (scripts/tokens/build_tokens.mjs). Do not edit that file by hand and do not
// name a colour here; change the token source and regenerate.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'ln-brand',
      secondary: 'ln-accent',
      neutral: 'ln-neutral'
    },
    // Hover and pressed colours of primary buttons (fresh3 23-29 finding 1).
    // Nuxt UI's own are hover:bg-primary/75 and hover:text-primary/75: the
    // primary at 75% over white, where white text (or the text itself on white)
    // is 3.49:1, under WCAG 1.4.3's 4.5:1. fresh3's 22-UI-SPEC token table gives
    // solid buttons the darker primary-strong role (brand 900) on hover, as the
    // Drupal site's buttons and the mail button do; link-style buttons take the
    // same shade for their text. Palette shade names only, no colour values.
    button: {
      compoundVariants: [
        { color: 'primary', variant: 'solid', class: 'hover:bg-ln-brand-900 active:bg-ln-brand-900' },
        { color: 'primary', variant: 'link', class: 'hover:text-ln-brand-900 active:text-ln-brand-900' },
        // A solid secondary button (none on the site yet): Nuxt UI's white
        // text on the amber fill is 1.62:1, so it takes the default dark text
        // (orchestrator hand-off from 22.1-05, 2026-11-08; tokens.test.ts).
        { color: 'secondary', variant: 'solid', class: 'text-default' }
      ]
    }
  }
})
