// The public reading pages: the landing and the pages that read as part of it.
// Each loads the landing's stylesheet and puts its class on <html>, so they
// share the landing's colours, its header band, its footer band and its
// container (tests/unit/tokens.test.ts holds the two lists together).
export const PUBLIC_PAGES: readonly string[] = ['/', '/for']
