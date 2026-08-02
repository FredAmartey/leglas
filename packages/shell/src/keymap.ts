/**
 * Keystrokes resolved to actions, and the list the help overlay renders.
 *
 * Separated from the listener for two reasons: the bindings can be tested
 * without a DOM, and the overlay is generated from the same source that
 * resolves the keys, so a documented shortcut cannot drift from a real one.
 *
 * Every binding is a letter, a digit or an arrow, deliberately. The first
 * version used `\` to split and `[` to collapse the rail, and both were
 * unreachable on most of Europe: `\` is AltGr+ß on a German layout and
 * AltGr+8 on a French one, `[` needs AltGr on both. AltGr arrives as ctrl+alt
 * on Windows and as alt on macOS, which `resolveKey` drops so the browser and
 * the OS keep their own shortcuts. The two guards together meant those
 * keystrokes could never fire outside a US layout.
 *
 * Shift is deliberately not a guard: `?` is shift+/ everywhere, and AZERTY
 * needs shift for its digits.
 */

export type KeyAction =
  | { kind: "help" }
  | { kind: "jump"; index: number }
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "rail" }
  | { kind: "search" }
  | { kind: "split" };

export type Keystroke = {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  /** True when focus is in a text field, where every key is just typing. */
  typing?: boolean;
};

/** Highest direction reachable by a digit; 0 is not a slot. */
export const MAX_JUMP = 9;

export function resolveKey(stroke: Keystroke): KeyAction | null {
  // Search is the one binding that holds a modifier, and the only one that
  // still works from inside a text field: reaching for it while typing an
  // intent should take you to the search rather than insert a character.
  // Deliberately not alt or shift, which are other applications' bindings.
  if (
    (stroke.metaKey || stroke.ctrlKey) &&
    !stroke.altKey &&
    !stroke.shiftKey &&
    stroke.key.toLowerCase() === "k"
  ) {
    return { kind: "search" };
  }

  if (stroke.typing) return null;
  if (stroke.metaKey || stroke.ctrlKey || stroke.altKey) return null;

  const { key } = stroke;
  if (key === "?") return { kind: "help" };
  if (key === "ArrowDown") return { kind: "move", delta: 1 };
  if (key === "ArrowUp") return { kind: "move", delta: -1 };

  const letter = key.length === 1 ? key.toLowerCase() : "";
  if (letter === "c") return { kind: "split" };
  if (letter === "b") return { kind: "rail" };

  if (key.length === 1 && key >= "1" && key <= String(MAX_JUMP)) {
    return { kind: "jump", index: Number(key) - 1 };
  }
  return null;
}

export type Shortcut = {
  keys: readonly string[];
  /** Word between two caps, for a range. */
  join?: string;
  label: string;
};

/**
 * How the search chord is written, for the hint in the search field and the
 * overlay. Spelled out rather than ⌘ so it reads the same on both platforms.
 */
export function searchCap(mac: boolean): string {
  return mac ? "Cmd+K" : "Ctrl+K";
}

/**
 * The keymap as the overlay lists it, in the order it is shown. Ordered by how
 * often a key is reached for rather than alphabetically or by kind.
 *
 * Takes the platform rather than reading it, so the list stays pure and the
 * caps can be tested for both.
 */
export function shortcutList(mac: boolean): readonly Shortcut[] {
  return [
    { keys: ["↑", "↓"], label: "Move between directions" },
    { keys: ["1", "9"], join: "to", label: "Jump straight to a direction" },
    { keys: ["C"], label: "Compare against the direction you were last on" },
    { keys: [searchCap(mac)], label: "Search" },
    { keys: ["B"], label: "Collapse or open the rail" },
    { keys: ["?"], label: "This list" },
    { keys: ["Esc"], label: "Clear the search, or close what is open" },
  ];
}
