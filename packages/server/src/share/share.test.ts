import { required } from "../test-helpers.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Preview } from "../config/config.js";
import { createLiveHub } from "../live.js";
import {
  createShareManager,
  isDevControlRequest,
  isHiddenPath,
  routeAllowed,
  VIEWER_CONCURRENCY,
  VIEWER_QUEUE,
  type ShareLayout,
} from "./share.js";

import { type JsonRecord, isJsonRecord } from "../json.js";

const previews: Preview[] = [
  { title: "Current", url: "/", note: undefined, tags: [] },
  { title: "Aurora", url: "/aurora", note: undefined, tags: [] },
];

const layout: ShareLayout = {
  order: ["Current", "Aurora"],
  renames: { Aurora: "Afterglow" },
  collapsedFamilies: [],
  compare: null,
  viewport: 390,
};

/**
 * One request on its own socket. `fetch` pools connections, so it can't show
 * how many requests are at the server at once; `sent` resolves when this one is
 * written. It's also the only way to send a path with `..` in it, since `fetch`
 * resolves the URL first.
 */
function raw(port: number, path: string, cookie: string) {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path,
    headers: { cookie, connection: "keep-alive" },
  });

  const status = new Promise<number | null>((resolve) => {
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? null);
    });
    request.on("error", () => resolve(null));
  });

  const sent = new Promise<void>((resolve) => request.once("finish", () => resolve()));
  request.end();

  return { status, sent, stop: () => request.destroy() };
}

const managers: Array<ReturnType<typeof createShareManager>> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

function managerFor(
  current: Preview[] = previews,
  request: (res: ServerResponse, req: IncomingMessage) => void = (res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("passed gate");
  },
  /** Held open to widen the window between asking to share and holding a port. */
  beforePreviews: () => Promise<void> = async () => {},
  /** Both clocks, so a deadline can be reached without waiting for one. */
  clocks: { now?: () => number; nowMono?: () => bigint; deadlineMs?: number } = {},
) {
  const live = createLiveHub();
  const nudge = vi.spyOn(live, "nudge");

  const options: Parameters<typeof createShareManager>[0] = {
    live,
    previews: async () => {
      await beforePreviews();

      return current;
    },
    previewsForConfig: (entries) => entries.map((entry) => ({ ...entry })),
    viewerConfig: {
      project: "test-project",
      devServer: "http://127.0.0.1:3000",
      scanPreviews: true,
    },
    request: (req, res) => request(res, req),
    upgrade: (_req, socket) => {
      socket.destroy();

      return false;
    },
    detectTunnels: async () => [],
  };

  if (clocks.now !== undefined) options.now = clocks.now;

  if (clocks.nowMono !== undefined) options.nowMono = clocks.nowMono;

  if (clocks.deadlineMs !== undefined) options.viewerDeadlineMs = clocks.deadlineMs;
  const manager = createShareManager(options);

  managers.push(manager);

  return { live, manager, nudge };
}

