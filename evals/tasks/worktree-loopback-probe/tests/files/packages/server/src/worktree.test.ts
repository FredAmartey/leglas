import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  WORKTREES_DIR,
  startAppProcess,
  startWorktree,
  substitutePort,
  worktreeSlug,
} from "./worktree.js";

const run = promisify(execFile);

describe("worktreeSlug", () => {
  test("keeps a simple branch name", () => {
    expect(worktreeSlug("main")).toBe("main");
  });

  test("flattens slashes, so a namespaced branch is one directory", () => {
    expect(worktreeSlug("feature/new-hero")).toBe("feature-new-hero");
  });

  test("strips characters that have no business in a path", () => {
    expect(worktreeSlug("feat/a b:c")).toBe("feat-a-b-c");
  });

  test("collapses runs of separators rather than leaving gaps", () => {
    expect(worktreeSlug("a///b")).toBe("a-b");
  });
});

describe("substitutePort", () => {
  test("replaces the placeholder", () => {
    expect(substitutePort("pnpm dev --port {port}", 4200)).toBe("pnpm dev --port 4200");
  });

  test("replaces every occurrence, since some commands need it twice", () => {
    expect(substitutePort("serve --port {port} --hmr {port}", 90)).toBe(
      "serve --port 90 --hmr 90",
    );
  });
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((stop) => stop().catch(() => {})));
});

/** A real repository with a branch, so the lifecycle is tested against real git. */
async function repoWithBranch(): Promise<{ cwd: string; branch: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "leglas-wt-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd });
  await run("git", ["config", "user.email", "test@example.com"], { cwd });
  await run("git", ["config", "user.name", "Test"], { cwd });
  writeFileSync(join(cwd, "marker.txt"), "main\n");
  await run("git", ["add", "-A"], { cwd });
  await run("git", ["commit", "-qm", "first"], { cwd });

  await run("git", ["checkout", "-qb", "feature/other"], { cwd });
  writeFileSync(join(cwd, "marker.txt"), "feature\n");
  // A trivial dev server, so booting is real without needing a framework.
  writeFileSync(
    join(cwd, "serve.mjs"),
    `import http from "node:http";
     import { readFileSync } from "node:fs";
     const port = Number(process.argv[2]);
     http.createServer((_q, s) => {
       s.writeHead(200, { "content-type": "text/plain" });
       s.end(readFileSync(new URL("./marker.txt", import.meta.url), "utf8"));
     }).listen(port, "127.0.0.1");
    `,
  );
  await run("git", ["add", "-A"], { cwd });
  await run("git", ["commit", "-qm", "second"], { cwd });
  await run("git", ["checkout", "-q", "main"], { cwd });

  return { cwd, branch: "feature/other" };
}

describe("startWorktree", () => {
  test("checks out the branch, boots it, and serves that branch's content", async () => {
    const { cwd, branch } = await repoWithBranch();

    const worktree = await startWorktree({
      cwd,
      branch,
      installCommand: "true",
      devCommand: "node serve.mjs {port}",
    });
    cleanups.push(worktree.stop);

    expect(worktree.port).toBeGreaterThan(0);
    const response = await fetch(worktree.url);
    // Content from the branch, not from the checked-out main.
    expect((await response.text()).trim()).toBe("feature");
  }, 60_000);

  test("puts the checkout under the ignored directory", async () => {
    const { cwd, branch } = await repoWithBranch();

    const worktree = await startWorktree({
      cwd,
      branch,
      installCommand: "true",
      devCommand: "node serve.mjs {port}",
    });
    cleanups.push(worktree.stop);

    expect(worktree.path).toContain(WORKTREES_DIR);
  }, 60_000);

  test("reports a branch that does not exist rather than hanging", async () => {
    const { cwd } = await repoWithBranch();

    await expect(
      startWorktree({
        cwd,
        branch: "no-such-branch",
        installCommand: "true",
        devCommand: "node serve.mjs {port}",
      }),
    ).rejects.toThrow(/no-such-branch/);
  }, 60_000);

  test("reports a dev command that never answers, instead of waiting forever", async () => {
    const { cwd, branch } = await repoWithBranch();

    await expect(
      startWorktree({
        cwd,
        branch,
        installCommand: "true",
        devCommand: "node -e 'setTimeout(()=>{}, 60000)' {port}",
        readyTimeoutMs: 2500,
      }),
    ).rejects.toThrow(/did not start|start/i);
  }, 60_000);

  test("removes the checkout when stopped, leaving the repository clean", async () => {
    const { cwd, branch } = await repoWithBranch();

    const worktree = await startWorktree({
      cwd,
      branch,
      installCommand: "true",
      devCommand: "node serve.mjs {port}",
    });
    await worktree.stop();

    const { stdout } = await run("git", ["worktree", "list"], { cwd });
    expect(stdout).not.toContain(WORKTREES_DIR);
  }, 60_000);
});

describe("startAppProcess", () => {
  /**
   * The fixture above serves `127.0.0.1` because it was written to match the
   * probe, so the two agreed with each other and neither matched a real dev
   * server. Vite's default binds `localhost`, which on current macOS and Node
   * resolves to `::1` first, and every branch preview then waited out its
   * ninety seconds against a server that was up the whole time.
   */
  test("finds a dev server listening on IPv6 only, and reports a URL that reaches it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-v6-"));
    writeFileSync(
      join(cwd, "serve6.mjs"),
      `import http from "node:http";
       http
         .createServer((_q, s) => {
           s.writeHead(200, { "content-type": "text/plain" });
           s.end("six");
         })
         .listen(Number(process.argv[2]), "::1");
      `,
    );

    const app = await startAppProcess({
      cwd,
      devCommand: "node serve6.mjs {port}",
      label: "an IPv6-only app",
      readyTimeoutMs: 15_000,
    });
    cleanups.push(app.stop);

    expect(app.url).toContain("[::1]");
    expect((await (await fetch(app.url)).text()).trim()).toBe("six");
  }, 40_000);

  test("still finds one listening on IPv4 only", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-v4-"));
    writeFileSync(
      join(cwd, "serve4.mjs"),
      `import http from "node:http";
       http
         .createServer((_q, s) => {
           s.writeHead(200, { "content-type": "text/plain" });
           s.end("four");
         })
         .listen(Number(process.argv[2]), "127.0.0.1");
      `,
    );

    const app = await startAppProcess({
      cwd,
      devCommand: "node serve4.mjs {port}",
      label: "an IPv4-only app",
      readyTimeoutMs: 15_000,
    });
    cleanups.push(app.stop);

    expect(app.url).toContain("127.0.0.1");
    expect((await (await fetch(app.url)).text()).trim()).toBe("four");
  }, 40_000);
});
