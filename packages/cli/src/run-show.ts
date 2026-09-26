import { loadConfig, readLocalPreviews, readRenames, readRequests } from "@leglas/server";

import { resolveOrExplain } from "./resolve-title.js";
import { findLeglas, NOT_RUNNING } from "./running.js";
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
  hydration: { framework: string; message: string } | null;
  /** True when the page was taller than the frame and the PNG stops short. */
  cut: boolean;
};

type CaptureResponse = Pick<Screenshot, "file" | "width" | "height" | "viewport"> & {
  errors?: unknown;
  hydration?: unknown;
  cut?: unknown;
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function hasCaptureError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  );
}

/** Captures need a file and dimensions before the optional diagnostics matter. */
function hasCaptureSize(value: unknown): value is CaptureResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "file" in value &&
    typeof value.file === "string" &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number" &&
    "viewport" in value &&
    typeof value.viewport === "number"
  );
}

function isHydration(value: unknown): value is NonNullable<Screenshot["hydration"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    "framework" in value &&
    typeof value.framework === "string" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/**
 * Longer than the server's deadline plus a cold browser launch, so a stalled
 * capture is reported.
 */
const CAPTURE_WAIT_MS = 30_000;

/**
 * Everything about one direction, for whoever was handed its reference block.
 * Addressed by config title, like every other command, so a renamed direction
 * is still reachable.
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

  // The caller may hold the rail's name rather than the config's.
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

  type ShowEnvelope = {
    ok: true;
    direction: typeof plan.direction;
    variants: typeof plan.variants;
    comparedWith: typeof plan.comparedWith;
    requests: typeof plan.requests;
    screenshot?: Screenshot;
  };

  const envelope: ShowEnvelope = {
    ok: true,
    direction: plan.direction,
    variants: plan.variants,
    comparedWith: plan.comparedWith,
    requests: plan.requests,
  };

  if (options.screenshot) {
    const fail = (error: string) => {
      if (options.json) deps.log(JSON.stringify({ ok: false, error }));
      else deps.error(error);

      return { exitCode: 1 };
    };

    const request = deps.fetch ?? fetch;
    const found = await findLeglas(options.cwd, options.port, request);

    if (!found.ok) return fail(found.error);
    const port = found.port;

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

    const captured: unknown = await response.json().catch(() => ({}));

    if (!response.ok) {
      return fail(
        hasCaptureError(captured) ? captured.error : "The direction could not be captured.",
      );
    }

    if (!hasCaptureSize(captured)) return fail("The direction could not be captured.");
    envelope.screenshot = {
      file: captured.file,
      width: captured.width,
      height: captured.height,
      viewport: captured.viewport,
      errors: Array.isArray(captured.errors) ? captured.errors.filter(isString) : [],
      hydration: isHydration(captured.hydration)
        ? {
            framework: captured.hydration.framework,
            message: captured.hydration.message,
          }
        : null,
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

    if (envelope.screenshot.hydration !== null) {
      deps.log(
        `  hydration   ${envelope.screenshot.hydration.framework} rebuilt the page in the browser after load; the served markup is not what is on screen`,
      );
      deps.log(`              ${envelope.screenshot.hydration.message}`);
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
