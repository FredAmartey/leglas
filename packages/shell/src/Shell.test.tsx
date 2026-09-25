// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentsPayload } from "./agents/agent-api.js";
import type { AgentStatus, RequestStatus } from "./agents/request-status.js";
import { Shell } from "./Shell.js";
import type { Preview, ViewerInfo } from "./types.js";
import type { JsonValue } from "./json.js";
import { must } from "./must.js";

/**
 * The shell, mounted whole against a server that answers from a table.
 *
 * Everything under the shell that can be reasoned about alone has tests of
 * its own. These are for what only shows once the pieces are together: that a
 * key reaches the panel it opens, that what is typed is what is sent, and
 * that a viewer is given nothing that changes somebody else's rail.
 */

const PREVIEWS: Preview[] = [
  { title: "Table", url: "/?hero=table", note: "The plate fills the frame.", tags: ["Hero"] },
  { title: "Menu", url: "/?hero=menu", note: "Tonight's four.", tags: ["Hero"] },
  { title: "Counter", url: "/?hero=counter", tags: ["Hero"] },
  { title: "Olive", url: "/?hero=olive", tags: ["Hero"], basedOn: "Counter" },
];

const IDLE: AgentStatus = {
  attached: false,
  running: false,
  name: null,
  activity: null,
  startedAt: null,
  stopping: false,
  waiting: null,
};

const AGENTS: AgentsPayload = {
  agents: [
    { id: "claude", name: "Claude", available: true, auth: "ok", efforts: ["low", "high"] },
    { id: "codex", name: "Codex", available: true, auth: "ok", efforts: [] },
    { id: "absent", name: "Absent", available: false, auth: "unknown", efforts: [] },
  ],
  choice: "claude",
  customRun: null,
  effort: null,
};

type Sent = { path: string; body: unknown };

/** Answer the interface's reads from a table and remember what it wrote. */
function serve(
  requests: RequestStatus[] = [],
  framing: JsonValue = { framable: true },
  extra: Record<string, JsonValue> = {},
): Sent[] {
  const sent: Sent[] = [];

  const reads = new Map<string, JsonValue>([
    ["previews/framing", framing],
    ["agents", AGENTS],
    ["annotations", { annotations: [] }],
    ["health", { devServer: "http://localhost:3000", reachable: true, cwd: "" }],
    ["requests", { requests, agent: IDLE }],
    ["share", { share: null, tunnels: [] }],
    [
      "update",
      {
        version: "1.0.0",
        install: { kind: "source", manager: "npm", command: null },
        latest: null,
        checkedAt: null,
        checkError: null,
        skipped: null,
        available: false,
        phase: { status: "idle" },
        busy: false,
      },
    ],
  ]);

  for (const [name, value] of Object.entries(extra)) reads.set(name, value);

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0] ?? "";

    const name = path.replace("/leglas/api/", "");

    if ((init?.method ?? "GET") !== "GET") {
      sent.push({ path, body: JSON.parse(String(init?.body ?? "null")) });
      const answer = name === "request" ? { ok: true, prompt: "the prompt" } : { ok: true };

      return new Response(JSON.stringify(answer), { status: 200 });
    }

    return new Response(JSON.stringify(reads.get(name) ?? {}), {
      status: reads.has(name) ? 200 : 404,
    });
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      addEventListener(): void {}
      close(): void {}
    },
  );

  return sent;
}

let root: Root;

async function mount(props: {
  requests?: RequestStatus[];
  viewer?: ViewerInfo;
  previews?: Preview[];
  framing?: JsonValue;
  /** Reads answered differently from the table's defaults, by endpoint name. */
  reads?: Record<string, JsonValue>;
}): Promise<Sent[]> {
  const sent = serve(props.requests, props.framing, props.reads);
  document.body.innerHTML = `<div id="root"></div>`;
  root = createRoot(must(document.getElementById("root"), "the root"));
  await act(async () => {
    root.render(
      <Shell
        previews={props.previews ?? PREVIEWS}
        project="a-project"
        scanPreviews={false}
        viewer={props.viewer}
      />,
    );
    await vi.advanceTimersByTimeAsync(1500);
  });

  return sent;
}

