import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { UNRESOLVED_PROJECT, fixedProject, hostProject, type RootsHost } from "./project.js";

function scratch(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `leglas-${name}-`)));
}

/** A host that has already initialized and answers with the roots it is given. */
function host(roots: string[] | null, options: { fails?: boolean } = {}): RootsHost {
  return {
    getClientCapabilities: () => (roots === null ? {} : { roots: {} }),
    listRoots: async () => {
      if (options.fails === true) throw new Error("refused");
      return { roots: (roots ?? []).map((root) => ({ uri: pathToFileURL(root).href })) };
    },
  };
}

describe("fixedProject", () => {
  test("answers with the directory it was given", async () => {
    await expect(fixedProject("/somewhere").locate()).resolves.toEqual({
      ok: true,
      directory: "/somewhere",
    });
  });
});

describe("hostProject", () => {
  test("takes the declared root when the working directory is elsewhere", async () => {
    // The Agent Plugins case: started in the plugin's own install directory,
    // with the project only reachable over roots.
    const project = scratch("project");

    const located = await hostProject(host([project]), { cwd: scratch("plugin") }).locate();

    expect(located).toEqual({ ok: true, directory: project });
  });

  test("keeps the working directory when it sits inside a declared root", async () => {
    // A host started in packages/app means that, not the repository above it,
    // and config resolution walks upward from there anyway.
    const repo = scratch("repo");
    const app = join(repo, "packages/app");

    const located = await hostProject(host([repo]), { cwd: app }).locate();

    expect(located).toEqual({ ok: true, directory: app });
  });

  test("keeps the working directory when the host declares no roots at all", async () => {
    // Every host that starts the server in the project, which is claude mcp
    // add and every hand-written .mcp.json.
    const cwd = scratch("project");

    const located = await hostProject(host(null), { cwd }).locate();

    expect(located).toEqual({ ok: true, directory: cwd });
  });

  test("keeps the working directory when the host refuses to list its roots", async () => {
    const cwd = scratch("project");

    const located = await hostProject(host([], { fails: true }), { cwd }).locate();

    expect(located).toEqual({ ok: true, directory: cwd });
  });

  test("an explicit LEGLAS_PROJECT_DIR outranks both", async () => {
    const chosen = scratch("chosen");

    const located = await hostProject(host([scratch("root")]), {
      cwd: scratch("plugin"),
      override: chosen,
    }).locate();

    expect(located).toEqual({ ok: true, directory: chosen });
  });

  test("refuses when the working directory is the plugin's own and nothing else answers", async () => {
    // Acting here would write into a plugin cache and report success, which is
    // worse than saying there is no project.
    const pluginRoot = scratch("plugin");

    const located = await hostProject(host(null), {
      cwd: pluginRoot,
      pluginRoot,
    }).locate();

    expect(located).toEqual({ ok: false, reason: UNRESOLVED_PROJECT });
    expect(UNRESOLVED_PROJECT).toContain("LEGLAS_PROJECT_DIR");
  });

  test("a declared root rescues a working directory inside the plugin", async () => {
    const pluginRoot = scratch("plugin");
    const project = scratch("project");

    const located = await hostProject(host([project]), { cwd: pluginRoot, pluginRoot }).locate();

    expect(located).toEqual({ ok: true, directory: project });
  });

  test("an unexpanded ${PLUGIN_ROOT} placeholder matches nothing and is ignored", async () => {
    const cwd = scratch("project");

    const located = await hostProject(host(null), {
      cwd,
      pluginRoot: "${PLUGIN_ROOT}",
    }).locate();

    expect(located).toEqual({ ok: true, directory: cwd });
  });

  test("skips roots that name no directory on this machine", async () => {
    const project = scratch("project");
    const mixed: RootsHost = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => ({
        roots: [{ uri: "https://example.com/elsewhere" }, { uri: pathToFileURL(project).href }],
      }),
    };

    const located = await hostProject(mixed, { cwd: scratch("plugin") }).locate();

    expect(located).toEqual({ ok: true, directory: project });
  });

  test("waits for the host to initialize before asking for roots", async () => {
    const project = scratch("project");
    let initialized = false;
    const late: RootsHost = {
      getClientCapabilities: () => (initialized ? { roots: {} } : undefined),
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(project).href }] }),
    };
    const resolving = hostProject(late, { cwd: scratch("plugin") }).locate();

    // Asking now would be a protocol error, so nothing has been asked yet.
    initialized = true;
    late.oninitialized?.();

    await expect(resolving).resolves.toEqual({ ok: true, directory: project });
  });

  test("resolves once and holds the answer", async () => {
    const project = scratch("project");
    let asked = 0;
    const counting: RootsHost = {
      getClientCapabilities: () => ({ roots: {} }),
      listRoots: async () => {
        asked += 1;
        return { roots: [{ uri: pathToFileURL(project).href }] };
      },
    };
    const resolver = hostProject(counting, { cwd: scratch("plugin") });

    await Promise.all([resolver.locate(), resolver.locate()]);
    await resolver.locate();

    expect(asked).toBe(1);
  });
});
