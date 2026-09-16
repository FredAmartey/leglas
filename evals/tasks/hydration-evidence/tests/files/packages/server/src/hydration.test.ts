import { describe, expect, test } from "vitest";

import { hydrationEvidence } from "./hydration.js";

describe("hydrationEvidence", () => {
  test.each([
    ["React", "Uncaught Error: Minified React error #418; visit https://react.dev/errors/418"],
    ["React", "Hydration failed because the initial UI does not match"],
    ["React", "Hydration failed because the server rendered HTML didn't match the client."],
    ["React", "There was an error while hydrating this Suspense boundary"],
    ["React", "Text content does not match server-rendered HTML"],
    ["React", "Expected server HTML to contain a matching div"],
    ["React", 'Warning: Prop `id` did not match. Server: "one" Client: "two"'],
    ["Vue", "Hydration node mismatch"],
    ["Vue", "Hydration completed but contains mismatches"],
    ["Svelte", "https://svelte.dev/e/hydration_mismatch"],
    ["Solid", "Hydration Mismatch. Unable to find DOM nodes for hydration key"],
    ["the app", "Unexpected hydration result: markup mismatch"],
    ["the app", "NG0500: During hydration Angular expected <div> but found <span>"],
  ])("recognises %s evidence", (framework, message) => {
    expect(hydrationEvidence([message])).toEqual({ framework, message });
  });

  test.each([
    "Refused to connect to https://example.com because it violates the Content Security Policy",
    "Failed to load resource: the server responded with a status of 500",
    "Failed to load resource: the server responded with a status of 404 (favicon.ico)",
    "hydrated 12 islands",
    "Redux Persist failed to rehydrate state: unexpected key 'cart'",
    "Apollo Client: cache hydration failed, falling back to network",
    "React Query: hydration produced an unexpected query state",
  ])("does not mistake ordinary load noise for hydration evidence", (message) => {
    expect(hydrationEvidence([message])).toBeNull();
  });

  test("returns the first match across a list without changing its message", () => {
    const first = "Hydration class mismatch on the root";
    expect(hydrationEvidence(["Failed to load resource: 500", first, "Hydration failed later"])).toEqual({
      framework: "Vue",
      message: first,
    });
  });

  test("keeps the first line of an exception and drops its stack", () => {
    const description =
      "Error: Minified React error #418; visit https://react.dev/errors/418\n    at hydrate (http://localhost:3000/_next/static/chunks/main.js:1:2)";
    expect(hydrationEvidence([description])).toEqual({
      framework: "React",
      message: "Error: Minified React error #418; visit https://react.dev/errors/418",
    });
  });

  test("returns null for an empty list", () => {
    expect(hydrationEvidence([])).toBeNull();
  });
});
