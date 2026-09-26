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
  test("hides the badges it is meant to", () => {
    for (const badge of ["#__next-build-watcher", "#nuxt-devtools-anchor", "astro-dev-toolbar"]) {
      expect(BADGE_CSS).toContain(badge);
    }
  });

  test("never touches an element that could be an error overlay", () => {
    for (const surface of ERROR_SURFACES) {
      expect(BADGE_CSS.toLowerCase()).not.toContain(surface);
    }
  });

  test("is a single declaration, so it cannot leak into app styling", () => {
    expect(BADGE_CSS).toMatch(/^[^{]+\{display:none!important\}$/);
  });
});

describe("NEXT_BADGE_CSS", () => {
  test("targets only the dev tools indicator inside the portal", () => {
    // The portal hosts both the badge and the error modal, so only this child
    // is hidden, never the host.
    expect(NEXT_BADGE_CSS).toContain("#devtools-indicator");
  });

  test("does not hide the portal itself", () => {
    expect(NEXT_BADGE_CSS).not.toContain("nextjs-portal");
  });

  test("does not use a wildcard that would catch the error modal", () => {
    expect(NEXT_BADGE_CSS).not.toContain("*");
    expect(NEXT_BADGE_CSS).not.toMatch(/:host\b(?!-)/);
  });
});
