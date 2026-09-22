import { describe, expect, test } from "vitest";

import { checkFraming, framingFor } from "./frame-policy.js";

const SHELL = "http://localhost:4100/leglas/";

const headers = (entries: Record<string, string>) => new Headers(entries);

const verdict = (entries: Record<string, string>, target = "https://example.com/") =>
  framingFor(headers(entries), target, SHELL);

describe("framingFor", () => {
  test("a page that says nothing about frames may be framed", () => {
    expect(verdict({})).toEqual({ framable: true });
    expect(verdict({ "content-security-policy": "script-src 'self'" })).toEqual({
      framable: true,
    });
  });

  test("X-Frame-Options refuses the way browsers read it", () => {
    expect(verdict({ "x-frame-options": "DENY" })).toEqual({
      framable: false,
      refusal: { header: "x-frame-options", value: "DENY" },
    });
    // Only the page's own origin may frame it, and the shell is not that.
    expect(verdict({ "x-frame-options": "sameorigin" }).framable).toBe(false);
    expect(
      framingFor(headers({ "x-frame-options": "SAMEORIGIN" }), "http://localhost:4100/x", SHELL),
    ).toEqual({ framable: true });
    // ALLOW-FROM was never implemented by Chrome, which ignores it.
    expect(verdict({ "x-frame-options": "ALLOW-FROM https://example.com" })).toEqual({
      framable: true,
    });
    // Conflicting values block when any of them is a real answer.
    expect(verdict({ "x-frame-options": "deny, sameorigin" }).framable).toBe(false);
    expect(verdict({ "x-frame-options": "foo, bar" })).toEqual({ framable: true });
  });

  test("a frame-ancestors policy decides on its own, and X-Frame-Options is ignored", () => {
    expect(verdict({ "content-security-policy": "frame-ancestors 'none'" })).toEqual({
      framable: false,
      refusal: { header: "content-security-policy", value: "frame-ancestors 'none'" },
    });
    expect(
      verdict({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" }),
    ).toEqual({ framable: true });
    expect(verdict({ "content-security-policy": "frame-ancestors 'self'" }).framable).toBe(false);
    // An empty list lets nobody in.
    expect(verdict({ "content-security-policy": "frame-ancestors" }).framable).toBe(false);
  });

  test("host sources match the shell by scheme, host and port", () => {
    const csp = (list: string, target?: string) =>
      verdict({ "content-security-policy": `default-src 'self'; frame-ancestors ${list}` }, target)
        .framable;

    expect(csp("http://localhost:*")).toBe(true);
    expect(csp("http://localhost:4100")).toBe(true);
    expect(csp("http://localhost:3000")).toBe(false);
    expect(csp("https://*.example.com")).toBe(false);
    expect(csp("http:")).toBe(true);
    // No scheme borrows the page's own: an https page naming localhost:4100
    // does not admit an http shell.
    expect(csp("localhost:4100")).toBe(false);
    expect(csp("localhost:4100", "http://example.com/")).toBe(true);
    // No port means the scheme's default, which the shell is not on.
    expect(csp("http://localhost")).toBe(false);

    // An IPv6 host is written in brackets, and the shell can be reached at one.
    expect(
      framingFor(
        new Headers({ "content-security-policy": "frame-ancestors http://[::1]:4100" }),
        "https://example.com/",
        "http://[::1]:4100/leglas/",
      ),
    ).toEqual({ framable: true });
  });

  test("every enforced policy has to admit the shell, and report-only ones are not enforced", () => {
    expect(
      verdict({
        "content-security-policy": "frame-ancestors http://localhost:*, frame-ancestors 'none'",
      }).framable,
    ).toBe(false);
    expect(verdict({ "content-security-policy-report-only": "frame-ancestors 'none'" })).toEqual({
      framable: true,
    });
  });
});

describe("checkFraming", () => {
  test("reads the answer at the end of any redirects", async () => {
    const fetcher: typeof fetch = async () => {
      const response = new Response("", {
        headers: { "x-frame-options": "SAMEORIGIN" },
      });

      Object.defineProperty(response, "url", { value: "http://localhost:4100/landing" });

      return response;
    };

    // Same origin as the shell after the redirect, so SAMEORIGIN admits it.
    expect(await checkFraming("https://example.com/", SHELL, fetcher)).toEqual({
      framable: true,
    });
  });

  test("a page that cannot be reached is not called a refusal", async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    expect(await checkFraming("https://example.com/", SHELL, fetcher)).toEqual({
      framable: null,
    });
  });
});
