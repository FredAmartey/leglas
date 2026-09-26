/**
 * What a submitted rename means, before anything is written. Four outcomes:
 * clearing the field restores the config title, retyping the current name
 * changes nothing, a name another direction shows is refused (two identical
 * rows), and anything else renames. Deciding here lets the shell say which
 * happened and keeps it testable. Only display names are compared: a
 * renamed-away title isn't on screen, and refusing a clash with it is worse
 * than the clash.
 */
export type NameCheck =
  | { kind: "reset"; value: string }
  | { kind: "same" }
  | { kind: "set"; value: string }
  | { kind: "taken"; by: string };

const fold = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

export function checkName(
  raw: string,
  title: string,
  /** Every direction's title mapped to the name it currently shows. */
  names: ReadonlyMap<string, string>,
): NameCheck {
  const value = raw.trim().replace(/\s+/g, " ");
  const current = names.get(title) ?? title;

  if (value === "" || value === title) {
    return current === title ? { kind: "same" } : { kind: "reset", value: title };
  }

  if (value === current) return { kind: "same" };

  for (const [other, name] of names) {
    if (other !== title && fold(name) === fold(value)) return { kind: "taken", by: name };
  }

  return { kind: "set", value };
}
