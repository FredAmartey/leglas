/**
 * Keystrokes resolved to actions, and the list the help overlay renders.
 * Separate from the listener so bindings test without a DOM and the overlay
 * can't drift from the real keys.
 *
 * Every binding is a letter, digit or arrow. The first version used `\` and
 * `[`, which need AltGr on German and French layouts; AltGr arrives as ctrl+alt
 * on Windows and alt on macOS, which `resolveKey` drops to leave the browser
 * and OS their shortcuts, so those keys never fired outside a US layout. Shift
 * isn't a guard: `?` is shift+/ everywhere, and AZERTY needs shift for digits.
 */

export type KeyAction =
  | { kind: "help" }
  | { kind: "jump"; index: number }
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "note" }
  | { kind: "rail" }
  | { kind: "request" }
  | { kind: "search" }
  | { kind: "split" }
  | { kind: "tools" };

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
  // Search is the one binding with a modifier, and the only one that works from
  // a text field: reaching for it mid-intent should go to search, not type. Not
  // alt or shift, which belong to other apps.
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

  if (letter === "a") return { kind: "note" };

  if (letter === "c") return { kind: "split" };

  if (letter === "b") return { kind: "rail" };

  if (letter === "r") return { kind: "request" };

  // The way back to the tools when the widget was switched off from inside
  // them, and a shortcut in its own right.
  if (letter === "t") return { kind: "tools" };

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
 * How the search chord is written in the search hint and the overlay: symbol
 * and word on a Mac, words alone elsewhere.
 */
export function searchCap(mac: boolean): string {
  return mac ? "⌘Cmd+K" : "Ctrl+K";
}

/**
 * The keymap as the overlay lists it, ordered by how often each key is used.
 * Takes the platform as an argument so it stays pure and both sets of caps can
 * be tested.
 */
export function shortcutList(mac: boolean, viewer = false): readonly Shortcut[] {
  const all: readonly (Shortcut & { changes?: boolean })[] = [
    { keys: ["↑", "↓"], label: "Move between directions" },
    { keys: ["1", "9"], join: "to", label: "Jump straight to a direction" },
    { keys: ["C"], label: "Compare against the direction you were last on" },
    { keys: ["R"], label: "Ask for a change to this direction", changes: true },
    { keys: ["A"], label: "Annotate the design: point at what is wrong", changes: true },
    { keys: [searchCap(mac)], label: "Search" },
    { keys: ["B"], label: "Collapse or open the rail" },
    { keys: ["T"], label: "Open or close the Leglas dev tool menu" },
    { keys: ["?"], label: "This list" },
    { keys: ["Esc"], label: "Clear the search, or close what is open" },
  ];

  // A viewer can look and compare, never change what runs, so the keys that ask
  // for work aren't listed.
  const listed: Shortcut[] = [];

  for (const { changes, ...shortcut } of all) {
    if (!(viewer && changes)) listed.push(shortcut);
  }

  return listed;
}
