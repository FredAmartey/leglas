import { describe, expect, test } from "vitest";

import { ignoreEntry } from "./ignore.js";

describe("ignoreEntry", () => {
  test("adds the entry when there is no .gitignore at all", () => {
    expect(ignoreEntry(null)).toContain(".leglas/");
  });

  test("appends to an existing file without disturbing what is there", () => {
    const result = ignoreEntry("node_modules\ndist\n");

    expect(result).toContain("node_modules");
    expect(result).toContain("dist");
    expect(result).toContain(".leglas/");
  });

  test("does nothing when the entry is already present", () => {
    expect(ignoreEntry("node_modules\n.leglas/\n")).toBeNull();
  });

  test("recognises the entry without a trailing slash", () => {
    expect(ignoreEntry(".leglas\n")).toBeNull();
  });

  test("ignores surrounding whitespace when checking", () => {
    expect(ignoreEntry("  .leglas/  \n")).toBeNull();
  });

  test("does not treat a longer path as the entry", () => {
    expect(ignoreEntry(".leglas/variants\n")).toContain(".leglas/\n");
  });

  test("keeps the file ending in exactly one newline", () => {
    const result = ignoreEntry("node_modules");

    expect(result?.endsWith("\n")).toBe(true);
    expect(result?.endsWith("\n\n")).toBe(false);
  });
});