describe("createShareManager", () => {
  test("binds a second listener, issues an entry URL and nudges share", async () => {
    const { manager, nudge } = managerFor();

    const result = await manager.create({
      scope: "direction",
      titles: ["Current"],
      layout,
    });

    expect(result.ok).toBe(true);

    if (!result.ok) return;
    expect(result.share.sharePort).toBeGreaterThan(0);
    expect(result.share.grants[0].localUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${result.share.sharePort}/leglas/s/[A-Za-z0-9_-]{32}$`),
    );
    expect(result.share.tunnel).toEqual({ status: "none" });
    expect(result.share.grants[0].url).toBeNull();
    expect(result.share.grants[0].viewers).toBe(0);
    expect(result.share.grants).toHaveLength(1);
    expect(nudge).toHaveBeenCalledWith("share");
  });

  test("sets the cookie at entry and refuses wrong or missing credentials", async () => {
    const { manager } = managerFor();

    const created = await manager.create({
      scope: "direction",
      titles: ["Current"],
      layout,
    });

    if (!created.ok) throw new Error(created.error);

    const entry = await fetch(created.share.grants[0].localUrl, {
      redirect: "manual",
      headers: { "x-forwarded-proto": "https" },
    });

    expect(entry.status).toBe(302);
    expect(entry.headers.get("location")).toBe("/leglas/");
    expect(entry.headers.get("set-cookie")).toMatch(
      /^leglas-share=[A-Za-z0-9_-]{32}; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
    const cookie = entry.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const allowed = await fetch(`http://127.0.0.1:${created.share.sharePort}/pricing`, {
      headers: { cookie },
    });

    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("passed gate");

    const missing = await fetch(`http://127.0.0.1:${created.share.sharePort}/pricing`);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ ok: false, error: "This link isn't active." });

    const wrong = await fetch(`http://127.0.0.1:${created.share.sharePort}/leglas/s/wrong`, {
      redirect: "manual",
    });

    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ ok: false, error: "This link isn't active." });

    const html = await fetch(`http://127.0.0.1:${created.share.sharePort}/pricing`, {
      headers: { accept: "text/html" },
    });

    expect(html.status).toBe(403);
    expect(await html.text()).toContain("This Leglas link isn't active");
  });

  test("refuses every viewer mutation before the shared handler sees it", async () => {
    const request = vi.fn((res: ServerResponse) => res.end("should not run"));
    const { manager } = managerFor(previews, request);

    const created = await manager.create({
      scope: "direction",
      titles: ["Current"],
      layout,
    });

    if (!created.ok) throw new Error(created.error);
    const entry = await fetch(created.share.grants[0].localUrl, { redirect: "manual" });
    const cookie = entry.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const response = await fetch(`http://127.0.0.1:${created.share.sharePort}/leglas/api/watch`, {
      method: "POST",
      headers: { cookie },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Viewers can look, not change what runs.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("gives a viewer config to a live link and nothing to a stranger", async () => {
    const { manager } = managerFor();

    const created = await manager.create({
      scope: "rail",
      titles: ["Aurora"],
      layout,
      tunnel: "none",
    });

    if (!created.ok) throw new Error(created.error);
    const id = created.share.grants[0].id;
    expect(await manager.viewerConfig(id)).not.toBeNull();
    // Revoked after admission but before the config read: the read checks the
    // link, not the share.
    manager.revokeGrant({ id });
    expect(await manager.viewerConfig(id)).toBeNull();
    expect(await manager.viewerConfig("not-a-grant")).toBeNull();
  });

  test("builds viewer config from shared titles in config order", async () => {
    const { manager } = managerFor();
    const compareLayout = { ...layout, compare: "Current" };

    const created = await manager.create({
      scope: "compare",
      titles: ["Aurora", "Current"],
      layout: compareLayout,
    });

    if (!created.ok) throw new Error(created.error);

    const config = required(await manager.viewerConfig(required(created.share.grants[0]).id));

    expect(
      config.previews.map((preview) => (isJsonRecord(preview) ? preview.title : undefined)),
    ).toEqual(["Current", "Aurora"]);
    expect(config.errors).toEqual([]);
    expect(config.warnings).toEqual([]);
    expect(config.viewer).toEqual({ scope: "compare", layout: compareLayout });
  });

  test("rejects branch-backed and unknown directions before binding", async () => {
    const branch: Preview = {
      title: "Branch",
      url: "/branch",
      note: undefined,
      tags: [],
      branch: "feature/branch",
    };

    const { manager } = managerFor([...previews, branch]);

    const branchResult = await manager.create({
      scope: "direction",
      titles: ["Branch"],
      layout,
    });

    expect(branchResult).toEqual({
      ok: false,
      status: 400,
      error: "Branch directions can't be shared yet: Branch.",
    });

    const unknown = await manager.create({
      scope: "direction",
      titles: ["Missing"],
      layout,
    });

    expect(unknown).toEqual({
      ok: false,
      status: 400,
      error: "Directions are not available to share: Missing.",
    });
    expect(manager.status()).toBeNull();
  });
});

describe("stopping while a share is still starting", () => {
  test("the stop wins, and no listener is left behind", async () => {
    // A create reads previews, finds tunnel programs and binds a port before
    // publishing the share. Held at the first await so a stop lands in that
    // window every time.
    let release = (): void => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { manager } = managerFor(previews, undefined, () => held);

    const creating = manager.create({
      scope: "rail",
      titles: ["Aurora"],
      layout,
      tunnel: "none",
    });

    await manager.stop();
    release();
    const result = await creating;

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: 409 });
    expect(manager.status()).toBeNull();
  });
});

