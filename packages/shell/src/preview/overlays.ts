/**
 * Framework dev chrome that's decoration, not information. A badge sits over
 * the design being judged; an error overlay is the app saying it's broken, and
 * hiding it would let a broken preview pass as healthy. So only elements that
 * are wholly badges are listed; Vite's overlay is all errors and left out.
 */
export const BADGE_CSS =
  "#__next-build-watcher,#nuxt-devtools-anchor,astro-dev-toolbar{display:none!important}";

/**
 * Next's badge, hidden from inside the portal's shadow root. `nextjs-portal`
 * also hosts the error modals, so hiding the host would suppress every error;
 * the open shadow root lets this hide just the badge.
 */
export const NEXT_BADGE_CSS = "#devtools-indicator{display:none!important}";
