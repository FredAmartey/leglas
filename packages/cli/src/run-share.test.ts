import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { writeRenames } from "@leglas/server";

import { isJsonObject, type JsonValue } from "./json.js";
import { runAdd } from "./run-previews.js";
import { runShare, type ShareOptions } from "./run-share.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-share-"));
}

function collect() {
  const lines: string[] = [];
  const errors: string[] = [];

  return {
    deps: { log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) },
    lines,
    errors,
  };
}

const add = (cwd: string, title: string, url: string, branch?: string) =>
  runAdd(
    {
      preview: {
        title,
        url,
        note: undefined,
        tags: undefined,
        branch,
        file: undefined,
        basedOn: undefined,
        askedFor: undefined,
      },
      json: true,
      cwd,
    },
    collect().deps,
  );

type Tunnel = { [key: string]: JsonValue };

/**
 * A running Leglas, as far as the share command can see one: its health, and
 * the share endpoints answering from one piece of state.
 */
function fakeLeglas(
  cwd: string,
  tunnels: Tunnel[] = [
    { status: "ready", provider: "cloudflared", url: "https://abc.trycloudflare.com" },
  ],
) {
  const posted: { path: string; body: JsonValue }[] = [];
  let share: { [key: string]: JsonValue } | null = null;
  let reads = 0;
  let refusal: string | null = null;

  const statusFor = (body: { [key: string]: JsonValue }) => {
    const tunnel = tunnels[Math.min(reads, tunnels.length - 1)] ?? { status: "none" };
    const url = tunnel.status === "ready" ? `${String(tunnel.url)}/leglas/join/token` : null;

    return {
      id: "share-1",
      scope: body.scope ?? "rail",
      titles: body.titles ?? [],
      reach: body.reach ?? "open",
      tunnel,
      grants: [
        {
          id: "grant-1",
          name: "",
          url,
          localUrl: "http://127.0.0.1:50123/leglas/join/token",
          viewers: 0,
          createdAt: 0,
          expiresAt: Date.UTC(2026, 8, 22, 18, 40),
        },
      ],
    };
  };

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (url.pathname === "/leglas/api/health") return Response.json({ cwd, reachable: true });

    if (url.pathname === "/leglas/api/share" && method === "GET") {
      if (share !== null) {
        reads += 1;
        share = { ...share, ...statusFor(share) };
      }

      return Response.json({ share, tunnels: ["cloudflared"] });
    }

    const body: JsonValue = init?.body === undefined ? null : JSON.parse(String(init.body));
    posted.push({ path: url.pathname, body });

    if (url.pathname === "/leglas/api/share" && method === "POST") {
      if (refusal !== null) return Response.json({ ok: false, error: refusal }, { status: 400 });

      if (share !== null) {
        return Response.json(
          { ok: false, error: "Stop the current share first." },
          { status: 409 },
        );
      }

      share = statusFor(isJsonObject(body) ? body : {});

      return Response.json({ ok: true, share });
    }

    if (url.pathname === "/leglas/api/share/stop") {
      share = null;

      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetcher,
    posted,
    refuse: (error: string) => {
      refusal = error;
    },
    running: (body: { [key: string]: JsonValue }) => {
      share = statusFor(body);
    },
  };
}

const options = (cwd: string, extra: Partial<ShareOptions> = {}): ShareOptions => ({
  titles: [],
  reach: "open",
  tunnel: null,
  stop: false,
  port: 4321,
  json: true,
  cwd,
  ...extra,
});

const instantly = async () => {};

const last = (lines: string[]): { [key: string]: JsonValue } => JSON.parse(lines.at(-1) ?? "{}");

