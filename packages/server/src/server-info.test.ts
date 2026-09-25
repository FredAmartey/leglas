import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  SERVER_INFO_PATH,
  readServerInfo,
  removeServerInfo,
  writeServerInfo,
  type ServerInfo,
} from "./server-info.js";

describe("server info", () => {
  test("round-trips the running endpoint and records when it started", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-"));
    const info = { port: 4123, url: "http://localhost:4123", pid: 987 };
    await writeServerInfo(cwd, info);

    expect(await readServerInfo(cwd)).toEqual(info);
    expect(JSON.parse(readFileSync(join(cwd, SERVER_INFO_PATH), "utf8"))).toMatchObject({
      ...info,
      startedAt: expect.any(String),
    });
    await removeServerInfo(cwd);
    expect(existsSync(join(cwd, SERVER_INFO_PATH))).toBe(false);
  });

  test("returns null for missing or malformed state", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-bad-"));
    expect(await readServerInfo(cwd)).toBeNull();
    await writeServerInfo(cwd, { port: 4100, url: "http://localhost:4100", pid: 1 });
    writeFileSync(join(cwd, SERVER_INFO_PATH), JSON.stringify({ port: "4100", url: "x", pid: 1 }));
    expect(await readServerInfo(cwd)).toBeNull();
  });

  test("leaves nothing half-written for a reader that arrives mid-write", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-atomic-"));
    await writeServerInfo(cwd, { port: 4100, url: "http://localhost:4100", pid: 1 });

    // A reader loops on the record the whole time the server keeps rewriting it.
    let writing = true;
    const reads: Array<ServerInfo | null> = [];

    const reader = (async () => {
      while (writing) reads.push(await readServerInfo(cwd));
    })();

    for (let pid = 2; pid <= 200; pid += 1) {
      await writeServerInfo(cwd, { port: 4100 + pid, url: `http://localhost:${4100 + pid}`, pid });
    }

    writing = false;
    await reader;

    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => read === null)).toEqual([]);
    expect(await readServerInfo(cwd)).toEqual({
      port: 4300,
      url: "http://localhost:4300",
      pid: 200,
    });
    // Nothing the write went through is left beside the record.
    expect(readdirSync(join(cwd, ".leglas"))).toEqual(["server.json"]);
  });
});

describe("two servers on one project", () => {
  test("an older server closing leaves the newer record alone", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-two-"));
    await writeServerInfo(cwd, { port: 4101, url: "http://localhost:4101", pid: 11 });
    await writeServerInfo(cwd, { port: 4102, url: "http://localhost:4102", pid: 22 });

    await removeServerInfo(cwd, { port: 4101, pid: 11 });
    expect(await readServerInfo(cwd)).toEqual({
      port: 4102,
      url: "http://localhost:4102",
      pid: 22,
    });

    await removeServerInfo(cwd, { port: 4102, pid: 22 });
    expect(existsSync(join(cwd, SERVER_INFO_PATH))).toBe(false);
  });
});

describe("what the record may overwrite", () => {
  test("a link standing in for the record is left as it is", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-link-"));
    mkdirSync(join(cwd, ".leglas"), { recursive: true });
    writeFileSync(join(cwd, "notes.md"), "mine");
    symlinkSync(join(cwd, "notes.md"), join(cwd, SERVER_INFO_PATH));

    await writeServerInfo(cwd, { port: 4100, url: "http://localhost:4100", pid: 1 });

    expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("mine");
  });

  test("a link standing in for .leglas itself is left as it is", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "leglas-server-info-dirlink-"));
    mkdirSync(join(cwd, "elsewhere"), { recursive: true });
    symlinkSync(join(cwd, "elsewhere"), join(cwd, ".leglas"));

    await writeServerInfo(cwd, { port: 4100, url: "http://localhost:4100", pid: 1 });

    expect(existsSync(join(cwd, "elsewhere", "server.json"))).toBe(false);
  });
});
