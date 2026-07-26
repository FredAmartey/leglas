import { describe, expect, test } from "vitest";

import { findDuplicates, stableSignature } from "./duplicates.js";
import type { Preview } from "./config.js";

const preview = (title: string, url: string): Preview => ({
  title,
  url,
  note: undefined,
  tags: [],
});

/** A fetcher that returns canned bodies, cycling per call to simulate noise. */
function canned(bodies: Record<string, string[]>) {
  const counts: Record<string, number> = {};
  return async (url: string) => {
    const list = bodies[url] ?? [""];
    const index = counts[url] ?? 0;
    counts[url] = index + 1;
    return list[Math.min(index, list.length - 1)] as string;
  };
}

describe("stableSignature", () => {
  test("keeps the lines two fetches agree on", () => {
    expect(stableSignature("a\nb\nc", "a\nx\nc")).toBe("a\nc");
  });

  test("is identical for two renders of the same stable page", () => {
    expect(stableSignature("a\nb", "a\nb")).toBe(stableSignature("a\nb", "a\nb"));
  });

  test("ignores blank lines and surrounding whitespace", () => {
    expect(stableSignature("  a  \n\n b ", "a\nb")).toBe("a\nb");
  });

  test("works on single-line markup, which is what frameworks actually emit", () => {
    // Real responses arrive as one long line, so splitting on newlines alone
    // would compare two indivisible blobs and call everything unique.
    const first = '<h1>same</h1><script>id="AAA"</script><p>tail</p>';
    const second = '<h1>same</h1><script>id="BBB"</script><p>tail</p>';

    const signature = stableSignature(first, second);

    expect(signature).toContain("h1>same");
    expect(signature).toContain("p>tail");
    expect(signature).not.toContain("AAA");
    expect(signature).not.toContain("BBB");
  });
});

describe("findDuplicates", () => {
  test("reports nothing when every preview renders differently", async () => {
    const previews = [preview("A", "/a"), preview("B", "/b")];
    const groups = await findDuplicates(
      previews,
      canned({ "/a": ["<h1>alpha</h1>"], "/b": ["<h1>beta</h1>"] }),
    );

    expect(groups).toEqual([]);
  });

  test("groups previews whose pages are the same, which is the typo case", async () => {
    // "/?v-hero=wavee" is a typo: the app ignores it and serves the default,
    // so it renders exactly what "/" renders.
    const previews = [preview("Original", "/"), preview("Wave", "/?v-hero=wavee")];
    const groups = await findDuplicates(
      previews,
      canned({ "/": ["<h1>home</h1>"], "/?v-hero=wavee": ["<h1>home</h1>"] }),
    );

    expect(groups).toEqual([["Original", "Wave"]]);
  });

  test("sees through per-request noise rather than calling every page unique", async () => {
    // Each fetch carries a fresh nonce; the pages are otherwise identical.
    const previews = [preview("A", "/a"), preview("B", "/b")];
    const groups = await findDuplicates(
      previews,
      canned({
        "/a": ["nonce-1\n<h1>same</h1>", "nonce-2\n<h1>same</h1>"],
        "/b": ["nonce-3\n<h1>same</h1>", "nonce-4\n<h1>same</h1>"],
      }),
    );

    expect(groups).toEqual([["A", "B"]]);
  });

  test("does not group pages that differ only outside the noise", async () => {
    const previews = [preview("A", "/a"), preview("B", "/b")];
    const groups = await findDuplicates(
      previews,
      canned({
        "/a": ["nonce-1\n<h1>alpha</h1>", "nonce-2\n<h1>alpha</h1>"],
        "/b": ["nonce-3\n<h1>beta</h1>", "nonce-4\n<h1>beta</h1>"],
      }),
    );

    expect(groups).toEqual([]);
  });

  test("groups three at once rather than reporting overlapping pairs", async () => {
    const previews = [preview("A", "/a"), preview("B", "/b"), preview("C", "/c")];
    const groups = await findDuplicates(
      previews,
      canned({ "/a": ["same"], "/b": ["same"], "/c": ["same"] }),
    );

    expect(groups).toEqual([["A", "B", "C"]]);
  });

  test("skips a preview that cannot be fetched instead of failing the check", async () => {
    const previews = [preview("A", "/a"), preview("Dead", "/dead")];
    const groups = await findDuplicates(previews, async (url) => {
      if (url === "/dead") throw new Error("connection refused");
      return "<h1>same</h1>";
    });

    expect(groups).toEqual([]);
  });

  test("sees past a framework echoing the request into its hydration payload", async () => {
    // Real shape: the request is serialised into a script in the framework's
    // own encoding, so the literal query string never appears to be stripped.
    const previews = [preview("Original", "/"), preview("Typo", "/?v-hero=wavee")];
    const groups = await findDuplicates(
      previews,
      canned({
        "/": ['<h1>home</h1><script>push("__PAGE__",{})</script>'],
        "/?v-hero=wavee": [
          '<h1>home</h1><script>push("__PAGE__?{\\"v-hero\\":\\"wavee\\"}",{})</script>',
        ],
      }),
    );

    expect(groups).toEqual([["Original", "Typo"]]);
  });

  test("still separates previews that render different markup", async () => {
    const previews = [preview("A", "/a"), preview("B", "/b")];
    const groups = await findDuplicates(
      previews,
      canned({
        "/a": ["<h1>alpha</h1><script>noise-1</script>"],
        "/b": ["<h1>beta</h1><script>noise-2</script>"],
      }),
    );

    expect(groups).toEqual([]);
  });

  test("ignores absolute urls, which are not ours to compare", async () => {
    const previews = [preview("Local", "/"), preview("Staging", "https://example.com/")];
    const groups = await findDuplicates(previews, canned({ "/": ["same"] }));

    expect(groups).toEqual([]);
  });
});
