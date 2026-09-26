import { vi } from "vitest";

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
