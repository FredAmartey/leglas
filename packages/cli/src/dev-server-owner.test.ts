import { describe, expect, test } from "vitest";

import {
  devServerOwnerWarning,
  localDevServerPort,
  parseListeningPids,
  parseOwnerCwds,
} from "./dev-server-owner.js";

describe("localDevServerPort", () => {
  test("recognizes loopback origins and their default ports", () => {
    expect(localDevServerPort("http://localhost:3001")).toBe(3001);
    expect(localDevServerPort("http://127.0.0.1")).toBe(80);
    expect(localDevServerPort("https://[::1]")).toBe(443);
  });

  test("ignores remote and invalid origins", () => {
    expect(localDevServerPort("https://example.com:3000")).toBeNull();
    expect(localDevServerPort("not a url")).toBeNull();
  });
});

describe("lsof parsing", () => {
  test("deduplicates listener process ids", () => {
    expect(parseListeningPids("p42\nf10\np42\np87\n")).toEqual([42, 87]);
  });

  test("pairs each process with only its cwd record", () => {
    expect(parseOwnerCwds("p42\nfcwd\nn/work/app\nf17\nnignored\np87\nfcwd\nn/work/api\n")).toEqual([
      { pid: 42, cwd: "/work/app" },
      { pid: 87, cwd: "/work/api" },
    ]);
  });
});

describe("devServerOwnerWarning", () => {
  test("stays quiet when any listener belongs to the project tree", () => {
    expect(
      devServerOwnerWarning("http://localhost:3000", "/work/app", [
        { pid: 42, cwd: "/work/app/packages/web" },
      ]),
    ).toBeNull();
  });

  test("names an unrelated listener and gives the correction", () => {
    expect(
      devServerOwnerWarning("http://localhost:3000", "/work/current-app", [
        { pid: 42, cwd: "/work/other-app" },
      ]),
    ).toBe(
      "Port 3000 appears to be served from other-app, outside this project (current-app). " +
        "Check devServer in your Leglas config or use --user-port.",
    );
  });

  test("stays quiet without ownership evidence", () => {
    expect(devServerOwnerWarning("http://localhost:3000", "/work/current-app", [])).toBeNull();
  });
});
