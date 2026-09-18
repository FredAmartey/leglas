/**
 * Framework dev chrome that is decoration rather than information.
 *
 * The distinction matters more than it looks. A dev badge is tooling that sits
 * on top of the design being judged; an error overlay is the app saying it is
 * broken. Hiding the first is a courtesy, hiding the second would let a stale
 * or blank preview pass as healthy, which is the exact failure this tool
 * exists to prevent.
 *
 * So only elements that are badges in their entirety appear here. Vite's
 * overlay is nothing but errors and is absent deliberately.
 */
export const BADGE_CSS =
  "#__next-build-watcher,#nuxt-devtools-anchor,astro-dev-toolbar{display:none!important}";

/**
 * Next's badge, hidden from inside the portal's shadow root.
 *
 * `nextjs-portal` hosts the dev tools indicator and the compilation and
 * runtime error modals in the same element, so hiding the host would suppress
 * every error Next reports. The shadow root is open, and the badge is one
 * identifiable child of it, so this reaches in and hides only that.
 */
export const NEXT_BADGE_CSS = "#devtools-indicator{display:none!important}";
