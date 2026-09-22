import { loadConfig, readLocalPreviews, readRenames } from "@leglas/server";

import type { ShareReach, ShareTunnel } from "./args.js";
import { bodyOf, isJsonObject, isNumber, isString, type JsonValue } from "./json.js";
import { resolveOrExplain } from "./resolve-title.js";
import { findLeglas, NOT_RUNNING } from "./running.js";

export type ShareOptions = {
  /** None shares the rail; one shares that direction alone; two compare them. */
  titles: string[];
  reach: ShareReach;
  tunnel: ShareTunnel | null;
  stop: boolean;
  port: number | null;
  json: boolean;
  cwd: string;
};

export type ShareDeps = {
  log(line: string): void;
  error(line: string): void;
  fetch?: typeof fetch;
  /** The pause between reads of a tunnel still starting. Injected so tests do not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * How long to wait for a tunnel's public address before handing back the
 * local one. A quick tunnel usually answers in seconds; a minute covers a
 * slow one without leaving a terminal hanging on a tunnel that failed quietly.
 */
export const TUNNEL_WAIT_MS = 60_000;

const TUNNEL_POLL_MS = 500;

type Tunnel =
  | { status: "none" }
  | { status: "starting"; provider: string }
  | { status: "ready"; provider: string; url: string }
  | { status: "failed"; provider: string; reason: string };

type ShareLink = { name: string; url: string | null; localUrl: string; expiresAt: number };

type ShareView = {
  scope: string;
  titles: string[];
  reach: string;
  tunnel: Tunnel;
  links: ShareLink[];
};

/** `answered` is false when the request never got a reply, so what it did is unknown. */
type Read<T> = { ok: true; value: T } | { ok: false; error: string; answered: boolean };

/** What the share endpoint takes: the manifest the panel sends, and the tunnel to use. */
type ShareBody = {
  scope: "rail" | "direction" | "compare";
  titles: string[];
  layout: {
    order: string[];
    renames: Record<string, string>;
    collapsedFamilies: string[];
    compare: string | null;
    viewport: number | null;
  };
  reach: ShareReach;
  routes: string[];
  tunnel?: ShareTunnel;
};

function stringsOf(value: JsonValue | undefined): string[] | null {
  return Array.isArray(value) && value.every(isString) ? value : null;
}

function tunnelFrom(value: JsonValue | undefined): Tunnel | null {
  if (value === undefined || !isJsonObject(value)) return null;
  const provider = isString(value.provider) ? value.provider : "The tunnel";

  switch (value.status) {
    case "none":
      return { status: "none" };
    case "starting":
      return { status: "starting", provider };
    case "ready":
      return isString(value.url) ? { status: "ready", provider, url: value.url } : null;
    case "failed":
      return {
        status: "failed",
        provider,
        reason: isString(value.reason) ? value.reason : "it stopped",
      };
    default:
      return null;
  }
}

function linkFrom(value: JsonValue): ShareLink | null {
  if (!isJsonObject(value) || !isString(value.localUrl) || !isNumber(value.expiresAt)) return null;

  return {
    name: isString(value.name) ? value.name : "",
    url: isString(value.url) ? value.url : null,
    localUrl: value.localUrl,
    expiresAt: value.expiresAt,
  };
}

/**
 * The running share as the server reports it, read field by field: this
 * command can be newer or older than the Leglas it is talking to.
 */
function shareFrom(value: JsonValue | undefined): ShareView | null {
  if (value === undefined || !isJsonObject(value)) return null;
  const titles = stringsOf(value.titles);
  const tunnel = tunnelFrom(value.tunnel);

  if (
    !isString(value.scope) ||
    titles === null ||
    tunnel === null ||
    !Array.isArray(value.grants)
  ) {
    return null;
  }

  return {
    scope: value.scope,
    titles,
    reach: isString(value.reach) ? value.reach : "open",
    tunnel,
    links: value.grants.flatMap((grant) => {
      const link = linkFrom(grant);

      return link === null ? [] : [link];
    }),
  };
}

async function readShare(base: string, request: typeof fetch): Promise<Read<ShareView | null>> {
  try {
    const response = await request(`${base}/leglas/api/share`);

    if (!response.ok) {
      return {
        ok: false,
        error: `Leglas answered ${response.status} when asked what it is sharing.`,
        answered: true,
      };
    }

    const payload = await bodyOf(response);

    if (!isJsonObject(payload)) {
      return { ok: false, error: "Leglas did not say what it is sharing.", answered: true };
    }

    if (payload.share === null) return { ok: true, value: null };
    const share = shareFrom(payload.share);

    return share === null
      ? {
          ok: false,
          error: "Leglas is sharing something this version of the command cannot read.",
          answered: true,
        }
      : { ok: true, value: share };
  } catch {
    return { ok: false, error: NOT_RUNNING, answered: false };
  }
}

async function post(
  base: string,
  path: string,
  body: JsonValue,
  request: typeof fetch,
  fallback: string,
): Promise<Read<JsonValue>> {
  try {
    const response = await request(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await bodyOf(response);

    if (!response.ok) {
      return {
        ok: false,
        error: isJsonObject(payload) && isString(payload.error) ? payload.error : fallback,
        answered: true,
      };
    }

    return { ok: true, value: payload };
  } catch {
    return { ok: false, error: NOT_RUNNING, answered: false };
  }
}

function describe(share: ShareView): string {
  const [first, second] = share.titles;

  if (share.scope === "compare" && first !== undefined && second !== undefined) {
    return `${first} and ${second}, side by side`;
  }

  if (share.scope === "direction" && first !== undefined) return first;
  const count = share.titles.length;

  return `the rail, ${count} ${count === 1 ? "direction" : "directions"}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function tunnelLine(tunnel: Tunnel): string | null {
  switch (tunnel.status) {
    case "ready":
      return null;
    case "none":
      return "no cloudflared or ngrok on this machine; the link works here, or through a tunnel you run yourself";
    case "starting":
      return `${tunnel.provider} is still starting; run npx leglas share again for the public link`;
    case "failed":
      return `${tunnel.provider} failed: ${tunnel.reason}`;
  }
}

/**
 * Share from the terminal what the panel shares from the interface.
 *
 * The share itself is the running Leglas's, through the same endpoints the
 * panel calls, so it carries the same refusals and the same ceiling. What a
 * terminal cannot have is the browser's own view of the rail, so the rail it
 * shares is the project's: every direction in config order, under the names
 * the interface saved.
 */
export async function runShare(
  options: ShareOptions,
  deps: ShareDeps,
): Promise<{ exitCode: number }> {
  const request = deps.fetch ?? fetch;

  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const fail = (error: string) => {
    if (options.json) deps.log(JSON.stringify({ ok: false, error }));
    else deps.error(error);

    return { exitCode: 1 };
  };

  const found = await findLeglas(options.cwd, options.port, request);

  if (!found.ok) return fail(found.error);

  if (options.stop) {
    const stopped = await post(
      found.base,
      "/leglas/api/share/stop",
      {},
      request,
      "Leglas could not stop sharing.",
    );

    if (!stopped.ok) return fail(stopped.error);

    if (options.json) deps.log(JSON.stringify({ ok: true, stopped: true }));
    else deps.log("  stopped  nothing is shared any more");

    return { exitCode: 0 };
  }

  const running = await readShare(found.base, request);

  if (!running.ok) return fail(running.error);

  const report = (share: ShareView, already: boolean, leftOut: readonly string[]) => {
    if (options.json) {
      deps.log(
        JSON.stringify({
          ok: true,
          alreadySharing: already,
          share: {
            scope: share.scope,
            titles: share.titles,
            reach: share.reach,
            tunnel: share.tunnel,
            links: share.links,
          },
          leftOut,
        }),
      );

      return { exitCode: 0 };
    }

    deps.log(`  sharing  ${describe(share)}${already ? " (already running)" : ""}`);

    if (share.reach === "listed") {
      deps.log("  reach    only the paths the share lists; allow more from the share panel");
    }

    for (const link of share.links) {
      const label = link.name === "" ? "" : `${link.name}  `;

      if (link.url !== null) deps.log(`  link     ${label}${link.url}`);
      else deps.log(`  local    ${label}${link.localUrl}`);
    }

    const tunnel = tunnelLine(share.tunnel);

    if (tunnel !== null) deps.log(`  tunnel   ${tunnel}`);
    const ends = share.links.map((link) => link.expiresAt);

    if (ends.length > 0) deps.log(`  until    ${clock(Math.min(...ends))}`);

    for (const title of leftOut) {
      deps.log(`  left out ${title}: branch directions can't be shared yet`);
    }

    deps.log("  stop     npx leglas share --stop");

    return { exitCode: 0 };
  };

  const loaded = await loadConfig(options.cwd);
  const local = await readLocalPreviews(options.cwd);
  const renames = await readRenames(options.cwd);
  const previews = [...(loaded.config?.previews ?? []), ...local.previews];
  const known = [...new Set(previews.map((preview) => preview.title))];
  const titles: string[] = [];

  // The name a person says is the one their rail showed them.
  for (const asked of options.titles) {
    const resolved = resolveOrExplain(asked, known, renames);

    if (!resolved.ok) return fail(resolved.error);
    titles.push(resolved.title);
  }

  if (running.value !== null) {
    const same =
      titles.length === 0 ||
      (titles.length === running.value.titles.length &&
        titles.every((title, index) => running.value?.titles[index] === title));

    if (!same) {
      return fail(
        `Leglas is already sharing ${describe(running.value)}. Stop it with npx leglas share --stop, then share again.`,
      );
    }

    return report(running.value, true, []);
  }

  const branches = new Set(
    previews.flatMap((preview) => (preview.branch === undefined ? [] : [preview.title])),
  );

  const shared = titles.length > 0 ? titles : known.filter((title) => !branches.has(title));
  const leftOut = titles.length > 0 ? [] : known.filter((title) => branches.has(title));

  if (shared.length === 0) {
    return fail("Nothing on the rail can be shared: branch directions can't be shared yet.");
  }

  const [, right] = shared;

  const scope: ShareBody["scope"] =
    titles.length === 0 ? "rail" : titles.length === 1 ? "direction" : "compare";

  const body: ShareBody = {
    scope,
    titles: shared,
    layout: {
      order: shared,
      renames: Object.fromEntries(
        Object.entries(renames).filter(([title]) => shared.includes(title)),
      ),
      collapsedFamilies: [],
      compare: scope === "compare" && right !== undefined ? right : null,
      viewport: null,
    },
    reach: options.reach,
    routes: [],
  };

  if (options.tunnel !== null) body.tunnel = options.tunnel;

  // Once the start has been asked for, a share may exist. Failing without
  // ending it would leave the app open to a link nobody was given, with an
  // error saying nothing happened.
  const giveUp = async (error: string, known = true) => {
    const stopped = await post(found.base, "/leglas/api/share/stop", {}, request, "");
    const what = known ? "The share it started" : "A share";

    return fail(
      stopped.ok
        ? `${error} ${known ? "The share it started is stopped." : "Anything it started is stopped."}`
        : `${error} ${what} may still be running; stop it with npx leglas share --stop.`,
    );
  };

  const created = await post(
    found.base,
    "/leglas/api/share",
    body,
    request,
    "Leglas could not start sharing.",
  );

  if (!created.ok) {
    // No reply at all is not a refusal: the share may have been made before
    // the connection went, so it is treated as one that exists.
    return created.answered
      ? fail(created.error)
      : giveUp("Leglas stopped answering while the share was starting.", false);
  }

  let share = isJsonObject(created.value) ? shareFrom(created.value.share) : null;

  if (share === null) {
    return giveUp("Leglas started a share this version of the command cannot read.");
  }

  for (
    let waited = 0;
    share.tunnel.status === "starting" && waited < TUNNEL_WAIT_MS;
    waited += TUNNEL_POLL_MS
  ) {
    await sleep(TUNNEL_POLL_MS);
    const read = await readShare(found.base, request);

    if (!read.ok) return giveUp(read.error);

    if (read.value === null) return fail("The share was stopped while its tunnel was starting.");
    share = read.value;
  }

  return report(share, false, leftOut);
}
