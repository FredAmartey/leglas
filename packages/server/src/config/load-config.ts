import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeConfig, type LeglasConfig } from "./config.js";
import { findConfigFile } from "./find-config.js";

export type LoadResult = {
  config: LeglasConfig | null;
  errors: string[];
  /** The file used, or null when running on the implicit zero-config default. */
  path: string | null;
};

/**
 * Resolve, read, and validate the project's config.
 *
 * A broken config is reported, never thrown: the server has to stay up and say
 * what is wrong, because the alternative is a crash at boot with a stack trace
 * that does not name the file the user needs to edit.
 */
export async function loadConfig(cwd: string): Promise<LoadResult> {
  const path = findConfigFile(cwd);

  if (path === null) {
    return { ...normalizeConfig(undefined), path: null };
  }

  const label = relative(cwd, path) || path;

  let exported: unknown;
  try {
    if (path.endsWith(".json")) {
      exported = JSON.parse(await readFile(path, "utf8"));
    } else {
      // Node imports TypeScript natively, so a .ts config needs no transform.
      const module: { default?: unknown } = await import(pathToFileURL(path).href);
      if (!("default" in module)) {
        return { config: null, errors: [`${label} has no default export.`], path };
      }
      exported = module.default;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: null, errors: [`${label} could not be loaded: ${message}`], path };
  }

  const result = normalizeConfig(exported);
  return {
    config: result.config,
    errors: result.errors.map((error) => `${label}: ${error}`),
    path,
  };
}