async function after(action: () => void, wait = 450): Promise<void> {
  await act(async () => {
    action();
    await vi.advanceTimersByTimeAsync(wait);
  });
}

const key = (k: string) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: k }));

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

const find = <T extends Element>(selector: string): T => {
  const found = document.querySelector<T>(selector);

  if (found === null) throw new Error(`nothing matches ${selector}`);

  return found;
};

const row = (title: string) => find<HTMLElement>(`li[data-title="${title}"] [role="button"]`);

const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const tools = () => find<HTMLElement>('[role="dialog"][aria-label="Leglas tools"]');

beforeEach(() => {
  // SAFETY: React reads its act flag off the global, which has no type for it.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: 1_790_000_000_000 });

  // The previews are frames onto a dev server that is not running here.
  // SAFETY: happy-dom hangs its settings off the window it makes, and nothing types that.
  const happy = (window as { happyDOM?: { settings: { disableIframePageLoading?: boolean } } })
    .happyDOM;

  if (happy) happy.settings.disableIframePageLoading = true;
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    clear: () => memory.clear(),
    getItem: (name: string) => memory.get(name) ?? null,
    removeItem: (name: string) => void memory.delete(name),
    setItem: (name: string, value: string) => void memory.set(name, value),
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await vi.advanceTimersByTimeAsync(10);
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("the rail and the stage", () => {
  test("every direction gets a row, and the one that is picked is the one on the stage", async () => {
    await mount({});
    expect(
      [...document.querySelectorAll("li[data-title]")].map((li) => li.getAttribute("data-title")),
    ).toEqual(["Table", "Menu", "Counter", "Olive"]);
    expect(row("Table").getAttribute("aria-pressed")).toBe("true");

    await after(() => click(row("Menu")));

    expect(row("Menu").getAttribute("aria-pressed")).toBe("true");
    expect(row("Table").getAttribute("aria-pressed")).toBe("false");

    const shown = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]")].filter(
      (frame) => frame.closest(".hidden") === null,
    );

    expect(shown.map((frame) => frame.dataset.preview)).toEqual(["Menu"]);
  });

  test("a page that refuses to be framed says so, and offers a tab of its own", async () => {
    await mount({
      previews: [{ title: "Docs", url: "https://docs.example.com/start", tags: [] }, ...PREVIEWS],
      framing: { framable: false, refusal: { header: "x-frame-options", value: "DENY" } },
    });

    // The browser fires load for its own "refused" page just as for the real one.
    await after(() => find('iframe[data-preview="Docs"]').dispatchEvent(new Event("load")));

    const alert = find('[role="alert"]');
    expect(alert.textContent).toContain("docs.example.com won’t open inside another page");
    expect(alert.textContent).toContain("X-Frame-Options: DENY");

    const open = alert.querySelector("a");
    expect(open?.getAttribute("href")).toBe("https://docs.example.com/start");
    expect(open?.getAttribute("target")).toBe("_blank");

    // Leglas asked without the browser's cookies, so a signed-in page may
    // frame after all. The reader can say so, and is not asked again.
    const anyway = [...alert.querySelectorAll("button")].find(
      (button) => button.textContent === "Show the frame anyway",
    );

    await after(() => click(must(anyway, "the show-anyway button")));
    expect(document.querySelector('[role="alert"]')).toBeNull();

    await after(() => find('iframe[data-preview="Docs"]').dispatchEvent(new Event("load")));
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  test("C puts a second direction beside the first, and its row says so", async () => {
    await mount({});
    await after(() => click(row("Menu")));
    await after(() => key("c"));

    const shown = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]")].filter(
      (frame) => frame.closest(".hidden") === null,
    );

    expect(shown.map((frame) => frame.dataset.preview).sort()).toEqual(["Menu", "Table"]);
    expect(find(`li[data-title="Table"]`).textContent).toContain("Comparing");
  });
});

