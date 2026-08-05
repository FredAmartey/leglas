/**
 * What a submitted rename actually means, before anything is written.
 *
 * The form has four outcomes and only one of them is "renamed": clearing the
 * field puts the config's own title back, retyping the current name changes
 * nothing, and a name another direction already answers to would leave two
 * identical rows in the rail with no way to tell which is which. Deciding that
 * here keeps the shell free to say which one happened, and keeps the rule
 * testable without a DOM.
 *
 * Only display names are compared, never underlying titles. A title that has
 * been renamed away is not on screen anywhere, and refusing a name for
 * clashing with something invisible is worse than the clash.
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
