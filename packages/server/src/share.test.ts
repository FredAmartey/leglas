import type { ServerResponse } from "node:http";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Preview } from "./config.js";
import { createLiveHub } from "./live.js";
import { createShareManager, type ShareLayout } from "./share.js";

const previews: Preview[] = [
  { title: "Current", url: "/", note: undefined, tags: [] },
  { title: "Aurora", url: "/aurora", note: undefined, tags: [] },
];

const layout: ShareLayout = {
  order: ["Current", "Aurora"],
  renames: { Aurora: "Afterglow" },
  hidden: [],
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
) {
  const live = createLiveHub();
  const nudge = vi.spyOn(live, "nudge");
  const manager = createShareManager({
    live,
    previews: async () => current,
    previewsForConfig: (entries) => entries.map((entry) => ({ ...entry })),
    viewerConfig: {
      project: "test-project",
      devServer: "http://127.0.0.1:3000",
      scanPreviews: true,
    },
    request: (_req, res) => request(res),
    upgrade: (_req, socket) => socket.destroy(),
    detectTunnels: async () => [],
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
    expect(result.share.localUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${result.share.sharePort}/leglas/s/[A-Za-z0-9_-]{32}$`),
    );
    expect(result.share.tunnel).toEqual({ status: "none" });
    expect(result.share.url).toBeNull();
    expect(result.share.viewers).toBe(0);
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

    const entry = await fetch(created.share.localUrl, {
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
    const entry = await fetch(created.share.localUrl, { redirect: "manual" });
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

  test("builds viewer config from shared titles in config order", async () => {
    const { manager } = managerFor();
    const compareLayout = { ...layout, compare: "Current" };
    const created = await manager.create({
      scope: "compare",
      titles: ["Aurora", "Current"],
      layout: compareLayout,
    });
    if (!created.ok) throw new Error(created.error);

    const config = (await manager.viewerConfig()) as {
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
