import { vi } from "vitest";

import { parseArgs } from "./args.js";
import { runAdd } from "./run-previews.js";

/** A running Leglas that serves this project and has these directions on its rail. */
export function leglasServing(cwd: string, titles: readonly string[]) {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (input) =>
      String(input).endsWith("/leglas/api/config")
        ? new Response(JSON.stringify({ previews: titles.map((title) => ({ title })) }))
        : new Response(JSON.stringify({ cwd })),
    );
}

/** Registers a direction on this machine the way `leglas add <flags> --json` does. */
export async function addLocal(cwd: string, ...flags: string[]) {
  const parsed = parseArgs(["add", ...flags]);

  if (parsed.kind !== "add") throw new Error(`leglas add ${flags.join(" ")} did not parse.`);

  const { exitCode } = await runAdd(
    { preview: parsed.preview, json: true, cwd },
    { log: () => {}, error: () => {} },
  );

  if (exitCode !== 0) throw new Error(`leglas add ${flags.join(" ")} exited ${exitCode}.`);
}
