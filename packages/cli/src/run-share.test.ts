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
 * A running Leglas as the share command sees it: health, and share endpoints
 * over one piece of state.
 */
function fakeLeglas(
  cwd: string,
  tunnels: Tunnel[] = [
    { status: "ready", provider: "cloudflared", url: "https://abc.trycloudflare.com" },
  ],
  installed: string[] = ["cloudflared"],
) {
  const posted: { path: string; body: JsonValue }[] = [];
  let share: { [key: string]: JsonValue } | null = null;
  let reads = 0;
  let refusal: string | null = null;
  let garbled = false;
  let failReads = false;
  let dropCreateReply = false;

  let links = [{ id: "grant-1", name: "", token: "token" }];

  const statusFor = (body: { [key: string]: JsonValue }) => {
    const tunnel = tunnels[Math.min(reads, tunnels.length - 1)] ?? { status: "none" };

    return {
      id: "share-1",
      scope: body.scope ?? "rail",
      titles: body.titles ?? [],
      reach: body.reach ?? "open",
      tunnel,
      grants: links.map((link) => ({
        id: link.id,
        name: link.name,
        url: tunnel.status === "ready" ? `${String(tunnel.url)}/leglas/join/${link.token}` : null,
        localUrl: `http://127.0.0.1:50123/leglas/join/${link.token}`,
        viewers: 0,
        createdAt: 0,
        expiresAt: Date.UTC(2026, 8, 22, 18, 40),
      })),
    };
  };

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    if (url.pathname === "/leglas/api/health") return Response.json({ cwd, reachable: true });

    if (url.pathname === "/leglas/api/share" && method === "GET") {
      if (failReads) return new Response("nope", { status: 500 });

      if (share !== null) {
        reads += 1;
        share = { ...share, ...statusFor(share) };
      }

      return Response.json({ share, tunnels: installed });
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

      // The share exists, and then the connection goes before the answer does.
      if (dropCreateReply) throw new TypeError("socket hang up");

      // A server whose share this version cannot read, as a newer one might be.
      return Response.json({ ok: true, share: garbled ? { kind: "new" } : share });
    }

    if (url.pathname === "/leglas/api/share/stop") {
      share = null;

      return Response.json({ ok: true });
    }

    if (
      url.pathname === "/leglas/api/share/grants/revoke" ||
      url.pathname === "/leglas/api/share/rotate"
    ) {
      if (share === null) {
        return Response.json({ ok: false, error: "Nothing is being shared." }, { status: 404 });
      }

      if (url.pathname.endsWith("/rotate")) {
        links = [{ id: `grant-${links.length + 2}`, name: "", token: "rotated" }];
      } else {
        const id = isJsonObject(body) ? body.id : null;
        const before = links.length;
        links = links.filter((link) => link.id !== id);

        if (links.length === before) {
          return Response.json({ ok: false, error: "No such link." }, { status: 404 });
        }
      }

      share = { ...share, ...statusFor(share) };

      return Response.json({ ok: true, share });
    }

    return new Response("not found", { status: 404 });
  };

  return {
    fetch: fetcher,
    posted,
    refuse: (error: string) => {
      refusal = error;
    },
    garble: () => {
      garbled = true;
    },
    failReadsAfterStart: () => {
      failReads = true;
    },
    sharing: () => share !== null,
    dropCreateReply: () => {
      dropCreateReply = true;
    },
    running: (body: { [key: string]: JsonValue }) => {
      share = statusFor(body);
    },
    /** A second link on the running share, as the panel makes one for a named person. */
    link: (name: string) => {
      links = [...links, { id: `grant-${links.length + 1}`, name, token: `token-${name}` }];
    },
  };
}