describe("many links to one share", () => {
  const start = async (clocks?: { now?: () => number; nowMono?: () => bigint }) => {
    const { manager, live } = managerFor(previews, undefined, undefined, clocks ?? {});

    const created = await manager.create({
      scope: "rail",
      titles: ["Current", "Aurora"],
      layout,
      tunnel: "none",
    });

    if (!created.ok) throw new Error(created.error);

    return { manager, live, share: created.share };
  };

  const enter = async (url: string): Promise<Response> => fetch(url, { redirect: "manual" });

  test("a share opens with one link, and every later one is its own", async () => {
    const { manager, share } = await start();
    expect(share.grants).toHaveLength(1);
    expect(share.grants[0].name).toBe("");

    const second = manager.createGrant({ name: "  Ana  " });

    if (!second.ok) throw new Error(second.error);
    expect(second.share.grants).toHaveLength(2);
    expect(second.share.grants[1].name).toBe("Ana");
    // Two links, two tokens: one cannot be read off the other.
    const [a, b] = second.share.grants;
    expect(a.localUrl).not.toBe(b.localUrl);
    expect((await enter(a.localUrl)).status).toBe(302);
    expect((await enter(b.localUrl)).status).toBe(302);
  });

  test("refuses a seventeenth link rather than growing without end", async () => {
    const { manager } = await start();

    for (let made = 1; made < 16; made += 1) {
      expect(manager.createGrant({}).ok).toBe(true);
    }

    const past = manager.createGrant({});
    expect(past.ok).toBe(false);

    if (past.ok) return;
    expect(past.status).toBe(409);
    expect(past.error).toMatch(/Revoke one/);
  });

  test("revoking one link leaves the others, and says which happened", async () => {
    const { manager, share: _share } = await start();
    const second = manager.createGrant({ name: "Ana" });

    if (!second.ok) throw new Error(second.error);
    const [kept, cut] = second.share.grants;

    const revoked = manager.revokeGrant({ id: cut.id });
    expect(revoked.ok).toBe(true);

    if (!revoked.ok) return;
    expect(revoked.share.grants).toHaveLength(1);
    expect(revoked.share.grants[0].id).toBe(kept.id);

    expect((await enter(kept.localUrl)).status).toBe(302);
    // Turned off, lapsed and never a link are three different answers.
    const gone = await enter(cut.localUrl);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toMatch(/turned off/);

    const stranger = await enter(
      kept.localUrl.replace(/\/s\/.+$/, "/s/notatokenatallnotatokenatall12"),
    );

    expect(stranger.status).toBe(403);
  });

  test("a link past its deadline is expired, not merely unknown", async () => {
    let at = 1_000_000;

    const { manager, share } = await start({
      now: () => at,
      nowMono: () => BigInt(at) * 1_000_000n,
    });

    const link = share.grants[0];
    expect((await enter(link.localUrl)).status).toBe(302);

    at += 24 * 60 * 60 * 1000 + 1;
    const lapsed = await enter(link.localUrl);
    expect(lapsed.status).toBe(410);
    expect(await lapsed.text()).toMatch(/expired/);
    // And it leaves the share instead of lingering as a live row.
    expect(manager.status()?.grants ?? []).toHaveLength(0);
  });

  test("the monotonic clock expires a link whose wall clock went backwards", async () => {
    let wall = 5_000_000;
    let mono = 5_000_000n * 1_000_000n;
    const { manager, share } = await start({ now: () => wall, nowMono: () => mono });
    const link = share.grants[0];

    // A correction drags the wall clock back a day while real time moves on.
    wall -= 12 * 60 * 60 * 1000;
    mono += BigInt(25 * 60 * 60 * 1000) * 1_000_000n;
    const lapsed = await enter(link.localUrl);
    expect(lapsed.status).toBe(410);
    expect(manager.status()?.grants ?? []).toHaveLength(0);
  });

  test("extend moves a live link's deadline and will not raise a dead one", async () => {
    let at = 2_000_000;

    const { manager, share } = await start({
      now: () => at,
      nowMono: () => BigInt(at) * 1_000_000n,
    });

    const link = share.grants[0];
    const first = link.expiresAt;

    at += 60 * 60 * 1000;
    const extended = manager.extendGrant({ id: link.id });

    if (!extended.ok) throw new Error(extended.error);
    expect(extended.share.grants[0].expiresAt).toBeGreaterThan(first);
    // An absolute time, not an addition, so clicking twice can't walk it into
    // next week.
    expect(extended.share.grants[0].expiresAt).toBe(at + 24 * 60 * 60 * 1000);

    manager.revokeGrant({ id: link.id });
    const raising = manager.extendGrant({ id: link.id });
    expect(raising.ok).toBe(false);

    if (raising.ok) return;
    expect(raising.status).toBe(404);
    expect(raising.error).toMatch(/Make a new one/);
  });

  test("revoking a link drops the sockets and the requests it was holding", async () => {
    // A stream that never finishes: letting in-flight responses finish would
    // leave the viewer receiving after the cut.
    type HeldResponse = { response: ServerResponse | null };

    const held: HeldResponse = { response: null };

    const { manager } = managerFor(previews, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      held.response = res;
    });

    const created = await manager.create({
      scope: "rail",
      titles: ["Current"],
      layout,
      tunnel: "none",
    });

    if (!created.ok) throw new Error(created.error);
    const link = created.share.grants[0];
    const entry = await fetch(link.localUrl, { redirect: "manual" });
    const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const origin = link.localUrl.replace(/\/leglas\/s\/.+$/, "");
    const streaming = fetch(`${origin}/stream`, { headers: { cookie } });
    await vi.waitFor(() => expect(held.response).not.toBeNull());

    manager.revokeGrant({ id: link.id });
    await expect(streaming.then((r) => r.text())).rejects.toThrow();
    expect(required(held.response).destroyed).toBe(true);
  });

  test("rotate ends every link and issues one nobody has seen", async () => {
    const { manager, share: _share } = await start();
    manager.createGrant({ name: "Ana" });
    const before = manager.status()?.grants.map((grant) => grant.localUrl) ?? [];
    expect(before).toHaveLength(2);

    const rotated = await manager.rotate();

    if (!rotated.ok) throw new Error(rotated.error);
    expect(rotated.share.grants).toHaveLength(1);

    for (const url of before) {
      expect(rotated.share.grants[0].localUrl).not.toBe(url);
      const gone = await enter(url);
      expect(gone.status).toBe(410);
    }

    expect((await enter(rotated.share.grants[0].localUrl)).status).toBe(302);
  });
});

