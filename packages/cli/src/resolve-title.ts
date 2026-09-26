import { resolveTitle, type Renames } from "@leglas/server";

export type Resolved = { ok: true; title: string } | { ok: false; error: string };

/**
 * Resolves a name a command was given, or explains why not. Rail renames are
 * local, so the name a user says is often not the config's; the rename map
 * covers that. For a name nothing answers to, pointing at leglas list would
 * just miss again and read as "the direction is gone".
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
      `npx leglas list shows every title.`,
  };
}