const options = (cwd: string, extra: Partial<ShareOptions> = {}): ShareOptions => ({
  titles: [],
  reach: "open",
  tunnel: null,
  stop: false,
  rotate: false,
  revoke: null,
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

  test("a direction is not compared with itself, under either of its names", async () => {
    const cwd = scratch();
    await add(cwd, "Cool", "/?v=cool");
    await writeRenames(cwd, { Cool: "Sunrise" });
    const leglas = fakeLeglas(cwd);
    const { deps, lines } = collect();

    const result = await runShare(options(cwd, { titles: ["Sunrise", "Cool"] }), {
      ...deps,
      fetch: leglas.fetch,
      sleep: instantly,
    });

    expect(result.exitCode).toBe(1);
    expect(last(lines)).toEqual({
      ok: false,
      error: "Both names are Cool. Name two different directions to compare them.",
    });
    expect(leglas.posted).toEqual([]);
  });

  test("a share already running is shown rather than started twice", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    await add(cwd, "Dusk", "/?v=dusk");
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

    // The same name as a different kind of share is something else too.
    const rail = fakeLeglas(cwd);
    rail.running({ scope: "rail", titles: ["Aurora"] });
    const narrower = collect();

    expect(
      (
        await runShare(options(cwd, { titles: ["Aurora"] }), {
          ...narrower.deps,
          fetch: rail.fetch,
          sleep: instantly,
        })
      ).exitCode,
    ).toBe(1);
    expect(String(last(narrower.lines).error)).toContain("already sharing the rail");

    // Asking for something else while it runs says how to get there.
    const other = collect();

    expect(
      (
        await runShare(options(cwd, { titles: ["Aurora", "Dusk"] }), {
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

  test("--revoke ends the one link it names, by its address or its id", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    leglas.link("Sam");
    const byAddress = collect();

    const run = (revoke: string, deps: ReturnType<typeof collect>["deps"]) =>
      runShare(options(cwd, { revoke }), { ...deps, fetch: leglas.fetch, sleep: instantly });

    expect(
      (await run("https://abc.trycloudflare.com/leglas/join/token-Sam", byAddress.deps)).exitCode,
    ).toBe(0);
    expect(last(byAddress.lines)).toMatchObject({
      ok: true,
      revoked: { id: "grant-2", name: "Sam" },
      share: { links: [{ id: "grant-1" }] },
    });

    const byId = collect();

    expect((await run("grant-1", byId.deps)).exitCode).toBe(0);
    expect(last(byId.lines)).toMatchObject({ ok: true, share: { links: [] } });
    expect(leglas.posted.map((entry) => entry.body)).toEqual([
      { id: "grant-2" },
      { id: "grant-1" },
    ]);
  });

  test("--revoke refuses a link the share doesn't have, and ends nothing", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    const { deps, lines } = collect();

    const outcome = await runShare(
      options(cwd, { revoke: "https://elsewhere.example/leglas/join/x" }),
      {
        ...deps,
        fetch: leglas.fetch,
        sleep: instantly,
      },
    );

    expect(outcome.exitCode).toBe(1);
    expect(String(last(lines).error)).toContain("npx leglas share lists them");
    expect(leglas.posted).toEqual([]);
  });

  test("--rotate ends every link and hands back the new one", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    leglas.link("Sam");
    const { deps, lines } = collect();

    expect(
      (
        await runShare(options(cwd, { rotate: true }), {
          ...deps,
          fetch: leglas.fetch,
          sleep: instantly,
        })
      ).exitCode,
    ).toBe(0);
    expect(leglas.posted.map((entry) => entry.path)).toEqual(["/leglas/api/share/rotate"]);
    expect(last(lines)).toMatchObject({
      ok: true,
      rotated: true,
      share: { links: [{ url: "https://abc.trycloudflare.com/leglas/join/rotated" }] },
    });
  });

  test("--rotate and --revoke with nothing shared say so", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);

    for (const extra of [{ rotate: true }, { revoke: "grant-1" }]) {
      const { deps, lines } = collect();

      const outcome = await runShare(options(cwd, extra), {
        ...deps,
        fetch: leglas.fetch,
        sleep: instantly,
      });

      expect(outcome.exitCode).toBe(1);
      expect(String(last(lines).error)).toContain("Nothing is being shared");
    }
  });

  test("a share it cannot follow is stopped, not left open behind an error", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    leglas.garble();
    const { deps, lines } = collect();

    expect(
      (await runShare(options(cwd), { ...deps, fetch: leglas.fetch, sleep: instantly })).exitCode,
    ).toBe(1);
    expect(leglas.sharing()).toBe(false);
    expect(String(last(lines).error)).toBe(
      "Leglas started a share this version of the command cannot read. The share it started is stopped.",
    );
  });

  test("losing the share while its tunnel starts stops it too", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "starting", provider: "cloudflared" }]);
    const { deps, lines } = collect();

    const sleep = async () => leglas.failReadsAfterStart();

    expect((await runShare(options(cwd), { ...deps, fetch: leglas.fetch, sleep })).exitCode).toBe(
      1,
    );
    expect(leglas.sharing()).toBe(false);
    expect(String(last(lines).error)).toContain("The share it started is stopped.");
  });

  test("a start whose answer was lost is treated as a share that may exist", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    leglas.dropCreateReply();
    const { deps, lines } = collect();

    expect(
      (await runShare(options(cwd), { ...deps, fetch: leglas.fetch, sleep: instantly })).exitCode,
    ).toBe(1);
    expect(leglas.sharing()).toBe(false);
    expect(String(last(lines).error)).toBe(
      "Leglas stopped answering while the share was starting. Anything it started is stopped.",
    );
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
    // A link lasts a day, so its end names the day as well as the time.
    expect(text).toMatch(/until {4}[A-Z][a-z]{2} \d{1,2}:\d{2}/);
    expect(text).toContain("stop     npx leglas share --stop");
  });

  test("without a tunnel program, the local link and what would reach further", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "none" }], []);
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

  test("choosing no tunnel is not the same as having none", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "none" }], ["cloudflared"]);
    const { deps, lines } = collect();

    await runShare(options(cwd, { json: false, tunnel: "none" }), {
      ...deps,
      fetch: leglas.fetch,
      sleep: instantly,
    });

    expect(lines.join("\n")).toContain(
      "tunnel   none, as asked; the link works on this machine, or through a tunnel you run yourself",
    );
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
