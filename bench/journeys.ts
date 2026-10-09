import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  KNOWN_AGENTS,
  findBrowser,
  launchBrowser,
  type CdpPage,
} from "../packages/server/dist/index.js";

import fixture from "./fixture/leglas.config.ts";
import type { ProbeEvent } from "./probe.ts";

/**
 * One walk through the journeys against a fresh copy of the fixture. Leglas
 * runs as a child with the probe loaded, cut off from the machine: a temp HOME
 * and TMPDIR, no update check and a PATH holding only fake agents and `lsof`.
 * The page is a headless Chrome driven over CDP.
 *
 * Phases are marked by requesting `/leglas/__bench/<phase>`, so the probe's
 * own stream says where each window starts and ends; marker requests are left
 * out of every count.
 */

export type JourneyName = "boot" | "idle";

export const JOURNEYS: readonly JourneyName[] = ["boot", "idle"];

/** Count name to value. A name that is absent counts zero. */
export type Counts = Record<string, number>;

export type Check = { name: string; ok: boolean; detail: string };

export type JourneyResult = {
  name: JourneyName;
  counts: Counts;
  /** Wall-clock milliseconds, reported and never gated. */
  clocks: Record<string, number>;
  /** Resident memory of Leglas and its children at the journey's end, in MB. Never gated. */
  memoryMb: number;
  checks: Check[];
};

export type RunResult = { journeys: JourneyResult[]; events: ProbeEvent[] };

/** The machine can't run the journeys as asked; the message says what to fix. */
export class BenchUnavailable extends Error {}

/**
 * The shell's fallback read: every loop reads once when the interface mounts
 * and then every FALLBACK_MS (packages/shell/src/net/live.ts), the slower ones
 * every four of those. The interface's first config read is the mount.
 */
const FALLBACK_MS = 15_000;

const FIRST_READ = "GET /leglas/api/config";

/** Fallback ticks inside the idle window: a minute's worth. */
const IDLE_TICKS = 4;

/**
 * Idle runs from the end of boot until half a tick after the fourth fallback
 * read that follows it. The end then sits half a tick from the reads on either
 * side however long boot took, and the window holds four ticks of each 15 s
 * loop and one of each 60 s loop. Boot ends about two seconds after the mount,
 * so this is the 67.5 s after the mount, less boot.
 */
function idleEnd(firstRead: number, bootEnd: number): number {
  const before = Math.floor((bootEnd - firstRead) / FALLBACK_MS);

  return firstRead + (before + IDLE_TICKS) * FALLBACK_MS + FALLBACK_MS / 2;
}

/** How long a direction added with `leglas add` may take to reach the rail. */
export const ADD_DEADLINE_MS = 2_000;

/** A failed add check keeps watching this long, so the report says how late it was. */
const ADD_WATCH_MS = 20_000;

const BOOT_TIMEOUT_MS = 60_000;

const POLL_MS = 25;

const here = fileURLToPath(new URL(".", import.meta.url));

const cliBin = join(here, "..", "packages", "cli", "dist", "bin.js");

const directions = fixture.previews;

const baseline = directions[0]?.title ?? "";

/** The direction `leglas add` registers after the idle window. */
const ADDED = { title: "Added", url: "/?v-hero=added" };

/**
 * A saved agent choice, as in a project where someone picked one. Codex,
 * because warming it starts `codex` through PATH, where the fake answers;
 * warming Claude would start the Agent SDK's own binary.
 */
const SAVED_CHOICE = { agent: "codex" };

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);

    try {
      accessSync(candidate, constants.X_OK);

      return candidate;
    } catch {
      // A later entry may have it.
    }
  }

  return null;
}

/** What a walk needs from the host, found once before the first. */
export type Host = { browser: string; lsof: string };

export function findHost(): Host {
  const browser = findBrowser();

  if (browser === null) {
    throw new BenchUnavailable(
      "No Chrome or Chromium was found to drive the interface. Install one, or set LEGLAS_BROWSER to its binary.",
    );
  }

  // Leglas asks lsof who serves the dev server's port at boot, and the counts
  // include it. macOS and the CI runner have it.
  const lsof = executableOnPath("lsof");

  if (lsof === null) {
    throw new BenchUnavailable(
      "lsof is not on PATH. Leglas runs it at boot and the counts expect it.",
    );
  }

  return { browser, lsof };
}