describe("how far a viewer reaches", () => {
  const startWith = async (extra: JsonRecord) => {
    const { manager } = managerFor(previews, (res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("the app");
    });

    const created = await manager.create({
      scope: "rail",
      titles: ["Current"],
      layout,
      tunnel: "none",
      ...extra,
    });

    if (!created.ok) throw new Error(created.error);
    const entry = await fetch(created.share.grants[0].localUrl, { redirect: "manual" });
    const cookie = (entry.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const origin = created.share.grants[0].localUrl.replace(/\/leglas\/s\/.+$/, "");
    const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });

    return { manager, get, share: created.share, cookie, port: created.share.sharePort };
  };

  test("open reach serves the app, as it did before there was a list", async () => {
    const { get, share } = await startWith({});
    expect(share.reach).toBe("open");
    expect((await get("/anything/at/all")).status).toBe(200);
  });

  test("listed reach serves the list and refuses the rest, remembering what it refused", async () => {
    const { get, manager } = await startWith({
      reach: "listed",
      routes: ["/src/main.tsx", "/node_modules/.vite/deps/"],
    });

    // The shared direction is always in; a share that refuses its own page
    // isn't one.
    expect((await get("/")).status).toBe(200);
    expect((await get("/src/main.tsx")).status).toBe(200);
    // A trailing slash stands for everything beneath it.
    expect((await get("/node_modules/.vite/deps/react.js")).status).toBe(200);

    const turned = await get("/api/internal/keys");
    expect(turned.status).toBe(403);
    expect(await turned.json()).toEqual({ ok: false, error: "Not shared." });
    // The interface itself is never subject to the list.
    expect((await get("/leglas/api/health")).status).toBe(200);

    expect(manager.status()?.refused).toEqual(["/api/internal/keys"]);
  });

  test("a refusal is remembered as what it named, not as it was spelled", async () => {
    // The refusal list is what the sharer clicks Allow on. A raw spelling there
    // is viewer-chosen and no settled path would match it, so the allow would
    // do nothing; recording the settled path makes it work and stops forty
    // spellings of one path pushing real refusals out.
    const { manager, port, cookie } = await startWith({ reach: "listed", routes: [] });

    for (const path of ["/assets/../secrets/x", "/%73ecrets/x", "//secrets//x", "/secrets/x"]) {
      expect(await raw(port, path, cookie).status).toBe(403);
    }

    expect(manager.status()?.refused).toEqual(["/secrets/x"]);

    const allowed = manager.allowRoute({ path: "/secrets/x" });
    expect(allowed.ok).toBe(true);
    expect(manager.status()?.refused).toEqual([]);
    expect(await raw(port, "/assets/../secrets/x", cookie).status).toBe(200);
  });

  test("allowing a path that ends in a slash allows that path, not everything beneath it", async () => {
    // The list reads a trailing slash as a subtree. A refused directory index
    // settles as "/foo/", so Allow on it used to grant the subtree silently.
    // The intent now travels with the request.
    const { manager, port, cookie } = await startWith({ reach: "listed", routes: [] });
    expect(await raw(port, "/foo/", cookie).status).toBe(403);
    expect(manager.status()?.refused).toEqual(["/foo/"]);

    expect(manager.allowRoute({ path: "/foo/" }).ok).toBe(true);
    expect(await raw(port, "/foo/", cookie).status).toBe(200);
    expect(await raw(port, "/foo", cookie).status).toBe(200);
    expect(await raw(port, "/foo/bar.js", cookie).status).toBe(403);

    // The folder button says so, and gets the subtree.
    expect(manager.allowRoute({ path: "/foo/", subtree: true }).ok).toBe(true);
    expect(await raw(port, "/foo/bar.js", cookie).status).toBe(200);
    // The root is a page, never a folder over everything.
    expect(manager.allowRoute({ path: "/", subtree: true }).ok).toBe(false);
  });

  test("a folder allowed by one click does not open what is beside it", async () => {
    // "+ folder" is the ordinary way to clear a refusal, so climbing back out
    // of an allowed folder must not carry its permission.
    const { get, port, cookie } = await startWith({ reach: "listed", routes: ["/assets/"] });
    expect((await get("/assets/app.js")).status).toBe(200);

    for (const path of [
      "/assets/../secrets/config.json",
      "/assets/%2e%2e/secrets/config.json",
      "/assets/..%2fsecrets/config.json",
      "/assets/../../etc/hosts",
      "/assets/..\\secrets/config.json",
    ]) {
      expect([path, await raw(port, path, cookie).status]).toEqual([path, 403]);
    }
  });

  test("a path that only canonicalises into the interface is not the interface", async () => {
    // The exemption and the dispatcher must read the path the same way. These
    // settle to "/leglas/x", but the router reads the raw path and proxies them
    // to the dev server, so a settled-only exemption let them skip the list and
    // the ceiling.
    const { port, cookie } = await startWith({ reach: "listed", routes: [] });

    for (const path of ["//leglas/x", "/./leglas/x", "/foo/../leglas/x", "/%2Fleglas/x"]) {
      expect([path, await raw(port, path, cookie).status]).toEqual([path, 403]);
    }

    // Node refuses a request target that doesn't start with a slash, so the
    // backslash spelling never gets here.
    expect(await raw(port, "\\leglas\\x", cookie).status).toBe(400);

    // A path the router reads as its own keeps the exemption. Requiring every
    // spelling errs toward refusing the interface, most likely for an encoded
    // name in a file preview.
    for (const path of [
      "/leglas/api/health",
      "/leglas/api/config",
      "/leglas/assets/index-A1b2C3.js",
      "/leglas/files/abcd1234/some%20file.css",
      "/leglas/files/abcd1234/na%C3%AFve.css",
      "/leglas/files/abcd1234/a+b(1).css",
      "/leglas/api/config?since=1",
      "/leglas",
    ]) {
      expect([path, await raw(port, path, cookie).status]).toEqual([path, 200]);
    }
  });

  test("the interface prefix is not a way around the list", async () => {
    // Everything under /leglas skips the list, since viewers need the
    // interface; a path that only looks like it lives there must not.
    const { get, port, cookie } = await startWith({ reach: "listed", routes: [] });

    for (const path of [
      "/leglas/../secrets/config.json",
      "/leglas/../../etc/hosts",
      "/leglas/%2e%2e/secrets/config.json",
    ]) {
      expect([path, await raw(port, path, cookie).status]).toEqual([path, 403]);
    }

    // And the interface itself still answers.
    expect((await get("/leglas/api/health")).status).toBe(200);
  });

  test("allowing a refused path lets it through and clears it from the list", async () => {
    const { get, manager } = await startWith({ reach: "listed", routes: [] });
    expect((await get("/late/chunk-a.js")).status).toBe(403);
    expect((await get("/late/chunk-b.js")).status).toBe(403);
    expect(manager.status()?.refused).toEqual(["/late/chunk-a.js", "/late/chunk-b.js"]);

    // A directory takes everything under it, as a bundler's asset folder needs,
    // and both refusals go with it.
    const allowed = manager.allowRoute({ path: "/late/", subtree: true });
    expect(allowed.ok).toBe(true);
    expect(manager.status()?.refused).toEqual([]);
    expect((await get("/late/chunk-a.js")).status).toBe(200);
    expect((await get("/late/chunk-c.js")).status).toBe(200);

    expect(manager.allowRoute({ path: "no-slash" }).ok).toBe(false);
  });

  test("the list is read on the settled path, never on the readiest one", async () => {
    const { get } = await startWith({ reach: "listed", routes: ["/assets/app.js"] });
    expect((await get("/assets/app.js")).status).toBe(200);

    // Refusing checks every spelling so any dangerous reading wins; allowing
    // checks one, or the most permissive wins. These resolve inside the folder,
    // so the dev server sees the same request.
    expect(routeAllowed(["/assets/"], "/foo/../assets/app.js")).toBe(true);
    expect(routeAllowed(["/assets/"], "/assets/./app.js")).toBe(true);
    expect(routeAllowed(["/assets/"], "//assets//app.js")).toBe(true);
    expect(routeAllowed(["/assets/"], "/assets")).toBe(true);

    // And these do not, however much of the route they start with.
    expect(routeAllowed(["/assets/"], "/assets/../secrets/config.json")).toBe(false);
    expect(routeAllowed(["/assets/"], "/assets/%2e%2e/secrets/config.json")).toBe(false);
    expect(routeAllowed(["/assets/app.js"], "/assets/app.js.map")).toBe(false);
    expect(routeAllowed([], "/anything")).toBe(false);

    // Case isn't folded either: the list comes from what the app loaded, and a
    // case it never asked for is offered on the refusal list in one click.
    expect(routeAllowed(["/assets/app.js"], "/ASSETS/APP.JS")).toBe(false);

    // The root is a page, never a prefix over everything beneath it.
    expect(routeAllowed(["/"], "/")).toBe(true);
    expect(routeAllowed(["/"], "/api/keys")).toBe(false);
  });
});

