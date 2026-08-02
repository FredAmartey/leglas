import { describe, expect, test } from "vitest";

import { resolveKey, shortcutList } from "./keymap.js";

const SHORTCUTS = shortcutList(true);

/**
 * Punctuation that needs AltGr on at least one common European layout. AltGr
 * arrives as ctrl+alt, which the modifier guard drops, so a binding on any of
 * these is unreachable for those keyboards no matter what the docs claim.
 */
const NEEDS_ALTGR = ["\\", "[", "]", "{", "}", "|", "@", "#", "~"];

describe("resolveKey", () => {
  test("resolves each binding", () => {
    expect(resolveKey({ key: "ArrowDown" })).toEqual({ kind: "move", delta: 1 });
    expect(resolveKey({ key: "ArrowUp" })).toEqual({ kind: "move", delta: -1 });
    expect(resolveKey({ key: "c" })).toEqual({ kind: "split" });
    expect(resolveKey({ key: "b" })).toEqual({ kind: "rail" });
    expect(resolveKey({ key: "k", metaKey: true })).toEqual({ kind: "search" });
    expect(resolveKey({ key: "?" })).toEqual({ kind: "help" });
  });

  describe("search", () => {
    test("takes command or control, on either platform", () => {
      expect(resolveKey({ key: "k", metaKey: true })).toEqual({ kind: "search" });
      expect(resolveKey({ key: "K", ctrlKey: true })).toEqual({ kind: "search" });
    });

    test("still reaches the search from inside a text field", () => {
      expect(resolveKey({ key: "k", metaKey: true, typing: true })).toEqual({ kind: "search" });
    });

    test("leaves other combinations on the same key alone", () => {
      expect(resolveKey({ key: "k", metaKey: true, shiftKey: true })).toBeNull();
      expect(resolveKey({ key: "k", metaKey: true, altKey: true })).toBeNull();
      expect(resolveKey({ key: "k" })).toBeNull();
    });

    test("no longer answers to a bare slash, which shares a key with help", () => {
      expect(resolveKey({ key: "/" })).toBeNull();
    });
  });

  test("jumps to a direction by digit, counting from one", () => {
    expect(resolveKey({ key: "1" })).toEqual({ kind: "jump", index: 0 });
    expect(resolveKey({ key: "9" })).toEqual({ kind: "jump", index: 8 });
    // 0 is not a slot, so it stays free rather than aliasing the tenth.
    expect(resolveKey({ key: "0" })).toBeNull();
  });

  test("takes a letter binding whether or not shift is down", () => {
    expect(resolveKey({ key: "C" })).toEqual({ kind: "split" });
    expect(resolveKey({ key: "B" })).toEqual({ kind: "rail" });
  });

  test("ignores everything while typing", () => {
    for (const key of ["c", "b", "/", "?", "1", "ArrowDown"]) {
      expect(resolveKey({ key, typing: true })).toBeNull();
    }
  });

  test("leaves meta, control and alt combinations to the browser", () => {
    expect(resolveKey({ key: "c", metaKey: true })).toBeNull();
    expect(resolveKey({ key: "c", ctrlKey: true })).toBeNull();
    expect(resolveKey({ key: "b", altKey: true })).toBeNull();
    // AltGr, as Windows reports it.
    expect(resolveKey({ key: "?", ctrlKey: true, altKey: true })).toBeNull();
  });

  test("binds nothing to a character that needs AltGr outside a US layout", () => {
    for (const key of NEEDS_ALTGR) {
      expect(resolveKey({ key })).toBeNull();
    }
  });

  test("the shortcuts it advertises are the shortcuts it resolves", () => {
    const advertised = SHORTCUTS.flatMap((shortcut) => shortcut.keys);
    // Escape is handled where the thing being closed lives, and the search
    // caps only mean anything together, which its own tests cover.
    const skip = ["Esc", "Cmd+K", "Ctrl+K"];
    for (const cap of advertised.filter((cap) => !skip.includes(cap))) {
      const key = cap === "↑" ? "ArrowUp" : cap === "↓" ? "ArrowDown" : cap;
      expect(resolveKey({ key })).not.toBeNull();
    }
  });

  test("names the search chord for the platform it is shown on", () => {
    expect(shortcutList(true).find((s) => s.label === "Search")?.keys).toEqual(["Cmd+K"]);
    expect(shortcutList(false).find((s) => s.label === "Search")?.keys).toEqual(["Ctrl+K"]);
  });

  test("advertises no cap that needs AltGr", () => {
    for (const cap of SHORTCUTS.flatMap((shortcut) => shortcut.keys)) {
      expect(NEEDS_ALTGR).not.toContain(cap);
    }
  });
});