type Workspace = { root: string; project: string; env: NodeJS.ProcessEnv; events: string };

function prepare(host: Host): Workspace {
  const root = mkdtempSync(join(tmpdir(), "leglas-bench-"));
  const project = join(root, "project");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temp = join(root, "tmp");
  const events = join(root, "events.jsonl");
  cpSync(join(here, "fixture"), project, { recursive: true });
  mkdirSync(join(project, ".leglas"));
  writeFileSync(join(project, ".leglas", "watch.json"), `${JSON.stringify(SAVED_CHOICE)}\n`);

  for (const directory of [home, bin, temp]) mkdirSync(directory);

  // Every agent Leglas knows gets the fake, so one installed on the host (a
  // Homebrew cursor-agent on macOS, say) is shadowed rather than counted.
  for (const agent of Object.values(KNOWN_AGENTS)) {
    symlinkSync(join(here, "fake-agent.sh"), join(bin, agent.binary));
  }

  symlinkSync(host.lsof, join(bin, "lsof"));

  return {
    root,
    project,
    events,
    env: {
      HOME: home,
      PATH: bin,
      TMPDIR: temp,
      LEGLAS_NO_UPDATE_CHECK: "1",
      LEGLAS_BENCH_EVENTS: events,
    },
  };
}

/** Resolves with the first group the pattern matches in a child's stdout. */
function readLine(child: ChildProcess, pattern: RegExp, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";

    const timer = setTimeout(() => {
      reject(new Error(`${label} printed nothing usable within ${BOOT_TIMEOUT_MS / 1000}s.`));
    }, BOOT_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const match = pattern.exec(out);

      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited (${code ?? "signal"}) before it was ready.`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

const execute = promisify(execFile);

/** Resident memory of a process and everything under it, in MB. */
async function residentMb(pid: number | undefined): Promise<number> {
  if (pid === undefined) return 0;
  const { stdout } = await execute("ps", ["-A", "-o", "pid=,ppid=,rss="]);
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();

  for (const line of stdout.split("\n")) {
    const [child, parent, kb] = line.trim().split(/\s+/).map(Number);

    if (child === undefined || parent === undefined || kb === undefined || Number.isNaN(kb)) {
      continue;
    }

    rss.set(child, kb);
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }

  let total = 0;
  const queue = [pid];

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    total += rss.get(next) ?? 0;
    queue.push(...(children.get(next) ?? []));
  }

  return Math.round(total / 1024);
}

// CDP and the events file hand values over untyped; every field read goes
// through a guard.

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function hasRequestUrl(params: unknown): params is { request: { url: string } } {
  if (typeof params !== "object" || params === null || !("request" in params)) return false;
  const request = params.request;

  return typeof request === "object" && request !== null && "url" in request && isText(request.url);
}

function hasTextValue(reply: unknown): reply is { result: { value: string } } {
  if (typeof reply !== "object" || reply === null || !("result" in reply)) return false;
  const result = reply.result;

  return typeof result === "object" && result !== null && "value" in result && isText(result.value);
}

type PageState = { rail: string[]; painted: string | null; scan: string | null };

function isPageState(value: unknown): value is PageState {
  return (
    typeof value === "object" &&
    value !== null &&
    "rail" in value &&
    Array.isArray(value.rail) &&
    value.rail.every(isText) &&
    "painted" in value &&
    (value.painted === null || isText(value.painted)) &&
    "scan" in value &&
    (value.scan === null || isText(value.scan))
  );
}

function isProbeEvent(value: unknown): value is ProbeEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "t" in value &&
    typeof value.t === "number" &&
    "kind" in value &&
    (value.kind === "spawn" ||
      value.kind === "exit" ||
      value.kind === "request" ||
      value.kind === "upstream") &&
    "what" in value &&
    isText(value.what) &&
    (!("pid" in value) || typeof value.pid === "number")
  );
}

/**
 * The rail's titles, the marker the baseline's stage frame painted and the
 * direction the off-stage duplicate scan is reading, from one evaluation so
 * the three describe the same moment.
 */
const PAGE_STATE = `(() => {
  const rail = [...document.querySelectorAll("[data-title]")].map((row) => row.getAttribute("data-title"));
  let painted = null;
  try {
    const doc = document.querySelector(${JSON.stringify(`iframe[data-preview="${baseline}"]`)})?.contentDocument;
    if (doc?.documentElement.dataset.painted === "marker") painted = doc.getElementById("marker")?.textContent ?? null;
  } catch {}
  const scan = document.querySelector('iframe[title="Off-stage duplicate scan"]')?.getAttribute("src") ?? null;
  return JSON.stringify({ rail, painted, scan });
})()`;

async function pageState(page: CdpPage): Promise<PageState | null> {
  // Mid-navigation the evaluation can fail, which reads as not ready yet.
  const reply = await page
    .send("Runtime.evaluate", { expression: PAGE_STATE, returnByValue: true })
    .catch(() => null);

  if (!hasTextValue(reply)) return null;
  const parsed: unknown = JSON.parse(reply.result.value);

  return isPageState(parsed) ? parsed : null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether a URL leaves this machine. Leglas reports nowhere, and its page shouldn't either. */
function offMachine(url: string): boolean {
  try {
    const parsed = new URL(url);

    return (
      ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) && !LOOPBACK.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** What the page did, each entry a time by the runner's clock. */
type PageLog = { sockets: number[]; frames: number[]; offMachine: number[] };

const MARKER = "/leglas/__bench/";

/**
 * The tab icon. Whether a browser asks for it depends on the build, not on
 * Leglas: Chrome's headless shell never does and full Chrome does, so counting
 * it would make the same walk differ between machines.
 */
const ICON = "/leglas/favicon.svg";

/**
 * Interface files are the built shell, API reads are GETs the interface and
 * commands make, the app is whatever the proxy forwards to the dev server, and
 * other is the rest: API writes and mounted files.
 */
function requestKind(what: string): "interface" | "api" | "app" | "other" {
  const space = what.indexOf(" ");
  const method = what.slice(0, space);
  const path = what.slice(space + 1).split("?")[0] ?? "";

  if (path !== "/leglas" && !path.startsWith("/leglas/")) return "app";

  if (path.startsWith("/leglas/api/")) return method === "GET" ? "api" : "other";

  if (path.startsWith("/leglas/files/") || method !== "GET") return "other";

  return "interface";
}

function markerTime(events: readonly ProbeEvent[], phase: string): number | null {
  const marker = `GET ${MARKER}${phase}`;

  return events.find((event) => event.kind === "request" && event.what === marker)?.t ?? null;
}

type Window = { from: number; to: number };

/**
 * Every count for one window. From the probe, between two markers: requests
 * received by kind, processes started by command and requests Leglas sent off
 * the machine. At the window's end: processes still alive by command. From
 * the page, by the runner's clock: sockets opened, live frames received and
 * requests sent off the machine.
 */
function windowCounts(
  events: readonly ProbeEvent[],
  probe: Window,
  page: PageLog,
  pageWindow: Window,
): Counts {
  const inPage = (time: number) => time >= pageWindow.from && time < pageWindow.to;

  const tally = new Map([
    ["requests.interface", 0],
    ["requests.api", 0],
    ["requests.app", 0],
    ["requests.other", 0],
    ["sockets", page.sockets.filter(inPage).length],
    ["frames", page.frames.filter(inPage).length],
    ["offMachine", page.offMachine.filter(inPage).length],
  ]);

  const bump = (name: string) => tally.set(name, (tally.get(name) ?? 0) + 1);
  const alive = new Map<number, string>();

  for (const event of events) {
    if (event.t >= probe.to) break;

    if (event.kind === "spawn" && event.pid !== undefined) alive.set(event.pid, event.what);

    if (event.kind === "exit" && event.pid !== undefined) alive.delete(event.pid);

    if (event.t < probe.from) continue;

    if (event.kind === "spawn") bump(`processes.${event.what}`);

    if (
      event.kind === "request" &&
      !event.what.includes(` ${MARKER}`) &&
      !event.what.endsWith(` ${ICON}`)
    ) {
      bump(`requests.${requestKind(event.what)}`);
    }

    if (event.kind === "upstream" && offMachine(event.what.slice(event.what.indexOf(" ") + 1))) {
      bump("offMachine");
    }
  }

  for (const command of alive.values()) bump(`alive.${command}`);

  return Object.fromEntries(tally);
}

function readEvents(path: string): ProbeEvent[] {
  let text = "";

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  return text.split("\n").flatMap((line) => {
    if (line === "") return [];
    const parsed: unknown = JSON.parse(line);

    return isProbeEvent(parsed) ? [parsed] : [];
  });
}

/**
 * Boots Leglas on a fresh fixture and walks the asked journeys. Idle starts
 * where boot ends, so asking for idle boots too.
 */
export async function runJourneys(host: Host, wanted: readonly JourneyName[]): Promise<RunResult> {
  const workspace = prepare(host);
  const browser = await launchBrowser(host.browser);
  const children: ChildProcess[] = [];

  try {
    const dev = spawn(process.execPath, [join(workspace.project, "server.ts"), "--port", "0"], {
      cwd: workspace.project,
      stdio: ["ignore", "pipe", "inherit"],
    });

    children.push(dev);
    const devPort = await readLine(dev, /listening (\d+)/, "The fixture's dev server");

    return await browser.withPage((page) => walk(page, workspace, devPort, wanted, children));
  } finally {
    for (const child of children.toReversed()) await stop(child);
    await browser.close();
    rmSync(workspace.root, { recursive: true, force: true });
  }
}

type Session = {
  page: CdpPage;
  workspace: Workspace;
  leglas: ChildProcess;
  children: ChildProcess[];
  /** Requests a phase marker and returns when it was sent, by the runner's clock. */
  mark(phase: string): Promise<number>;
};

const railComplete = (state: PageState | null): boolean =>
  directions.every((direction) => state?.rail.includes(direction.title) === true);

/**
 * Boot ends once the rail lists every direction, the stage has painted the
 * baseline's marker and the duplicate scan has read every direction and gone.
 * Until then the rail still marks rows as being checked, and what the scan
 * loads belongs to boot. The rail and the marker are the moment a person can
 * start; the scan ending is the moment Leglas stops working.
 */
async function boot(
  session: Session,
): Promise<{ settledAt: number; memoryMb: number; checks: Check[] }> {
  const scanned = new Set<string>();
  let state: PageState | null = null;
  let ready = false;
  let settled = false;

  for (const deadline = performance.now() + BOOT_TIMEOUT_MS; performance.now() < deadline;) {
    state = await pageState(session.page);

    if (state?.scan !== null && state?.scan !== undefined) scanned.add(state.scan);

    if (!ready && railComplete(state) && state?.painted === baseline) {
      ready = true;
      await session.mark("ready");
    }

    if (ready && state?.scan === null && directions.every((entry) => scanned.has(entry.url))) {
      settled = true;
      break;
    }

    await sleep(POLL_MS);
  }

  const settledAt = await session.mark("settled");

  return {
    settledAt,
    memoryMb: await residentMb(session.leglas.pid),
    checks: [
      {
        name: "every direction on the rail",
        ok: railComplete(state),
        detail: `the rail lists ${JSON.stringify(state?.rail ?? [])}`,
      },
      {
        name: "the baseline's marker painted",
        ok: state?.painted === baseline,
        detail: `the stage painted ${JSON.stringify(state?.painted ?? null)}`,
      },
      {
        name: "the duplicate scan finished",
        ok: settled,
        detail: `the scan read ${JSON.stringify([...scanned])}`,
      },
    ],
  };
}

/** Waits out the idle window, from boot's end to the time `idleEnd` gives. */
async function idle(
  session: Session,
  settledAt: number,
): Promise<{ endAt: number; memoryMb: number }> {
  // The probe's clock runs a fixed offset from this one, and the settled
  // marker is on both, so the window's end converts to a time to wait for.
  const events = readEvents(session.workspace.events);
  const settledT = markerTime(events, "settled") ?? 0;
  const firstRead = events.find((event) => event.what === FIRST_READ)?.t ?? settledT;
  const endT = idleEnd(firstRead, settledT);
  await sleep(Math.max(0, settledAt + (endT - settledT) - performance.now()));
  const endAt = await session.mark("idle");

  return { endAt, memoryMb: await residentMb(session.leglas.pid) };
}

/**
 * After the idle window, so nothing it sets off is counted, and half a tick
 * from the fallback read: a direction registered from a terminal reaches the
 * open rail on the live nudge, or not for seconds. Timed from the command
 * finishing, because starting a CLI on a busy machine takes seconds of its
 * own, and the page has to hear a live frame, which a fallback read never sends.
 */
async function addCheck(session: Session, log: PageLog): Promise<{ ms: number; check: Check }> {
  const spawned = performance.now();

  const add = spawn(process.execPath, [cliBin, "add", "--title", ADDED.title, "--url", ADDED.url], {
    cwd: session.workspace.project,
    env: session.workspace.env,
    stdio: "ignore",
  });

  session.children.push(add);

  const finished = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ADD_WATCH_MS);

    add.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
    add.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  const from = performance.now();
  let ms = -1;

  while (finished && performance.now() - from < ADD_WATCH_MS) {
    const state = await pageState(session.page);

    if (state?.rail.includes(ADDED.title) === true) {
      ms = performance.now() - from;
      break;
    }

    await sleep(POLL_MS);
  }

  // The frame can land before the command's exit does, so look from the spawn.
  const heard = log.frames.some((time) => time >= spawned);

  const detail = !finished
    ? `leglas add did not finish within ${ADD_WATCH_MS / 1000}s`
    : ms < 0
      ? `not there ${ADD_WATCH_MS / 1000}s after leglas add finished`
      : heard
        ? `there ${Math.round(ms)}ms after leglas add finished`
        : `there after ${Math.round(ms)}ms, but no live frame reached the page`;

  return {
    ms,
    check: {
      name: `a direction added with leglas add reaches the rail on a live frame within ${ADD_DEADLINE_MS / 1000}s`,
      ok: finished && heard && ms >= 0 && ms <= ADD_DEADLINE_MS,
      detail,
    },
  };
}

async function walk(
  page: CdpPage,
  workspace: Workspace,
  devPort: string,
  wanted: readonly JourneyName[],
  children: ChildProcess[],
): Promise<RunResult> {
  const log: PageLog = { sockets: [], frames: [], offMachine: [] };
  page.on("Network.webSocketCreated", () => log.sockets.push(performance.now()));
  page.on("Network.webSocketFrameReceived", () => log.frames.push(performance.now()));
  page.on("Network.requestWillBeSent", (params) => {
    if (hasRequestUrl(params) && offMachine(params.request.url)) {
      log.offMachine.push(performance.now());
    }
  });
  await page.send("Network.enable");

  const leglas = spawn(
    process.execPath,
    ["--import", join(here, "probe.ts"), cliBin, "--no-open", "--json", "--user-port", devPort],
    { cwd: workspace.project, env: workspace.env, stdio: ["ignore", "pipe", "inherit"] },
  );

  children.push(leglas);
  // What the CLI prints once it listens, as it would before opening a browser.
  const url = await readLine(leglas, /"url":"([^"]+)"/, "Leglas");
  const origin = new URL(url).origin;

  const session: Session = {
    page,
    workspace,
    leglas,
    children,
    mark: async (phase) => {
      const sent = performance.now();
      await (await fetch(`${origin}${MARKER}${phase}`)).arrayBuffer();

      return sent;
    },
  };

  const navigatedAt = performance.now();
  await page.send("Page.navigate", { url });
  const booted = await boot(session);
  const idled = wanted.includes("idle") ? await idle(session, booted.settledAt) : null;
  const added = idled === null ? null : await addCheck(session, log);
  await stop(leglas);

  const events = readEvents(workspace.events);
  const settledT = markerTime(events, "settled") ?? 0;
  const journeys: JourneyResult[] = [];

  if (wanted.includes("boot")) {
    journeys.push({
      name: "boot",
      counts: windowCounts(events, { from: 0, to: settledT }, log, {
        from: navigatedAt,
        to: booted.settledAt,
      }),
      clocks: { ready: markerTime(events, "ready") ?? -1, settled: settledT },
      memoryMb: booted.memoryMb,
      checks: booted.checks,
    });
  }

  if (idled !== null && added !== null) {
    const endT = markerTime(events, "idle") ?? settledT;

    journeys.push({
      name: "idle",
      counts: windowCounts(events, { from: settledT, to: endT }, log, {
        from: booted.settledAt,
        to: idled.endAt,
      }),
      clocks: { window: endT - settledT, add: added.ms },
      memoryMb: idled.memoryMb,
      // Idle starts where boot ends, so a boot that went wrong says so here
      // too when boot itself isn't being reported.
      checks: [
        added.check,
        ...(wanted.includes("boot") ? [] : booted.checks.filter((check) => !check.ok)),
      ],
    });
  }

  return { journeys, events };
}