describe("the keys", () => {
  test("T opens the tools, and a typeface chosen there is the one the shell wears", async () => {
    await mount({});
    expect(tools().getAttribute("aria-hidden")).toBe("true");

    await after(() => key("t"));
    expect(tools().getAttribute("aria-hidden")).toBe("false");

    const outfit = [...tools().querySelectorAll("button")].find((b) => b.textContent === "Outfit");
    await after(() => click(must(outfit, "the Outfit button")));
    expect(outfit?.getAttribute("aria-pressed")).toBe("true");
    expect(find<HTMLElement>("main").style.fontFamily).toContain("--font-outfit");
  });

  test("? lists the keys and Escape puts the list away", async () => {
    await mount({});
    await after(() => key("?"));
    expect(find('[role="dialog"][aria-label="Keyboard shortcuts"]').textContent).toContain(
      "Search",
    );

    await after(() => key("Escape"));
    expect(document.querySelector('[aria-label="Keyboard shortcuts"]')).toBeNull();
  });
});

describe("asking for a change", () => {
  test("what is typed is what is queued, as a variant of the direction on the stage", async () => {
    const sent = await mount({});
    const send = () => find<HTMLButtonElement>('button[type="submit"]');
    expect(send().disabled).toBe(true);

    await after(() => type(find("textarea"), "make the headline warmer"));
    expect(send().disabled).toBe(false);

    await after(
      () => find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      900,
    );

    expect(sent.filter((entry) => entry.path.endsWith("/api/request"))).toEqual([
      {
        path: "/leglas/api/request",
        body: { title: "Table", intent: "make the headline warmer", mode: "variant" },
      },
    ]);
    expect(find<HTMLTextAreaElement>("textarea").value).toBe("");
    expect(document.body.textContent).toContain("Asked for a change to Table");
  });

  test("the chip beside the send arms a change in place", async () => {
    const sent = await mount({});
    const chip = find<HTMLElement>('form button[aria-label^="This change makes a new variant"]');
    await after(() => click(chip));
    await after(() => type(find("textarea"), "fix the typo"));
    await after(
      () => find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      900,
    );

    expect(sent.find((entry) => entry.path.endsWith("/api/request"))?.body).toMatchObject({
      intent: "fix the typo",
      mode: "replace",
    });
  });

  test("a change that is waiting says so above the composer", async () => {
    await mount({ requests: [{ id: "r1", title: "Menu", status: "queued", mode: "variant" }] });

    const card = find('aside [role="status"]');
    expect(card.textContent).toContain("Change queued");
    expect(card.textContent).toContain("your agent picks it up next");
  });

  test("the picker lists the agents on the machine, and choosing one saves it", async () => {
    const sent = await mount({});
    const trigger = find<HTMLElement>('form button[aria-haspopup="dialog"]');
    expect(trigger.textContent).toContain("Claude");

    await after(() => click(trigger));
    const menu = find('[role="dialog"][aria-label="Who runs your changes"]');
    expect(menu.getAttribute("aria-hidden")).toBe("false");
    const options = [...menu.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(options).toContain("Codex");
    expect(options.join(" ")).not.toContain("Absent");

    const codex = [...menu.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Codex"),
    );

    await after(() => click(must(codex, "the Codex button")), 900);
    expect(sent).toContainEqual({ path: "/leglas/api/agent", body: { agent: "codex" } });
  });
});

describe("building directions", () => {
  const HEROES: Preview[] = [
    { title: "Table", url: "/?v-hero=table", note: "The plate fills the frame.", tags: ["Hero"] },
    { title: "Ledger", url: "/?v-hero=hero-ledger", note: "Ruled lines.", tags: [] },
    { title: "Pantry", url: "/?v-hero=hero-pantry", note: "What you have.", tags: [] },
  ];

  const slot = (title: string, state: string, failure: JsonValue = null) => ({
    key: `hero-${title.toLowerCase()}`,
    title,
    idea: `${title}, the idea.`,
    file: `src/heroes/hero-${title.toLowerCase()}.tsx`,
    state,
    startedAt: 1_789_999_990_000,
    endedAt: null,
    failure,
    fixed: false,
  });

  const JOB = {
    id: "gen-1",
    surface: "hero",
    brief: "Dinner in thirty minutes",
    count: 2,
    state: "building",
    startedAt: 1_789_999_990_000,
    plannedAt: 1_789_999_995_000,
    endedAt: null,
    error: null,
    slots: [
      slot("Ledger", "building"),
      slot("Pantry", "failed", {
        code: "provider-overloaded",
        message: "Claude's provider was overloaded and gave up.",
      }),
    ],
  };

  const switchedOn = () =>
    localStorage.setItem("leglas:a-project", JSON.stringify({ buildDirections: true }));

  test("switched off, the rail offers no way to build them", async () => {
    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });

    expect(document.querySelector('[aria-label="Build new directions with Claude"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Building 2 hero directions");
    expect(row("Ledger").closest("li")?.textContent).not.toContain("Building");
  });

  test("the + takes a brief and asks for the set, then the composer goes back to changes", async () => {
    switchedOn();
    const sent = await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [] } } });

    await after(() => click(find('[aria-label="Build new directions with Claude"]')));
    expect(find<HTMLTextAreaElement>("textarea").placeholder).toBe("What should they explore?");
    expect(document.body.textContent).toContain("New hero directions");

    await after(() => type(find("textarea"), "Dinner in thirty minutes"));
    await after(() => click(find('[aria-label="One direction more"]')));
    expect(find<HTMLButtonElement>('button[type="submit"]').textContent).toBe(
      "Build 4 with Claude",
    );

    await after(
      () => find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      900,
    );

    expect(sent.filter((entry) => entry.path === "/leglas/api/generate")).toEqual([
      {
        path: "/leglas/api/generate",
        body: { surface: "hero", brief: "Dinner in thirty minutes", count: 4 },
      },
    ]);
    expect(find<HTMLTextAreaElement>("textarea").placeholder).toBe("Change Table…");
  });

  test("each direction says how it is going, on its row and on the stage", async () => {
    switchedOn();
    const sent = await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });

    expect(row("Ledger").closest("li")?.textContent).toContain("Building");
    expect(row("Pantry").closest("li")?.textContent).toContain("Failed");
    expect(document.body.textContent).toContain("Building 2 hero directions");

    await after(() => click(row("Pantry")));
    expect(document.body.textContent).toContain("Pantry didn’t build");
    expect(document.body.textContent).toContain("Claude's provider was overloaded and gave up.");

    const newIdea = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try a new idea",
    );

    await after(() => click(must(newIdea, "the new idea button")));
    expect(sent.filter((entry) => entry.path.startsWith("/leglas/api/generate/"))).toEqual([
      { path: "/leglas/api/generate/replace", body: { id: "gen-1", slot: "hero-pantry" } },
    ]);
  });

  test("with an agent other than Claude, the brief says why it cannot build", async () => {
    switchedOn();
    await mount({
      previews: HEROES,
      reads: { generate: { ok: true, jobs: [] }, agents: { ...AGENTS, choice: "codex" } },
    });

    await after(() => click(find('[aria-label="Build new directions with Claude"]')));
    expect(document.querySelector('form button[type="submit"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Building directions runs on Claude. Choose it in the agent menu.",
    );
  });
});

describe("what assistive technology is told", () => {
  test("attaching an image is one control, the button, and the file input behind it is not announced", async () => {
    await mount({});
    expect(find('form button[aria-label="Attach a reference image"]')).not.toBeNull();
    expect(find('form input[type="file"]').getAttribute("aria-hidden")).toBe("true");
  });
});

describe("somebody else's rail", () => {
  test("a viewer can look, flip and compare, and is given nothing that changes it", async () => {
    const sent = await mount({
      viewer: {
        scope: "rail",
        layout: { order: [], renames: {}, collapsedFamilies: [], compare: null, viewport: null },
      },
    });

    expect(document.body.textContent).toContain("Shared with you");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.querySelector('button[aria-label="Share"]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Rename the"]')).toBeNull();
    expect(document.querySelector('button[aria-label^="Remove the"]')).toBeNull();

    await after(() => click(row("Menu")));
    expect(row("Menu").getAttribute("aria-pressed")).toBe("true");
    expect(sent).toEqual([]);
  });
});
