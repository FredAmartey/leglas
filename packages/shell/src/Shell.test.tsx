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
import { FALLBACK_MS } from "./net/live.js";

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

/** Every endpoint the interface read, by name, since the last serve. */
let reads: string[] = [];

/** The dev server's health as the server reports it; a test can change it between reads. */
type Health = { devServer: string; reachable: boolean; cwd: string };

/** Answer the interface's reads from a table and remember what it wrote. */
function serve(
  requests: RequestStatus[] = [],
  framing: JsonValue = { framable: true },
  health: Health = { devServer: "http://localhost:3000", reachable: true, cwd: "" },
  extra: Record<string, JsonValue> = {},
): Sent[] {
  const sent: Sent[] = [];
  reads = [];

  const table = new Map<string, JsonValue>([
    ["previews/framing", framing],
    ["agents", AGENTS],
    ["annotations", { annotations: [] }],
    ["health", health],
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

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0] ?? "";

    const name = path.replace("/leglas/api/", "");

    if ((init?.method ?? "GET") !== "GET") {
      const body = JSON.parse(String(init?.body ?? "null"));
      sent.push({ path, body });

      // A started set comes back as the planning job, the way the server answers.
      const answer =
        name === "request"
          ? { ok: true, prompt: "the prompt" }
          : name === "generate"
            ? {
                ok: true,
                job: {
                  ...body,
                  id: "gen-new",
                  state: "planning",
                  startedAt: 0,
                  plannedAt: null,
                  endedAt: null,
                  error: null,
                  slots: [],
                },
              }
            : { ok: true };

      return new Response(JSON.stringify(answer), { status: 200 });
    }

    reads.push(name);
    // Extra answers are read at request time, so a test can change one mid-way.
    const answer = name in extra ? extra[name] : table.get(name);

    return new Response(JSON.stringify(answer ?? {}), {
      status: answer === undefined ? 404 : 200,
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
  health?: Health;
  /** Read directions off stage for the duplicate check, as a real shell does. */
  scan?: boolean;
  /** Reads answered differently from the table's defaults, by endpoint name. */
  reads?: Record<string, JsonValue>;
}): Promise<Sent[]> {
  const sent = serve(props.requests, props.framing, props.health, props.reads);
  document.body.innerHTML = `<div id="root"></div>`;
  root = createRoot(must(document.getElementById("root"), "the root"));
  await act(async () => {
    root.render(
      <Shell
        previews={props.previews ?? PREVIEWS}
        project="a-project"
        scanPreviews={props.scan ?? false}
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

  // Where the cards start is measured with every family open, so a fold
  // never moves a card sideways. Measured on the folded rail, the roots
  // would all pull back in (Gutter.test.ts).
  test("folding a family moves no card sideways", async () => {
    // Four variants fork Counter's line out to a third lane, which puts every
    // root further in than a rail with that family folded would.
    await mount({
      previews: [
        ...PREVIEWS,
        { title: "Fig", url: "/?hero=fig", tags: ["Hero"], basedOn: "Counter" },
        { title: "Plum", url: "/?hero=plum", tags: ["Hero"], basedOn: "Counter" },
        { title: "Sage", url: "/?hero=sage", tags: ["Hero"], basedOn: "Counter" },
      ],
    });

    const indents = () =>
      new Map(
        [...document.querySelectorAll<HTMLElement>("li[data-title]")].map((li) => [
          li.dataset.title,
          li.style.paddingLeft,
        ]),
      );

    const open = indents();
    await after(() => click(find('button[aria-label="Hide the variants of Counter"]')));
    const folded = indents();

    expect([...folded.keys()]).toEqual(["Table", "Menu", "Counter"]);

    // Each card is indented at all, so equal cannot mean both empty.
    for (const [title, indent] of folded) {
      expect(indent, title).toMatch(/^\d+px$/);
      expect(indent, title).toBe(open.get(title));
    }
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

/** The generate endpoint's answer, which a test can swap while the shell is mounted. */
type GenerateAnswer = { generate: JsonValue };

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

  test("a new idea under a new title keeps the stage on that direction", async () => {
    switchedOn();
    const reads: GenerateAnswer = { generate: { ok: true, jobs: [JOB] } };
    await mount({ previews: HEROES, reads });
    await after(() => click(row("Pantry")));

    // The replacement arrives: Pantry leaves the rail and Market takes its slot.
    reads.generate = {
      ok: true,
      jobs: [
        {
          ...JOB,
          slots: [
            slot("Ledger", "building"),
            { ...slot("Pantry", "building"), title: "Market", idea: "A market stall at dusk." },
          ],
        },
      ],
    };

    const next = HEROES.map((preview) =>
      preview.title === "Pantry" ? { ...preview, title: "Market" } : preview,
    );

    await act(async () => {
      root.render(
        <Shell previews={next} project="a-project" scanPreviews={false} viewer={undefined} />,
      );
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(row("Market").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Claude is building Market");
  });

  test("an older set that is running again leads the card and holds the brief", async () => {
    switchedOn();

    const newer = {
      ...JOB,
      id: "gen-2",
      state: "done",
      endedAt: 1_789_999_999_000,
      slots: [slot("Ledger", "ready")],
    };

    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB, newer] } } });

    expect(document.body.textContent).toContain("Building 2 hero directions");

    await after(() => click(find('[aria-label="Build new directions with Claude"]')));
    expect(document.querySelector('form button[type="submit"]')).toBeNull();
    expect(document.body.textContent).toContain("A set is being built. Wait for it, or stop it.");
  });

  test("a dismissed card comes back when its set runs again", async () => {
    switchedOn();

    const done = {
      ...JOB,
      state: "done",
      endedAt: 1_789_999_999_000,
      slots: [
        slot("Ledger", "ready"),
        slot("Pantry", "failed", { code: "agent-error", message: "It went wrong." }),
      ],
    };

    const answers: GenerateAnswer = { generate: { ok: true, jobs: [done] } };
    await mount({ previews: HEROES, reads: answers });

    await after(() => click(find('[aria-label="Dismiss this set\'s summary"]')));
    expect(document.body.textContent).not.toContain("1 of 2 ready");

    answers.generate = {
      ok: true,
      jobs: [
        {
          ...done,
          state: "building",
          endedAt: null,
          slots: [slot("Ledger", "ready"), slot("Pantry", "building")],
        },
      ],
    };
    await after(() => undefined, 61_000);
    expect(document.body.textContent).toContain("Building 2 hero directions, 1 ready");
  });

  test("a retry is sent once while the set catches up", async () => {
    switchedOn();
    const sent = await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });
    const retry = () => find<HTMLButtonElement>('[aria-label="Build the Pantry direction again"]');

    await after(() => click(retry()));
    await after(() => click(retry()));

    expect(sent.filter((entry) => entry.path === "/leglas/api/generate/retry")).toEqual([
      { path: "/leglas/api/generate/retry", body: { id: "gen-1", slot: "hero-pantry" } },
    ]);
    expect(retry().disabled).toBe(true);
  });

  test("nothing reads the sets when the switch is off, or for somebody else's rail", async () => {
    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });
    await after(() => click(row("Pantry")));
    expect(reads).not.toContain("generate");
    expect(document.body.textContent).not.toContain("didn’t build");

    await act(async () => root.unmount());
    switchedOn();
    await mount({
      previews: HEROES,
      reads: { generate: { ok: true, jobs: [JOB] } },
      viewer: {
        scope: "rail",
        layout: { order: [], renames: {}, collapsedFamilies: [], compare: null, viewport: null },
      },
    });
    await after(() => undefined, 61_000);
    expect(reads).not.toContain("generate");
  });

  test("a set dismissed and then retried shows its new result, not the newest set's", async () => {
    switchedOn();
    const failed = slot("Pantry", "failed", { code: "agent-error", message: "It went wrong." });

    const older = {
      ...JOB,
      state: "done",
      endedAt: 1_789_999_995_000,
      slots: [slot("Ledger", "ready"), failed],
    };

    const newer = {
      ...JOB,
      id: "gen-2",
      count: 1,
      state: "done",
      endedAt: 1_789_999_990_000,
      slots: [slot("Menu", "ready")],
    };

    const answers: GenerateAnswer = { generate: { ok: true, jobs: [older, newer] } };
    await mount({ previews: HEROES, reads: answers });

    expect(document.body.textContent).toContain("1 of 2 ready. Pantry failed");
    await after(() => click(find('[aria-label="Dismiss this set\'s summary"]')));

    answers.generate = {
      ok: true,
      jobs: [
        {
          ...older,
          state: "building",
          endedAt: null,
          slots: [slot("Ledger", "ready"), slot("Pantry", "building")],
        },
        newer,
      ],
    };
    await after(() => undefined, 61_000);
    expect(document.body.textContent).toContain("Building 2 hero directions, 1 ready");

    // The retry ends later than the newest set did, and its ending was never dismissed.
    answers.generate = {
      ok: true,
      jobs: [
        {
          ...older,
          endedAt: 1_790_000_070_000,
          slots: [slot("Ledger", "ready"), slot("Pantry", "ready")],
        },
        newer,
      ],
    };
    await after(() => undefined, 16_000);
    expect(document.body.textContent).toContain("2 hero directions ready");
  });

  test("only a new set brings its first row into view, never a retry on an older one", async () => {
    switchedOn();
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const answers: GenerateAnswer = { generate: { ok: true, jobs: [JOB] } };
    await mount({ previews: HEROES, reads: answers });
    expect(scrolled).not.toHaveBeenCalled();

    const fresh = { ...JOB, id: "gen-3", state: "planning", slots: [] };
    answers.generate = {
      ok: true,
      jobs: [{ ...JOB, state: "done", endedAt: 1_790_000_010_000 }, fresh],
    };
    await after(() => undefined, 16_000);
    answers.generate = {
      ok: true,
      jobs: [
        { ...JOB, state: "done", endedAt: 1_790_000_010_000 },
        { ...fresh, state: "building", slots: [slot("Ledger", "building")] },
      ],
    };
    await after(() => undefined, 16_000);
    expect(scrolled).toHaveBeenCalledTimes(1);
    scrolled.mockRestore();
  });

  test("with an agent other than Claude, the brief says why it cannot build", async () => {
    switchedOn();

    const sent = await mount({
      previews: HEROES,
      reads: { generate: { ok: true, jobs: [] }, agents: { ...AGENTS, choice: "codex" } },
    });

    await after(() => click(find('[aria-label="Build new directions with Claude"]')));
    expect(document.querySelector('form button[type="submit"]')).toBeNull();
    expect(document.body.textContent).toContain("Building directions runs on Claude.");
    // The picker sits beside the reason, so Claude can be chosen without leaving the brief.
    expect(find("form").textContent).toContain("Codex");

    // Enter submits the form even with the button gone; the reason stands there too.
    await after(() => type(find("textarea"), "Dinner in thirty minutes"));
    await after(
      () => find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      900,
    );
    expect(sent.filter((entry) => entry.path === "/leglas/api/generate")).toEqual([]);
  });
});

