import { resolveTitle, type Renames } from "@leglas/server";

export type Resolved = { ok: true; title: string } | { ok: false; error: string };

/**
 * Resolve a name a command was given, and say something useful when it cannot.
 *
 * The message matters more than usual here. A direction renamed in the rail is
 * only renamed on this machine, so the name a user says is often not the name
 * the config spells; that gap is covered by resolving through the rename map.
 * What is left is a name nothing answers to, where the old message ("run
 * leglas list") sent an agent to a listing that would not contain the name
 * either, and the second miss reads as "the direction is gone".
 */
export function resolveOrExplain(
  input: string,
  titles: readonly string[],
  renames: Renames,
): Resolved {
  const resolution = resolveTitle(input, titles, renames);
  if (resolution.ok) return { ok: true, title: resolution.title };

  if (resolution.reason === "ambiguous") {
    return {
      ok: false,
      error:
        `More than one direction is called ${JSON.stringify(input)} on this machine: ` +
        `${resolution.matches.join(", ")}. Name the one you mean by its title in the config.`,
    };
  }

  return {
    ok: false,
    error:
      `No direction called ${JSON.stringify(input)}. Renaming one in the rail only renames it ` +
      `here, and it still answers to its title in the config, which its reference block quotes. ` +
      `leglas list shows every title.`,
  };
}
