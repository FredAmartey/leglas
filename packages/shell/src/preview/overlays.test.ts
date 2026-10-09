import { describe, expect, test } from "vitest";

import { BADGE_CSS, NEXT_BADGE_CSS } from "./overlays.js";

/**
 * An error overlay is the app saying it's broken; hiding one would let a stale
 * or blank preview pass as healthy.
 */
const ERROR_SURFACES = [
  "vite-error-overlay",
  "nextjs-portal",
  "astro-dev-overlay",
  "error",
  "overlay",
];

describe("BADGE_CSS", () => {
  test("hides the badges it is meant to, in one declaration that cannot leak into app styling", () => {
    for (const badge of ["#__next-build-watcher", "#nuxt-devtools-anchor", "astro-dev-toolbar"]) {
      expect(BADGE_CSS).toContain(badge);
    }

    expect(BADGE_CSS).toMatch(/^[^{]+\{display:none!important\}$/);
  });

  test("never touches an element that could be an error overlay", () => {
    for (const surface of ERROR_SURFACES) {
      expect(BADGE_CSS.toLowerCase()).not.toContain(surface);
    }
  });
});

describe("NEXT_BADGE_CSS", () => {
  test("targets only the dev tools indicator inside the portal, never the portal or its modal", () => {
    // The portal hosts both the badge and the error modal, so only this child
    // is hidden, never the host, and no wildcard reaches the modal.
    expect(NEXT_BADGE_CSS).toContain("#devtools-indicator");
    expect(NEXT_BADGE_CSS).not.toContain("nextjs-portal");
    expect(NEXT_BADGE_CSS).not.toContain("*");
    expect(NEXT_BADGE_CSS).not.toMatch(/:host\b(?!-)/);
  });
});
