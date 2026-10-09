import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { writeRenames } from "@leglas/server";

import { isJsonObject, type JsonValue } from "./json.js";
import { runShare, type ShareOptions } from "./run-share.js";
import { addLocal } from "./test-helpers.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "leglas-share-"));
}

const add = (cwd: string, title: string, url: string, ...flags: string[]) =>
  addLocal(cwd, "--title", title, "--url", url, ...flags);

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

const instantly = async () => {};

/** `leglas share --port 4321 --json` against that Leglas, unless the extra options say otherwise. */
async function share(
  cwd: string,
  fetch: typeof globalThis.fetch,
  extra: Partial<ShareOptions> = {},
  sleep = instantly,
) {
  const lines: string[] = [];
  const errors: string[] = [];

  const { exitCode } = await runShare(
    {
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
    },
    { log: (line) => lines.push(line), error: (line) => errors.push(line), fetch, sleep },
  );

  return {
    exitCode,
    /** The envelope, under --json. */
    get last(): { [key: string]: JsonValue } {
      return JSON.parse(lines.at(-1) ?? "{}");
    },
    text: lines.join("\n"),
  };
}

describe("runShare", () => {
  test("shares the rail by default, leaving out what cannot go, and waits for the link", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    await add(cwd, "Dusk", "/?v=dusk");
    await add(cwd, "Warm red", "/", "--branch", "warm-red");

    const leglas = fakeLeglas(cwd, [
      { status: "starting", provider: "cloudflared" },
      { status: "starting", provider: "cloudflared" },
      { status: "ready", provider: "cloudflared", url: "https://abc.trycloudflare.com" },
    ]);

    const { exitCode, last } = await share(cwd, leglas.fetch);

    expect(exitCode).toBe(0);
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
    expect(last).toMatchObject({
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
    await share(cwd, alone.fetch, { titles: ["Sunrise"] });
    expect(alone.posted[0]?.body).toMatchObject({
      scope: "direction",
      titles: ["Cool"],
      layout: { order: ["Cool"], renames: { Cool: "Sunrise" }, compare: null },
    });

    const pair = fakeLeglas(cwd);
    await share(cwd, pair.fetch, { titles: ["Cool", "Dusk"], reach: "listed", tunnel: "ngrok" });
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

    const { exitCode, last } = await share(cwd, leglas.fetch, { titles: ["Sunrise", "Cool"] });

    expect(exitCode).toBe(1);
    expect(last).toEqual({
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

    const shown = await share(cwd, leglas.fetch);

    expect(shown.exitCode).toBe(0);
    expect(leglas.posted).toEqual([]);
    expect(shown.last).toMatchObject({
      ok: true,
      alreadySharing: true,
      share: { titles: ["Aurora"] },
    });

    // The same name as a different kind of share is something else too.
    const rail = fakeLeglas(cwd);
    rail.running({ scope: "rail", titles: ["Aurora"] });
    const narrower = await share(cwd, rail.fetch, { titles: ["Aurora"] });

    expect(narrower.exitCode).toBe(1);
    expect(String(narrower.last.error)).toContain("already sharing the rail");

    // Asking for something else while it runs says how to get there.
    const other = await share(cwd, leglas.fetch, { titles: ["Aurora", "Dusk"] });

    expect(other.exitCode).toBe(1);
    expect(String(other.last.error)).toContain("npx leglas share --stop");
  });

  test("--stop ends the share", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });

    const { exitCode, last } = await share(cwd, leglas.fetch, { stop: true });

    expect(exitCode).toBe(0);
    expect(leglas.posted.map((entry) => entry.path)).toEqual(["/leglas/api/share/stop"]);
    expect(last).toEqual({ ok: true, stopped: true });
  });

  test("--revoke ends the one link it names, by its address or its id", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    leglas.link("Sam");

    const byAddress = await share(cwd, leglas.fetch, {
      revoke: "https://abc.trycloudflare.com/leglas/join/token-Sam",
    });

    expect(byAddress.exitCode).toBe(0);
    expect(byAddress.last).toMatchObject({
      ok: true,
      revoked: { id: "grant-2", name: "Sam" },
      share: { links: [{ id: "grant-1" }] },
    });

    const byId = await share(cwd, leglas.fetch, { revoke: "grant-1" });

    expect(byId.exitCode).toBe(0);
    expect(byId.last).toMatchObject({ ok: true, share: { links: [] } });
    expect(leglas.posted.map((entry) => entry.body)).toEqual([
      { id: "grant-2" },
      { id: "grant-1" },
    ]);
  });

  test("--revoke of the last live link says how to get a new one", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });

    const { text } = await share(cwd, leglas.fetch, { revoke: "grant-1", json: false });

    expect(text).toContain("no link is live; npx leglas share --rotate starts one");
  });

  test("--revoke refuses a link the share doesn't have, and ends nothing", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });

    const { exitCode, last } = await share(cwd, leglas.fetch, {
      revoke: "https://elsewhere.example/leglas/join/x",
    });

    expect(exitCode).toBe(1);
    expect(String(last.error)).toContain("npx leglas share lists them");
    expect(leglas.posted).toEqual([]);
  });

  test("--rotate ends every link and hands back the new one", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);
    leglas.running({ scope: "rail", titles: [] });
    leglas.link("Sam");

    const { exitCode, last } = await share(cwd, leglas.fetch, { rotate: true });

    expect(exitCode).toBe(0);
    expect(leglas.posted.map((entry) => entry.path)).toEqual(["/leglas/api/share/rotate"]);
    expect(last).toMatchObject({
      ok: true,
      rotated: true,
      share: { links: [{ url: "https://abc.trycloudflare.com/leglas/join/rotated" }] },
    });
  });

  test("--rotate and --revoke with nothing shared say so", async () => {
    const cwd = scratch();
    const leglas = fakeLeglas(cwd);

    for (const extra of [{ rotate: true }, { revoke: "grant-1" }]) {
      const { exitCode, last } = await share(cwd, leglas.fetch, extra);

      expect(exitCode).toBe(1);
      expect(String(last.error)).toContain("Nothing is being shared");
    }
  });

  test("a share it cannot follow is stopped, not left open behind an error", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    leglas.garble();

    const { exitCode, last } = await share(cwd, leglas.fetch);

    expect(exitCode).toBe(1);
    expect(leglas.sharing()).toBe(false);
    expect(String(last.error)).toBe(
      "Leglas started a share this version of the command cannot read. The share it started is stopped.",
    );
  });

  test("losing the share while its tunnel starts stops it too", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "starting", provider: "cloudflared" }]);

    const { exitCode, last } = await share(cwd, leglas.fetch, {}, async () =>
      leglas.failReadsAfterStart(),
    );

    expect(exitCode).toBe(1);
    expect(leglas.sharing()).toBe(false);
    expect(String(last.error)).toContain("The share it started is stopped.");
  });

  test("a start whose answer was lost is treated as a share that may exist", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd);
    leglas.dropCreateReply();

    const { exitCode, last } = await share(cwd, leglas.fetch);

    expect(exitCode).toBe(1);
    expect(leglas.sharing()).toBe(false);
    expect(String(last.error)).toBe(
      "Leglas stopped answering while the share was starting. Anything it started is stopped.",
    );
  });

  test("the server's own refusal is what the person reads", async () => {
    const cwd = scratch();
    await add(cwd, "Warm red", "/", "--branch", "warm-red");
    const leglas = fakeLeglas(cwd);
    leglas.refuse("Branch directions can't be shared yet: Warm red.");

    const { exitCode, last } = await share(cwd, leglas.fetch, { titles: ["Warm red"] });

    expect(exitCode).toBe(1);
    expect(last).toEqual({
      ok: false,
      error: "Branch directions can't be shared yet: Warm red.",
    });
  });

  test("nothing running here is said plainly", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const { exitCode, last } = await share(scratch(), down);

    expect(exitCode).toBe(1);
    expect(last).toEqual({
      ok: false,
      error: "Leglas is not running here. Start it with npx leglas, then try again.",
    });
  });

  test("in a terminal: the link, when it stops working, and how to stop it", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");

    const { text } = await share(cwd, fakeLeglas(cwd).fetch, { titles: ["Aurora"], json: false });

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

    const { text } = await share(cwd, leglas.fetch, { json: false });

    expect(text).toContain("local    http://127.0.0.1:50123/leglas/join/token");
    expect(text).toContain("no cloudflared or ngrok on this machine");
  });

  test("choosing no tunnel is not the same as having none", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "none" }], ["cloudflared"]);

    const { text } = await share(cwd, leglas.fetch, { json: false, tunnel: "none" });

    expect(text).toContain(
      "tunnel   none, as asked; the link works on this machine, or through a tunnel you run yourself",
    );
  });

  test("a tunnel still starting when the wait runs out says to ask again", async () => {
    const cwd = scratch();
    await add(cwd, "Aurora", "/?v=aurora");
    const leglas = fakeLeglas(cwd, [{ status: "starting", provider: "cloudflared" }]);

    const { text } = await share(cwd, leglas.fetch, { json: false });

    expect(text).toContain(
      "cloudflared is still starting; run npx leglas share again for the public link",
    );
  });
});
