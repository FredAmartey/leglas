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
 * The shell mounted whole against a server answering from a table. For what
 * only shows with the pieces together: a key reaches its panel, what's typed is
 * what's sent, and a viewer gets nothing that changes someone else's rail.
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
                  basedOn: null,
                  agent: "claude",
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

  // The previews are frames onto a dev server that isn't running here.
  // SAFETY: happy-dom hangs its settings off the window it makes, and nothing
  // types that.
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

    // Leglas asked without cookies, so a signed-in page may frame after all.
    // The reader can say so, and isn't asked again.
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

  // Card starts are measured with every family open, so a fold never moves a
  // card sideways; measured folded, the roots would pull back in
  // (Gutter.test.ts).
  test("folding a family moves no card sideways", async () => {
    // Four variants fork Counter's line to a third lane, putting every root
    // further in than a folded rail would.
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

    // Each card is indented at all, so equal can't mean both empty.
    for (const [title, indent] of folded) {
      expect(indent, title).toMatch(/^\d+px$/);
      expect(indent, title).toBe(open.get(title));
    }
  });
});

describe("a link into the interface", () => {
  const opening = (address: string) => window.history.replaceState(null, "", address);

  /** The directions on stage, left to right. */
  const onStage = () =>
    [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-preview]")]
      .flatMap((frame) =>
        frame.closest(".hidden") === null
          ? [
              {
                title: frame.dataset.preview,
                order: frame.closest<HTMLElement>('[style*="order"]')?.style.order ?? "",
              },
            ]
          : [],
      )
      .toSorted((left, right) => left.order.localeCompare(right.order))
      .map((pane) => pane.title);

  afterEach(() => opening("/"));

  test("opens on the direction it names, and leaves the address bar as it found it", async () => {
    opening("/leglas?direction=Menu&theirs=1");
    await mount({});

    expect(row("Menu").getAttribute("aria-pressed")).toBe("true");
    expect(onStage()).toEqual(["Menu"]);
    expect(window.location.search).toBe("?theirs=1");
  });

  test("naming two puts them side by side, the second on the right", async () => {
    opening("/leglas?direction=Olive&compare=Menu");
    await mount({});

    expect(onStage()).toEqual(["Olive", "Menu"]);
  });

  test("brings back a direction taken off the list or folded into its family", async () => {
    localStorage.setItem(
      "leglas:a-project",
      JSON.stringify({ hidden: ["Menu"], collapsedFamilies: ["Counter"] }),
    );
    opening("/leglas?direction=Olive&compare=Menu");
    await mount({});

    const rows = [...document.querySelectorAll("li[data-title]")].map((li) =>
      li.getAttribute("data-title"),
    );

    expect(rows).toContain("Olive");
    expect(rows).toContain("Menu");
    expect(row("Olive").getAttribute("aria-pressed")).toBe("true");
  });

  test("a compare with no direction opens nothing and leaves the address bar", async () => {
    opening("/leglas?compare=Menu");
    await mount({});

    expect(onStage()).toEqual(["Table"]);
    expect(window.location.search).toBe("");
  });

  test("naming a direction this rail doesn't have changes nothing and says so", async () => {
    opening("/leglas?direction=Aurora");
    await mount({});

    expect(row("Table").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Aurora");
  });

  test("is not followed on somebody else's rail", async () => {
    opening("/leglas?direction=Menu");
    await mount({
      viewer: {
        scope: "rail",
        layout: { order: [], renames: {}, collapsedFamilies: [], compare: null, viewport: null },
      },
    });

    expect(row("Table").getAttribute("aria-pressed")).toBe("true");
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
    activity: null,
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
    basedOn: null,
    agent: "claude",
  };

  const switchedOn = () =>
    localStorage.setItem("leglas:a-project", JSON.stringify({ buildDirections: true }));

  const moreLike = () =>
    [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("More like "),
    );

  test("switched off, the rail offers no way to build them", async () => {
    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });

    expect(document.querySelector('[aria-label="Build a set of new directions"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Building 2 hero directions");
    expect(row("Ledger").closest("li")?.textContent).not.toContain("Building");
  });

  test("the + takes a brief and asks for the set, then the composer goes back to changes", async () => {
    switchedOn();
    const sent = await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [] } } });

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
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

  test("the brief can ask for more like the direction on the stage, with nothing typed", async () => {
    switchedOn();
    const reads: GenerateAnswer = { generate: { ok: true, jobs: [] } };
    const sent = await mount({ previews: HEROES, reads });

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
    const like = must(moreLike(), "the more like chip");
    expect(like.textContent).toBe("More like Table");
    expect(like.getAttribute("aria-pressed")).toBe("false");
    expect(find<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);

    await after(() => click(like));
    expect(like.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Variations of Table");
    expect(document.body.textContent).not.toContain("New hero directions");
    expect(find<HTMLTextAreaElement>("textarea").placeholder).toBe(
      "What should they vary? Optional",
    );
    expect(find<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);

    await after(() => {
      find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // From here the server lists the set it started.
      reads.generate = {
        ok: true,
        jobs: [
          {
            ...JOB,
            id: "gen-new",
            brief: "",
            count: 3,
            state: "planning",
            slots: [],
            basedOn: "Table",
          },
        ],
      };
    }, 900);

    expect(sent.filter((entry) => entry.path === "/leglas/api/generate")).toEqual([
      {
        path: "/leglas/api/generate",
        body: { surface: "hero", brief: "", count: 3, basedOn: "Table" },
      },
    ]);
    expect(document.body.textContent).toContain("Planning 3 variations of Table…");
    // Nothing was typed, so the card quotes nothing.
    expect(document.body.textContent).not.toContain("“”");
  });

  test("a direction still being built has nothing to vary yet", async () => {
    switchedOn();
    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [JOB] } } });
    await after(() => click(row("Ledger")));

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
    expect(document.body.textContent).toContain("New hero directions");
    expect(moreLike()).toBeUndefined();
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

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
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

  test("a finished set can go on the stage whole, and each name opens its direction", async () => {
    switchedOn();

    const done = {
      ...JOB,
      state: "done",
      endedAt: 1_789_999_999_000,
      slots: [slot("Ledger", "ready"), slot("Pantry", "ready")],
    };

    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [done] } } });

    const compareAll = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Compare all 2",
    );

    await after(() => click(must(compareAll, "the compare button")));
    expect(
      [...document.querySelectorAll('button[aria-label$="on its own"]')].map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Open Ledger on its own", "Open Pantry on its own"]);

    await after(() => click(find('[aria-label="Open Pantry on its own"]')));
    expect(document.querySelectorAll('button[aria-label$="on its own"]')).toHaveLength(0);
    expect(row("Pantry").getAttribute("aria-pressed")).toBe("true");
  });

  test("the card counts only the finished directions still on the rail", async () => {
    switchedOn();

    // Chalk was removed from the rail after it was built.
    const done = {
      ...JOB,
      state: "done",
      endedAt: 1_789_999_999_000,
      slots: [slot("Ledger", "ready"), slot("Pantry", "ready"), slot("Chalk", "ready")],
    };

    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [done] } } });

    expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toContain(
      "Compare all 2",
    );
  });

  test("picking a row ends the whole set, so coming back shows one direction", async () => {
    switchedOn();

    const done = {
      ...JOB,
      state: "done",
      endedAt: 1_789_999_999_000,
      slots: [slot("Ledger", "ready"), slot("Pantry", "ready")],
    };

    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [done] } } });

    const compareAll = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Compare all 2",
    );

    await after(() => click(must(compareAll, "the compare button")));
    expect(document.querySelectorAll('button[aria-label$="on its own"]')).toHaveLength(2);

    await after(() => click(row("Ledger")));
    await after(() => click(row("Table")));
    expect(document.querySelectorAll('button[aria-label$="on its own"]')).toHaveLength(0);
  });

  describe("a set shown whole", () => {
    const whole = async (typed = ""): Promise<Sent[]> => {
      switchedOn();

      const done = {
        ...JOB,
        state: "done",
        endedAt: 1_789_999_999_000,
        slots: [slot("Ledger", "ready"), slot("Pantry", "ready")],
      };

      const sent = await mount({
        previews: HEROES,
        reads: { generate: { ok: true, jobs: [done] } },
      });

      if (typed !== "") await after(() => type(find("textarea"), typed));

      const compareAll = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "Compare all 2",
      );

      await after(() => click(must(compareAll, "the compare button")));
      expect(document.querySelectorAll('button[aria-label$="on its own"]')).toHaveLength(2);

      return sent;
    };

    const shownWhole = () => document.querySelectorAll('button[aria-label$="on its own"]').length;

    test("takes no change for a direction that is off the stage, and offers no variations of it", async () => {
      // Words typed for Table before the set went up must not go to it unseen.
      const sent = await whole("Make it warmer");
      const field = find<HTMLTextAreaElement>("textarea");

      expect(field.disabled).toBe(true);
      expect(field.placeholder).toBe("Open one of them to ask for a change");

      await after(() =>
        find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(sent.filter((entry) => entry.path === "/leglas/api/request")).toEqual([]);

      await after(() => click(find('[aria-label="Build a set of new directions"]')));
      expect(moreLike()).toBeUndefined();
    });

    test("gives way to comparing two when a row's compare is pressed", async () => {
      await whole();

      await after(() => click(find('[aria-label="Compare Pantry with Table"]')));
      expect(shownWhole()).toBe(0);
      expect(
        [...document.querySelectorAll("iframe")].map((frame) => frame.getAttribute("title")),
      ).toEqual(["Preview: Table", "Preview: Pantry"]);
    });

    test("ends when the row it was opened from is picked again", async () => {
      await whole();

      await after(() => click(row("Table")));
      expect(shownWhole()).toBe(0);
    });

    test("stays while Escape is taken by a modal or the search field", async () => {
      await whole();

      const connect = [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Connect agent via MCP"),
      );

      await after(() => click(must(connect, "the MCP connect button")));
      expect(document.activeElement?.closest("dialog")).not.toBeNull();
      await after(() => key("Escape"));
      expect(shownWhole()).toBe(2);

      await after(() => find<HTMLInputElement>('input[placeholder="Search directions…"]').focus());
      await after(() => key("Escape"));
      expect(shownWhole()).toBe(2);
    });

    test("stays while Escape closes a popover over it", async () => {
      await whole();
      await after(() => key("t"));
      expect(tools().getAttribute("aria-hidden")).toBe("false");

      await after(() => key("Escape"));
      expect(tools().getAttribute("aria-hidden")).toBe("true");
      expect(shownWhole()).toBe(2);

      await after(() => key("Escape"));
      expect(shownWhole()).toBe(0);
    });
  });

  test("a fix run's step shows while the page is checked, and otherwise the page is being opened", async () => {
    switchedOn();

    const checking = (activity: string | null) => ({
      ...JOB,
      slots: [{ ...slot("Ledger", "checking"), activity }],
    });

    const reads: GenerateAnswer = { generate: { ok: true, jobs: [checking(null)] } };
    await mount({ previews: HEROES, reads });
    await after(() => click(row("Ledger")));
    expect(document.body.textContent).toContain("opening the page");

    reads.generate = {
      ok: true,
      jobs: [checking("editing src/heroes/hero-ledger.tsx")],
    };
    await after(() => undefined, 16_000);
    expect(document.body.textContent).toContain("editing src/heroes/hero-ledger.tsx");
    expect(document.body.textContent).not.toContain("opening the page");
  });

  test("a direction being built says what its build is doing", async () => {
    switchedOn();

    const building = {
      ...JOB,
      slots: [{ ...slot("Ledger", "building"), activity: "editing src/heroes/hero-ledger.tsx" }],
    };

    await mount({ previews: HEROES, reads: { generate: { ok: true, jobs: [building] } } });

    await after(() => click(row("Ledger")));
    expect(document.body.textContent).toContain("editing src/heroes/hero-ledger.tsx");
    expect(document.body.textContent).toContain("usually a minute or two");
  });

  test("with more than one surface, the brief can build for another", async () => {
    switchedOn();

    const previews: Preview[] = [
      ...HEROES,
      { title: "Plans", url: "/pricing?v-pricing=plans", tags: [] },
    ];

    const sent = await mount({ previews, reads: { generate: { ok: true, jobs: [] } } });

    await after(() => click(find('[aria-label="Build a set of new directions"]')));

    const picker = find<HTMLSelectElement>(
      'select[aria-label="The surface to build directions for"]',
    );

    expect([...picker.options].map((option) => option.value)).toEqual(["hero", "pricing"]);

    await after(() => {
      picker.value = "pricing";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await after(() => type(find("textarea"), "Plans that feel fair"));
    await after(
      () => find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      900,
    );

    expect(sent.filter((entry) => entry.path === "/leglas/api/generate")).toEqual([
      {
        path: "/leglas/api/generate",
        body: { surface: "pricing", brief: "Plans that feel fair", count: 3 },
      },
    ]);
  });

  test("with Codex chosen, the brief builds with Codex and its set says so", async () => {
    switchedOn();

    const reads: GenerateAnswer & { agents: JsonValue } = {
      generate: { ok: true, jobs: [] },
      agents: { ...AGENTS, choice: "codex" },
    };

    const sent = await mount({ previews: HEROES, reads });

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
    expect(find<HTMLButtonElement>('button[type="submit"]').textContent).toBe("Build 3 with Codex");
    expect(document.body.textContent).toContain(
      "Runs on your Codex plan. Usually two or three minutes.",
    );

    await after(() => type(find("textarea"), "Dinner in thirty minutes"));
    await after(() => {
      find("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      // From here the server lists the set it started, building with Codex.
      reads.generate = {
        ok: true,
        jobs: [{ ...JOB, agent: "codex", slots: [slot("Ledger", "building")] }],
      };
    }, 900);
    expect(sent.filter((entry) => entry.path === "/leglas/api/generate")).toHaveLength(1);

    await after(() => click(row("Ledger")));
    expect(document.body.textContent).toContain("Codex is building Ledger");
    expect(find('[aria-label="Codex is building this direction"]')).not.toBeNull();
  });

  test("with an agent other than Claude or Codex, the brief says why it cannot build", async () => {
    switchedOn();

    const cursor = { id: "cursor", name: "Cursor", available: true, auth: "ok", efforts: [] };

    const sent = await mount({
      previews: HEROES,
      reads: {
        generate: { ok: true, jobs: [] },
        agents: { ...AGENTS, agents: [...AGENTS.agents, cursor], choice: "cursor" },
      },
    });

    await after(() => click(find('[aria-label="Build a set of new directions"]')));
    expect(document.querySelector('form button[type="submit"]')).toBeNull();
    expect(document.body.textContent).toContain("Building directions runs on Claude or Codex.");
    // The picker sits beside the reason, so another agent can be chosen without leaving the brief.
    expect(find("form").textContent).toContain("Cursor");

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
  // A recovery reloads every direction the dev server serves, mostly off stage.
  // Unless those are read again, a restart that changed a page keeps its old
  // duplicate verdict.
  test("an off-stage direction reloaded by a recovery is read again", async () => {
    const health: Health = { devServer: "http://localhost:3000", reachable: true, cwd: "" };

    // On stage, another origin the check can't read; behind it, two app routes
    // it reads one at a time.
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

    // No frame loads in a test, so each read fails at the 15 s limit and the
    // failed verdict stands. Each wait past that moves the scan on one read:
    // React applies the verdict as `after` ends, then starts the next timer.
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