describe("isDevControlRequest", () => {
  test("names the routes that act on the machine, and their subtrees", () => {
    for (const route of [
      "/__open-in-editor",
      "/__open-stack-frame-in-editor",
      "/__get-internal-source",
      "/__inspect",
      "/__inspect/module",
      "/__devtools__/",
      "/__browser_sync__",
      "/webpack-dev-server/index.html",
      "/webpack-dev-server/invalidate",
      "/webpack-dev-server/open-editor",
      "/__web_console",
      "/_ignition/execute-solution",
      "/_profiler/latest",
      "/__debug__/render_panel",
      "/debug/pprof/heap",
      "/actuator/env",
      "/___graphql",
    ]) {
      expect(isDevControlRequest(route)).toBe(true);
    }
  });

  test("takes a tool's whole dev namespace, not a list of its routes", () => {
    // From Next 16.3.1, Nuxt DevTools 4.0.0-alpha.16 and Parcel 2.16.4. The
    // prefix exists for members not listed, including future ones.
    for (const route of [
      "/__nextjs_launch-editor",
      "/__nextjs_original-stack-frame",
      "/__nextjs_original-stack-frames",
      "/__nextjs_source-map",
      "/__nextjs_attach-nodejs-inspector",
      "/__nextjs_error_feedback",
      "/__nextjs_something_added_later",
      "/__nuxt_devtools__",
      "/__nuxt_devtools__/client/index.html",
      "/__parcel_launch_editor",
      "/__parcel_source_map",
      "/__parcel_source_root",
      "/__parcel_code_frame",
    ]) {
      expect(isDevControlRequest(route)).toBe(true);
    }
  });

  test("refuses every spelling the dev server would answer to", () => {
    // Vite 8.2.2 answers the uppercase form from the same middleware, so a
    // case-sensitive list reached the editor launcher. The rest are the same
    // class.
    for (const route of [
      "/__OPEN-IN-EDITOR",
      "/__Open-In-Editor",
      "/__NEXTJS_launch-editor",
      "/__PARCEL_launch_editor",
      "/WEBPACK-DEV-SERVER/open-editor",
      "//__open-in-editor",
      "/./__open-in-editor",
      "/foo/../__open-in-editor",
      "/%5F%5Fopen-in-editor",
      "/%5f%5fOPEN-IN-EDITOR",
      // A backslash is a slash to Node's own URL parsers, so it is one here.
      "/foo\\..\\__open-in-editor",
      "/\\__open-in-editor",
      "/foo%5C..%5C__open-in-editor",
      "/foo\\../__OPEN-IN-EDITOR",
    ]) {
      expect(isDevControlRequest(route)).toBe(true);
    }
  });

  test("a malformed escape is refused rather than throwing", () => {
    expect(() => isDevControlRequest("/%zz")).not.toThrow();
    expect(isDevControlRequest("/%zz")).toBe(false);
    expect(isDevControlRequest("/%E0%A4%A")).toBe(false);
  });

  test("catches the one that hides in the query rather than the path", () => {
    // Werkzeug's debugger hangs off whichever path raised the error, so only
    // the query tells.
    expect(isDevControlRequest("/any/app/route?__debugger__=yes&cmd=resource")).toBe(true);
    expect(isDevControlRequest("/?__debugger__=yes")).toBe(true);
    expect(isDevControlRequest("/?v-hero=table")).toBe(false);
  });

  test("leaves the app alone, including paths that merely start alike", () => {
    for (const route of [
      "/",
      "/?v-hero=table",
      "/__open-in-editor-not-really",
      "/@vite/client",
      "/src/main.tsx",
      "/webpack-dev-server-ui",
      // Asset paths each framework needs to run at all.
      "/_next/static/chunks/main.js",
      "/_nuxt/entry.js",
      "/_app/immutable/start.js",
      "/_astro/index.css",
      "/@ng/component",
      "/sb-manager/runtime.js",
    ]) {
      expect(isDevControlRequest(route)).toBe(false);
    }
  });
});

