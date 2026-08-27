import { realpath } from "node:fs/promises";

import {
  DEFAULT_PORT,
  loadConfig,
  readLocalPreviews,
  readRenames,
  readRequests,
  readServerInfo,
} from "@leglas/server";

import { resolveOrExplain } from "./resolve-title.js";
import { planShow } from "./show.js";

export type ShowDeps = {
  log(line: string): void;
  error(line: string): void;
  fetch?: typeof fetch;
};

type Screenshot = {
  file: string;
  width: number;
  height: number;
  viewport: number;
  errors: string[];
  /** True when the page was taller than the frame and the PNG stops short. */
  cut: boolean;
};

const NOT_RUNNING =
  "Leglas is not running here. Start it with npx leglas, then try again.";

/**
 * Longer than the server's own deadline plus a cold browser launch, so a
 * stalled capture is reported rather than sat on for good.
 */
const CAPTURE_WAIT_MS = 30_000;

/** Two paths that name one directory, whatever symlinks sit in the way. */
async function sameDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    realpath(left).catch(() => left),
    realpath(right).catch(() => right),
  ]);
  return a === b;
}

/**
 * Answer for one direction, for whoever was handed its reference block.
 *
 * Addressing is by config title, which is what every other command takes and
 * what the block quotes, so a renamed direction is still reachable by the name
 * the project knows it by.
 */
export async function runShow(
  options: {
    title: string;
    json: boolean;
    screenshot: boolean;
    width: number | null;
    port: number | null;
    cwd: string;
  },
  deps: ShowDeps,
): Promise<{ exitCode: number }> {
  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const requests = await readRequests(options.cwd);

  const previews = [
    ...(loaded.config?.previews ?? []).map((preview) => ({ ...preview, local: false })),
    ...local.previews,
  ];

  // Whoever ran this may be holding the name the rail showed them rather than
  // the one the config spells.
  const resolved = resolveOrExplain(
    options.title,
    previews.map((preview) => preview.title),
    await readRenames(options.cwd),
  );
  if (!resolved.ok) {
    if (options.json) deps.log(JSON.stringify({ ok: false, error: resolved.error }));
    else deps.error(resolved.error);
    return { exitCode: 1 };
  }

  const plan = planShow({ title: resolved.title, previews, requests });

  if (!plan.ok) {
    if (options.json) deps.log(JSON.stringify({ ok: false, error: plan.error }));
    else deps.error(plan.error);
    return { exitCode: 1 };
  }

  const envelope: {
    ok: true;
    direction: typeof plan.direction;
    variants: typeof plan.variants;
    comparedWith: typeof plan.comparedWith;
    requests: typeof plan.requests;
    screenshot?: Screenshot;
  } = {
    ok: true,
    direction: plan.direction,
    variants: plan.variants,
    comparedWith: plan.comparedWith,
    requests: plan.requests,
  };

  if (options.screenshot) {
    // An explicit port wins; then the record the running server wrote; then
    // the default, since a record can be missing while a server is up (two
    // servers on one project, the newer one gone first). The health probe
    // below is what decides, whichever way the port was found.
    const server = options.port === null ? await readServerInfo(options.cwd) : null;
    const port = options.port ?? server?.port ?? DEFAULT_PORT;
    const fail = (error: string) => {
      if (options.json) deps.log(JSON.stringify({ ok: false, error }));
      else deps.error(error);
      return { exitCode: 1 };
    };

    const request = deps.fetch ?? fetch;
    try {
      const health = await request(`http://127.0.0.1:${port}/leglas/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (health.status !== 200) return fail(NOT_RUNNING);
      // A stale record, or a port named by hand, can reach a Leglas that
      // serves another project. It would capture a direction of the same
      // name there and report a file that does not exist here.
      const answered = (await health.json().catch(() => ({}))) as { cwd?: unknown };
      if (typeof answered.cwd === "string" && !(await sameDirectory(answered.cwd, options.cwd))) {
        return fail(
          `The Leglas on port ${port} serves another project. Start one here with npx leglas, or name the right one with --port.`,
        );
      }
    } catch {
      return fail(NOT_RUNNING);
    }

    let response: Response;
    try {
      response = await request(`http://127.0.0.1:${port}/leglas/api/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: resolved.title, width: options.width ?? 1440 }),
        signal: AbortSignal.timeout(CAPTURE_WAIT_MS),
      });
    } catch (error) {
      return fail(
        error instanceof Error && error.name === "TimeoutError"
          ? "The capture did not finish in time."
          : NOT_RUNNING,
      );
    }
    const captured = (await response.json().catch(() => ({}))) as Partial<Screenshot> & {
      error?: unknown;
    };
    if (!response.ok) {
      return fail(
        typeof captured.error === "string"
          ? captured.error
          : "The direction could not be captured.",
      );
    }
    if (
      typeof captured.file !== "string" ||
      typeof captured.width !== "number" ||
      typeof captured.height !== "number" ||
      typeof captured.viewport !== "number"
    ) return fail("The direction could not be captured.");
    envelope.screenshot = {
      file: captured.file,
      width: captured.width,
      height: captured.height,
      viewport: captured.viewport,
      errors: Array.isArray(captured.errors)
        ? captured.errors.filter((error): error is string => typeof error === "string")
        : [],
      cut: captured.cut === true,
    };
  }

  if (options.json) {
    deps.log(JSON.stringify(envelope));
    return { exitCode: 0 };
  }

  const { direction } = plan;
  deps.log(`  ${direction.title}${direction.local ? "  (local)" : ""}`);
  if (direction.note !== null) deps.log(`  ${direction.note}`);
  deps.log("");
  if (direction.target !== null) deps.log(`  file        ${direction.target}`);
  if (direction.branch !== null) deps.log(`  branch      ${direction.branch}`);
  deps.log(`  url         ${direction.url}`);
  if (direction.tags.length > 0) deps.log(`  tags        ${direction.tags.join(", ")}`);
  if (direction.basedOn !== null) deps.log(`  variant of  ${direction.basedOn}`);
  if (plan.variants.length > 0) {
    deps.log(`  variants    ${plan.variants.map((variant) => variant.title).join(", ")}`);
  }
  if (plan.comparedWith.length > 0) {
    deps.log(`  against     ${plan.comparedWith.join(", ")}`);
  }
  if (envelope.screenshot !== undefined) {
    deps.log(`  screenshot  ${envelope.screenshot.file}`);
    if (envelope.screenshot.cut) {
      deps.log("              the top of the page only; it is taller than one capture");
    }
    if (envelope.screenshot.errors.length > 0) {
      const count = envelope.screenshot.errors.length;
      deps.log(`  console     ${count} ${count === 1 ? "error" : "errors"} on load`);
      for (const error of envelope.screenshot.errors) deps.log(`    ${error}`);
    }
  }

  if (plan.requests.length > 0) {
    deps.log("");
    deps.log(`  Pending, not yet done (${plan.requests.length}):`);
    for (const request of plan.requests) deps.log(`    ${request.status}  ${request.intent}`);
    deps.log("");
    deps.log("  Run npx leglas requests --json for the full prompts.");
  }
  return { exitCode: 0 };
}
