import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Preview } from "./config.js";
import { createLiveHub } from "./live.js";
import { createShareManager, isDevControlRequest, type ShareLayout } from "./share.js";

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

const managers: Array<ReturnType<typeof createShareManager>> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
});

function managerFor(
  current: Preview[] = previews,
  request: (res: ServerResponse) => void = (res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("passed gate");
  },
  /** Held open to widen the window between asking to share and holding a port. */
  beforePreviews: () => Promise<void> = async () => {},
  /** Both clocks, so a deadline can be reached without waiting for one. */
  clocks: { now?: () => number; nowMono?: () => bigint } = {},
) {
  const live = createLiveHub();
  const nudge = vi.spyOn(live, "nudge");
  const manager = createShareManager({
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
    request: (_req, res) => request(res),
    upgrade: (_req, socket) => {
      socket.destroy();
      return false;
    },
    detectTunnels: async () => [],
    ...(clocks.now === undefined ? {} : { now: clocks.now }),
    ...(clocks.nowMono === undefined ? {} : { nowMono: clocks.nowMono }),
  });
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

    const allowed = await fetch(
      `http://127.0.0.1:${created.share.sharePort}/pricing`,
      { headers: { cookie } },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("passed gate");

    const missing = await fetch(`http://127.0.0.1:${created.share.sharePort}/pricing`);
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ ok: false, error: "This link isn't active." });

    const wrong = await fetch(
      `http://127.0.0.1:${created.share.sharePort}/leglas/s/wrong`,
      { redirect: "manual" },
    );
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

    const response = await fetch(
      `http://127.0.0.1:${created.share.sharePort}/leglas/api/watch`,
      { method: "POST", headers: { cookie } },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Viewers can look, not change what runs.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  test("gives a viewer config to a live link and nothing to a stranger", async () => {
    const { manager } = managerFor();
    const created = await manager.create({ scope: "rail", titles: ["Aurora"], layout, tunnel: "none" });
    if (!created.ok) throw new Error(created.error);
    const id = created.share.grants[0].id;
    expect(await manager.viewerConfig(id)).not.toBeNull();
    // Revoked between the request being admitted and the config being read:
    // the read is checked against the link, not against the share.
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

    const config = (await manager.viewerConfig(created.share.grants[0].id)) as {
      previews: Array<{ title: string }>;
      errors: string[];
      warnings: string[];
      viewer: { scope: string; layout: ShareLayout };
    };

    expect(config.previews.map((preview) => preview.title)).toEqual(["Current", "Aurora"]);
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
    // A create reads previews, looks for tunnel programs and binds a port
    // before it publishes the share. A stop arriving in there used to see
    // nothing active, report success and leave the share to come up behind
    // it. Held here at the first await so the race is the test, not luck.
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
  const enter = async (url: string): Promise<Response> =>
    fetch(url, { redirect: "manual" });

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
    const { manager, share } = await start();
    const second = manager.createGrant({ name: "Ana" });
    if (!second.ok) throw new Error(second.error);
    const [kept, cut] = second.share.grants;

    const revoked = manager.revokeGrant({ id: cut.id });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.share.grants).toHaveLength(1);
    expect(revoked.share.grants[0].id).toBe(kept.id);

    expect((await enter(kept.localUrl)).status).toBe(302);
    // A link that was turned off is not the same news as one that lapsed,
    // and neither is the same as a token that was never a link here.
    const gone = await enter(cut.localUrl);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toMatch(/turned off/);
    const stranger = await enter(kept.localUrl.replace(/\/s\/.+$/, "/s/notatokenatallnotatokenatall12"));
    expect(stranger.status).toBe(403);
  });

  test("a link past its deadline is expired, not merely unknown", async () => {
    let at = 1_000_000;
    const { manager, share } = await start({ now: () => at, nowMono: () => BigInt(at) * 1_000_000n });
    const link = share.grants[0];
    expect((await enter(link.localUrl)).status).toBe(302);

    at += 24 * 60 * 60 * 1000 + 1;
    const lapsed = await enter(link.localUrl);
    expect(lapsed.status).toBe(410);
    expect(await lapsed.text()).toMatch(/expired/);
    // And it is gone from the share rather than lingering as a live row.
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
    const { manager, share } = await start({ now: () => at, nowMono: () => BigInt(at) * 1_000_000n });
    const link = share.grants[0];
    const first = link.expiresAt;

    at += 60 * 60 * 1000;
    const extended = manager.extendGrant({ id: link.id });
    if (!extended.ok) throw new Error(extended.error);
    expect(extended.share.grants[0].expiresAt).toBeGreaterThan(first);
    // A new absolute time, not an addition, so clicking twice cannot walk it
    // into next week.
    expect(extended.share.grants[0].expiresAt).toBe(at + 24 * 60 * 60 * 1000);

    manager.revokeGrant({ id: link.id });
    const raising = manager.extendGrant({ id: link.id });
    expect(raising.ok).toBe(false);
    if (raising.ok) return;
    expect(raising.status).toBe(404);
    expect(raising.error).toMatch(/Make a new one/);
  });

  test("revoking a link drops the sockets and the requests it was holding", async () => {
    // A stream that never finishes on its own is exactly what "in-flight
    // responses are allowed to finish" would have left running: cut off in
    // name and still receiving in fact.
    let hold: ServerResponse | null = null;
    const { manager } = managerFor(previews, (res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      hold = res;
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
    await vi.waitFor(() => expect(hold).not.toBeNull());

    manager.revokeGrant({ id: link.id });
    await expect(streaming.then((r) => r.text())).rejects.toThrow();
    expect((hold as unknown as ServerResponse).destroyed).toBe(true);
  });

  test("rotate ends every link and issues one nobody has seen", async () => {
    const { manager, share } = await start();
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
    // Read off Next 16.3.1, Nuxt DevTools 4.0.0-alpha.16 and Parcel 2.16.4.
    // The point of a prefix is the members not listed here, including
    // whatever the next version adds.
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
    // Measured against Vite 8.2.2: it answers the uppercase form from the
    // same middleware, so a case-sensitive list was a way through to the
    // editor launcher. The rest are the same class, closed alongside it.
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
    // Werkzeug's debugger hangs off whichever path raised the error, so the
    // path says nothing and the query says everything.
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
      // The asset paths each framework needs in order to run at all.
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