describe("the duplicate check", () => {
  // When the dev server comes back, every direction it serves is reloaded,
  // and most of them are off stage. The shell used to remember only the
  // mounted ones, so an off-stage reload had nothing earlier to differ from:
  // its verdict stood, and a restart that changed the page could still be
  // called a duplicate of what it used to be.
  test("an off-stage direction reloaded by a recovery is read again", async () => {
    const health: Health = { devServer: "http://localhost:3000", reachable: true, cwd: "" };

    // On stage, a page from another origin, which the check cannot read;
    // behind it, two routes on the app, which it reads one at a time.
    await mount({
      previews: [
        { title: "Docs", url: "https://docs.example.com/start", tags: [] },
        { title: "Menu", url: "/?hero=menu", tags: [] },
        { title: "Counter", url: "/?hero=counter", tags: [] },
      ],
      health,
      scan: true,
    });

    const reading = () =>
      document.querySelector('iframe[title="Off-stage duplicate scan"]')?.getAttribute("src") ??
      null;

    // Nothing is read behind a stage that has not settled.
    await after(() => find('iframe[data-preview="Docs"]').dispatchEvent(new Event("load")));

    // No frame loads in a test, so each read ends as failed once its time is
    // up. A failed read is a verdict too, and it stands. Each wait moves the
    // scan on by one read: React applies the failed verdict as `after` ends,
    // and only then starts the next read's timer, so any wait past the 15 s
    // load limit does.
    expect(reading()).toBe("/?hero=menu");
    await after(() => {}, 60_000);
    expect(reading()).toBe("/?hero=counter");
    await after(() => {}, 60_000);
    expect(reading()).toBeNull();

    // The dev server goes, and comes back.
    health.reachable = false;
    await after(() => {}, FALLBACK_MS);
    health.reachable = true;
    await after(() => {}, FALLBACK_MS);

    expect(reading()).toBe("/?hero=menu");
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