describe("the ceiling on viewer traffic", () => {
  /** A share with one link, and the cookie a viewer would be holding. */
  async function shareWith(
    request: (res: ServerResponse, req: IncomingMessage) => void,
    clocks: { deadlineMs?: number } = {},
  ) {
    const { manager } = managerFor(previews, request, undefined, clocks);
    const created = await manager.create({ scope: "rail", titles: ["Current"], layout });

    if (!created.ok) throw new Error(created.error);
    const first = created.share.grants[0];

    if (first === undefined) throw new Error("no link");
    const entry = await fetch(first.localUrl, { redirect: "manual" });
    const cookie = entry.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const port = created.share.sharePort;

    return {
      manager,
      share: created.share,
      get: (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${port}${path}`, {
          ...init,
          headers: { cookie, ...init.headers },
        }),
      cookie,
      cookieFor: async (localUrl: string) => {
        const other = await fetch(localUrl, { redirect: "manual" });

        return other.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      },
      port,
    };
  }

  /** Answer everything, including whatever the queue lets in as slots free. */
  async function drain(holding: Array<() => void>, expected: number): Promise<void> {
    let answered = 0;
    const until = Date.now() + 10_000;

    while (answered < expected && Date.now() < until) {
      const next = holding.shift();

      if (next === undefined) await new Promise((resolve) => setTimeout(resolve, 2));
      else {
        next();
        answered += 1;
      }
    }
  }

  test("holds viewer traffic at twelve inside the dev server at once", async () => {
    // Unbounded, a burst queues inside the dev server where nothing here can
    // bound or cancel it, and the sharer's own reload waits behind it.
    let inside = 0;
    let peak = 0;
    let answered = 0;
    const holding: Array<() => void> = [];

    const share = await shareWith((res) => {
      inside += 1;
      peak = Math.max(peak, inside);
      holding.push(() => {
        inside -= 1;
        answered += 1;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });

    const all = Array.from({ length: 40 }, (_, i) => share.get(`/asset-${i}.js`));
    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY));
    // Nothing else gets in until one of those twelve answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(holding.length).toBe(VIEWER_CONCURRENCY);

    while (answered < 40) {
      const next = holding.shift();

      if (next === undefined) await new Promise((resolve) => setTimeout(resolve, 2));
      else next();
    }

    const responses = await Promise.all(all);

    expect(peak).toBe(VIEWER_CONCURRENCY);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  test("lets the interface through while every slot is taken", async () => {
    // A viewer needs the shell, its config and its socket, and none of that is
    // the dev server.
    const holding: Array<() => void> = [];

    const share = await shareWith((res, req) => {
      if ((req.url ?? "").startsWith("/leglas/")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("interface");

        return;
      }

      holding.push(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("app");
      });
    });

    const app = Array.from({ length: 30 }, (_, i) => share.get(`/asset-${i}.js`));
    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY));

    const config = await share.get("/leglas/api/config");
    expect(config.status).toBe(200);
    expect(await config.text()).toBe("interface");

    await drain(holding, 30);
    await Promise.all(app.map((pending) => pending.catch(() => undefined)));
  });

  test("a response that never ends does not keep its slot", async () => {
    // SSE is a GET that stays open; holding the slot until it finished would
    // let twelve streams take every slot for good.
    const open: ServerResponse[] = [];

    const share = await shareWith((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      open.push(res);
    });

    const streams = await Promise.all(
      Array.from({ length: VIEWER_CONCURRENCY * 2 }, (_, i) => share.get(`/events-${i}`)),
    );

    expect(streams.every((response) => response.status === 200)).toBe(true);
    // And an ordinary request still gets through behind all of them.
    const after = await share.get("/still-served");
    expect(after.status).toBe(200);

    for (const response of open) response.end();
    await Promise.all(streams.map((response) => response.body?.cancel()));
  });

  test("gives a quiet link its turn rather than draining a loud one first", async () => {
    const served: string[] = [];
    const holding: Array<() => void> = [];

    const share = await shareWith((res, req) => {
      served.push(req.url ?? "/");
      holding.push(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });

    const second = share.manager.createGrant({ name: "Second" });

    if (!second.ok) throw new Error(second.error);
    const other = second.share.grants.at(-1);

    if (other === undefined) throw new Error("no second link");
    const otherCookie = await share.cookieFor(other.localUrl);

    // The loud link takes every slot and queues eighteen more.
    const loud = Array.from({ length: 30 }, (_, i) => raw(share.port, `/loud-${i}`, share.cookie));
    await Promise.all(loud.map((request) => request.sent));
    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY));

    // Then one request on the other link, behind all eighteen.
    const quiet = raw(share.port, "/quiet", otherCookie);
    await quiet.sent;

    // Frees slots one at a time, paced so the quiet request has landed. In
    // plain arrival order it would wait behind all eighteen; only a turn per
    // link gets it near the front.
    const admitted = served.length;

    for (let i = 0; i < 6 && !served.includes("/quiet"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      holding.shift()?.();
      await vi.waitFor(() => expect(served.length).toBeGreaterThan(admitted + i));
    }

    expect(served).toContain("/quiet");
    expect(served.indexOf("/quiet")).toBeLessThan(VIEWER_CONCURRENCY + 6);

    for (const request of [...loud, quiet]) request.stop();

    while (holding.length > 0) holding.shift()?.();
  });

  test("turns away a link that queues more than it may", async () => {
    const holding: Array<() => void> = [];

    const share = await shareWith((res) => {
      holding.push(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });

    const full = VIEWER_CONCURRENCY + VIEWER_QUEUE;
    const filling: Array<ReturnType<typeof raw>> = [];

    let answered = 0;

    // One at a time: macOS caps the listen backlog at 128, and macOS 27
    // refuses connections past it.
    for (let i = 0; i < full; i += 1) {
      const request = raw(share.port, `/fill-${i}`, share.cookie);
      filling.push(request);
      void request.status.then(() => (answered += 1));
      await request.sent;
    }

    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY));

    const over = raw(share.port, "/one-too-many", share.cookie);
    let wait: ReturnType<typeof setTimeout> | undefined;

    const answer = await Promise.race([
      over.status,
      new Promise<"no answer">((resolve) => {
        wait = setTimeout(() => resolve("no answer"), 5000);
      }),
    ]);

    clearTimeout(wait);
    expect(answer).toBe(503);
    // None of the 140 was refused, so the limit isn't lower either.
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(0);

    for (const request of filling) request.stop();

    while (holding.length > 0) holding.shift()?.();
  });

  test("answers what a revoked link left waiting", async () => {
    const holding: Array<() => void> = [];

    const share = await shareWith((res) => {
      holding.push(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });

    const live = share.manager.status();
    const grantId = live?.grants[0]?.id;

    if (grantId === undefined) throw new Error("no link");

    const pending = Array.from({ length: 20 }, (_, i) => share.get(`/waiting-${i}`));
    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY));
    await new Promise((resolve) => setTimeout(resolve, 20));

    share.manager.revokeGrant({ id: grantId });

    const answers = await Promise.all(pending.map((p) => p.catch(() => null)));
    const shed = answers.filter((response) => response !== null && response.status === 410);
    // The twelve inside were cut off mid-request; the eight waiting are told.
    expect(shed).toHaveLength(20 - VIEWER_CONCURRENCY);
    expect(await shed[0]?.json()).toEqual({
      ok: false,
      error: "This link was turned off.",
    });

    for (const release of holding.splice(0)) release();
  });

  test("sheds a request that waited out its budget", async () => {
    // The budget is one clock over both waits. Twelve requests at a second each
    // against a budget of 1.33s: the first twelve are served, the next twelve
    // get in with too little left, and the rest are refused while waiting.
    //
    // A request is refused only if its budget is spent when a slot frees, and
    // budgets are stamped from the wall clock on arrival. On a loaded runner
    // arrivals spread and the third batch got started and cut off instead, so
    // the stamping clock is held still during the burst. The deadlines are
    // still real timers.
    let arrived = 0;

    const share = await shareWith(
      (res) => {
        arrived += 1;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        }, 1000);
      },
      { deadlineMs: 1300 },
    );

    const frozen = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
    let all: Promise<Response>[];

    try {
      all = Array.from({ length: 40 }, (_, i) => share.get(`/steady-${i}`));
      await vi.waitFor(() => expect(arrived).toBe(VIEWER_CONCURRENCY * 2), { timeout: 10_000 });
    } finally {
      clock.mockRestore();
    }

    const answers = await Promise.all(all.map((pending) => pending.catch(() => null)));
    const shed = answers.filter((response) => response?.status === 503);

    expect(answers.filter((response) => response?.status === 200).length).toBe(VIEWER_CONCURRENCY);
    expect(shed.length).toBeGreaterThan(0);
    expect(await shed[0]?.json()).toEqual({
      ok: false,
      error: "The dev server is busy. Try again.",
    });

    // Everything answered was answered properly, and the share still works.
    for (const response of answers) {
      if (response !== null) expect([200, 503]).toContain(response.status);
    }

    expect((await share.get("/after-the-rush")).status).toBe(200);
  });

  test("takes back the slot when the dev server never answers", async () => {
    // A hung upstream never frees its slot, so the budget covers waiting and
    // running together.
    let started = 0;

    const share = await shareWith(
      () => {
        started += 1;
      },
      { deadlineMs: 60 },
    );

    const stuck = Array.from({ length: VIEWER_CONCURRENCY }, (_, i) => share.get(`/hang-${i}`));
    await vi.waitFor(() => expect(started).toBe(VIEWER_CONCURRENCY));
    // Every slot is held by a request the dev server will never answer.
    await Promise.all(stuck.map((pending) => pending.catch(() => null)));

    // The share works again instead of deadlocking on twelve dead slots.
    const after = share.get("/after-the-hang");
    await vi.waitFor(() => expect(started).toBe(VIEWER_CONCURRENCY + 1));
    await after.catch(() => null);
  });

  test("a viewer who gives up while waiting frees the place they held", async () => {
    const reached: string[] = [];
    const holding: Array<() => void> = [];
    // Twelve fetches at once can take longer than a second on a loaded machine.
    const patience = { timeout: 15_000 };

    const share = await shareWith((res, req) => {
      reached.push(req.url ?? "");
      holding.push(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
    });

    const inside = Array.from({ length: VIEWER_CONCURRENCY }, (_, i) => share.get(`/in-${i}`));
    await vi.waitFor(() => expect(holding.length).toBe(VIEWER_CONCURRENCY), patience);

    const giveUp = new AbortController();
    const abandoned = share.get("/abandoned", { signal: giveUp.signal });
    const following = share.get("/after");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reached).toHaveLength(VIEWER_CONCURRENCY);
    giveUp.abort();
    await abandoned.catch(() => undefined);
    // The share hears the viewer leave in the event loop's next poll. The wait
    // covers a busy loop; the turns after it make sure a poll has run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    holding.shift()?.();
    // The freed slot goes to the request behind it, not to the one that left.
    await vi.waitFor(() => expect(reached).toHaveLength(VIEWER_CONCURRENCY + 1), patience);
    expect(reached.at(-1)).toBe("/after");
    await drain(holding, VIEWER_CONCURRENCY + 1);
    await Promise.all([...inside, following].map((pending) => pending.catch(() => undefined)));
    expect(reached).not.toContain("/abandoned");
  });
});

describe("isHiddenPath", () => {
  test("refuses what a leading dot usually names", () => {
    for (const path of [
      "/.env",
      "/.env.local",
      "/.git/config",
      "/.git/HEAD",
      "/.ssh/id_rsa",
      "/.aws/credentials",
      "/config/.env",
      "/foo/../.env",
      "/%2Eenv",
      "/%2egit/config",
      "/foo\\..\\.env",
      // Climbing back out of node_modules is caught by the normalised form.
      "/node_modules/../.env",
      "/node_modules/../../.ssh/id_rsa",
    ]) {
      expect(isHiddenPath(path)).toBe(true);
    }
  });

  test("a dotfile is hidden wherever it sits, node_modules included", () => {
    // The carve-out is for dot directories a dev server serves from, not a
    // dotfile under one.
    for (const path of [
      "/node_modules/.pnpm/x/node_modules/y/.env",
      "/node_modules/some-package/.env",
      "/node_modules/.vite/deps/.env",
    ]) {
      expect([path, isHiddenPath(path)]).toEqual([path, true]);
    }
  });

  test("leaves the dot directories a dev server serves from alone", () => {
    // Eight of the demo app's twenty-two files live under one of these, so a
    // blanket dot-segment rule would break every Vite app.
    for (const path of [
      "/node_modules/.vite/deps/react.js",
      "/node_modules/.vite/deps/react-dom_client.js",
      "/node_modules/.pnpm/@fontsource-variable+archivo@5.3.0/node_modules/@fontsource-variable/archivo/index.css",
      "/node_modules/.pnpm/vite@8.2.2/node_modules/vite/dist/client/env.mjs",
      "/",
      "/index.html",
      "/src/main.tsx",
      "/assets/hero.jpg",
      "/@vite/client",
      "/file.with.dots.js",
    ]) {
      expect(isHiddenPath(path)).toBe(false);
    }
  });
});