describe("runShare", () => {
  test("shares the rail by default, leaving out what cannot go, and waits for the link", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    await add(cwd, "Dusk", "/?v=dusk");
    await add(cwd, "Warm red", "/", "warm-red");

    const leglas = fakeLeglas(cwd, [
      { status: "starting", provider: "cloudflared" },
      { status: "starting", provider: "cloudflared" },
      { status: "ready", provider: "cloudflared", url: "https://abc.trycloudflare.com" },
    ]);

    const { deps, lines } = collect();

    const result = await runShare(options(cwd), { ...deps, fetch: leglas.fetch, sleep: instantly });

    expect(result.exitCode).toBe(0);
    // A project with no config file has the implicit App on its rail too.
    expect(leglas.posted[0]).toEqual({
      path: "/leglas/api/share",
      body: {
        scope: "rail",
        titles: ["App", "Aurora", "Dusk"],
        layout: {
          order: ["App", "Aurora", "Dusk"],
          renames: {},
          collapsedFamilies: [],
          compare: null,
          viewport: null,
        },
        reach: "open",
        routes: [],
      },
    });
    expect(last(lines)).toMatchObject({
      ok: true,
      alreadySharing: false,
      leftOut: ["Warm red"],
      share: {
        scope: "rail",
        titles: ["App", "Aurora", "Dusk"],
        links: [{ url: "https://abc.trycloudflare.com/leglas/join/token" }],
      },
    });
  });

  test("one direction goes alone, two are compared with the second on the right", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v=cool");
    await add(cwd, "Dusk", "/?v=dusk");
    await writeRenames(cwd, { Cool: "Sunrise" });

    const alone = fakeLeglas(cwd);
    // The name the rail shows is the one people say.
    await runShare(options(cwd, { titles: ["Sunrise"] }), {
      ...collect().deps,
      fetch: alone.fetch,
      sleep: instantly,
    });
    expect(alone.posted[0]?.body).toMatchObject({
      scope: "direction",
      titles: ["Cool"],
      layout: { order: ["Cool"], renames: { Cool: "Sunrise" }, compare: null },
    });

    const pair = fakeLeglas(cwd);
    await runShare(options(cwd, { titles: ["Cool", "Dusk"], reach: "listed", tunnel: "ngrok" }), {
      ...collect().deps,
      fetch: pair.fetch,
      sleep: instantly,
    });
    expect(pair.posted[0]?.body).toMatchObject({
      scope: "compare",
      titles: ["Cool", "Dusk"],
      layout: { compare: "Dusk" },
      reach: "listed",
      tunnel: "ngrok",
    });
  });

  test("a share already running is shown rather than started twice", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "direction", titles: ["Aurora"] });
    const { deps, lines } = collect();

    expect(
      (await runShare(options(cwd), { ...deps, fetch: leglas.fetch, sleep: instantly })).exitCode,
    ).toBe(0);
    expect(leglas.posted).toEqual([]);
    expect(last(lines)).toMatchObject({
      ok: true,
      alreadySharing: true,
      share: { titles: ["Aurora"] },
    });

    // Asking for something else while it runs says how to get there.
    const other = collect();

    expect(
      (
        await runShare(options(cwd, { titles: ["Aurora", "Aurora"] }), {
          ...other.deps,
          fetch: leglas.fetch,
          sleep: instantly,
        })
      ).exitCode,
    ).toBe(1);
    expect(String(last(other.lines).error)).toContain("npx leglas share --stop");
  });

  test("--stop ends the share", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    const { deps, lines } = collect();

    expect(
      (await runShare(options(cwd, { stop: true }), { ...deps, fetch: leglas.fetch })).exitCode,
    ).toBe(0);
    expect(leglas.posted.map((entry) => entry.path)).toEqual(["/leglas/api/share/stop"]);
    expect(last(lines)).toEqual({ ok: true, stopped: true });
  });

  test("the server's own refusal is what the person reads", async () => {
    const cwd = scratch();
    await add(cwd, "Warm red", "/", "warm-red");
    const leglas = fakeLeglas(cwd);
    leglas.refuse("Branch directions can't be shared yet: Warm red.");
    const { deps, lines } = collect();

    expect(
      (
        await runShare(options(cwd, { titles: ["Warm red"] }), {
          ...deps,
          fetch: leglas.fetch,
          sleep: instantly,
        })
      ).exitCode,
    ).toBe(1);
    expect(last(lines)).toEqual({
      ok: false,
      error: "Branch directions can't be shared yet: Warm red.",
    });
  });

  test("nothing running here is said plainly", async () => {
    const cwd = scratch();
    const { deps, lines } = collect();

    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    expect((await runShare(options(cwd), { ...deps, fetch: down })).exitCode).toBe(1);
    expect(last(lines)).toEqual({
      ok: false,
      error: "Leglas is not running here. Start it with npx leglas, then try again.",
    });
  });

  test("in a terminal: the link, when it stops working, and how to stop it", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    const { deps, lines } = collect();

    await runShare(options(cwd, { titles: ["Aurora"], json: false }), {
      ...deps,
      fetch: leglas.fetch,
      sleep: instantly,
    });

    const text = lines.join("\n");
    expect(text).toContain("sharing  Aurora");
    expect(text).toContain("link     https://abc.trycloudflare.com/leglas/join/token");
    expect(text).toMatch(/until {4}\d{1,2}:\d{2}/);
    expect(text).toContain("stop     npx leglas share --stop");
  });

  test("without a tunnel program, the local link and what would reach further", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "none" }]);
    const { deps, lines } = collect();

    await runShare(options(cwd, { json: false }), {
      ...deps,
      fetch: leglas.fetch,
      sleep: instantly,
    });

    const text = lines.join("\n");
    expect(text).toContain("local    http://127.0.0.1:50123/leglas/join/token");
    expect(text).toContain("no cloudflared or ngrok on this machine");
  });

  test("a tunnel still starting when the wait runs out says to ask again", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "starting", provider: "cloudflared" }]);
    const { deps, lines } = collect();

    await runShare(options(cwd, { json: false }), {
      ...deps,
      fetch: leglas.fetch,
      sleep: instantly,
    });

    expect(lines.join("\n")).toContain(
      "cloudflared is still starting; run npx leglas share again for the public link",
    );
  });
});
