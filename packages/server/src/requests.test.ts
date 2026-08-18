import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { appendRequest, clearRequests, collectRequests, composeRequest, markFailed, markPickedUp, readRequests, removeRequest, targetFor, variantSlot } from "./requests.js";
import type { Preview } from "./config.js";

const preview = (title: string, url: string): Preview => ({
  title,
  url,
  note: undefined,
  tags: [],
});

describe("targetFor", () => {
  test("derives the file from a url the scaffold generated", () => {
    expect(targetFor("/?v-hero=aurora")).toBe(".leglas/variants/hero/aurora.tsx");
  });

  test("works when the variant param is not the only one", () => {
    expect(targetFor("/pricing?utm=x&v-hero=aurora")).toBe(".leglas/variants/hero/aurora.tsx");
  });

  test("returns nothing for a url that is not a variant of a surface", () => {
    expect(targetFor("/pricing")).toBeNull();
  });

  test("returns nothing for an absolute url, which is not ours to edit", () => {
    expect(targetFor("https://staging.example.com/?v-hero=aurora")).toBeNull();
  });

  test("ignores a param that merely looks similar", () => {
    expect(targetFor("/?variant=aurora")).toBeNull();
  });

  test("refuses a value that would escape the variants directory", () => {
    expect(targetFor("/?v-hero=../../etc/passwd")).toBeNull();
  });
});

describe("composeRequest, as a variant", () => {
  const filePreview = (title: string, file: string): Preview => ({
    title,
    url: "/leglas/local/hero.html",
    note: undefined,
    tags: [],
    file,
  });

  test("builds a new direction and says the old one is not to be touched", () => {
    const { prompt } = composeRequest(
      preview("Poster", "/?v-hero=poster"),
      "the pouch looks fake",
      "variant",
    );

    expect(prompt).toContain('add a new design direction based on the "Poster" direction');
    expect(prompt).toContain('Leave "Poster" itself exactly as it is');
    expect(prompt).toContain("the pouch looks fake");
  });

  // The whole point of the mode: a variant is its parent plus the change. An
  // agent told only to build something new produces a fresh design wearing a
  // related name, which is not comparable with what it came from.
  test("starts the new direction from a copy of the parent's file", () => {
    const { prompt, target } = composeRequest(
      preview("Poster", "/?v-hero=poster"),
      "warmer",
      "variant",
    );

    expect(target).toBe(".leglas/variants/hero/poster.tsx");
    expect(prompt).toContain("Its source is .leglas/variants/hero/poster.tsx.");
    expect(prompt).toContain("Copy that file to a new one in the same folder");
  });

  test("hands over the registration that puts it under its parent", () => {
    const { prompt } = composeRequest(
      preview("Poster", "/?v-hero=poster"),
      "warmer",
      "variant",
    );

    expect(prompt).toContain("npx leglas add");
    expect(prompt).toContain('--url "/?v-hero=<key>"');
    expect(prompt).toContain('--based-on "Poster"');
    expect(prompt).toContain('--asked-for "warmer"');
    expect(prompt).toContain(".leglas/variants/hero/switch.tsx");
  });

  // A quote in the request would end the argument early and hand the shell
  // the rest of the sentence.
  test("quotes the request so a typed quote cannot break the command", () => {
    const { prompt } = composeRequest(
      preview("Poster", "/?v-hero=poster"),
      'make the "hero" bolder',
      "variant",
    );

    expect(prompt).toContain('--asked-for "make the \\"hero\\" bolder"');
  });

  test("a file-backed direction is copied as a file and registered as one", () => {
    const { prompt } = composeRequest(
      filePreview("Poster", "directions/poster.html"),
      "warmer",
      "variant",
    );

    expect(prompt).toContain("Its source is directions/poster.html.");
    expect(prompt).toContain("Copy that file to a new file beside it");
    expect(prompt).toContain('--file "<the new file>"');
    expect(prompt).not.toContain("--url");
  });

  test("a direction with no derivable source still gets a usable brief", () => {
    const { prompt, target } = composeRequest(
      preview("Current", "/"),
      "warmer",
      "variant",
    );

    expect(target).toBeNull();
    expect(prompt).toContain("Find what renders it first.");
    expect(prompt).toContain("Copy its source rather than editing it");
    expect(prompt).toContain('--based-on "Current"');
  });

  test("reports the mode it composed for, so the queue can record it", () => {
    expect(composeRequest(preview("Poster", "/?v-hero=poster"), "x", "variant").mode).toBe(
      "variant",
    );
    expect(composeRequest(preview("Poster", "/?v-hero=poster"), "x", "replace").mode).toBe(
      "replace",
    );
  });

  // The two prompts ask for opposite work, and the failure mode of getting it
  // wrong is an overwritten direction.
  test("never tells the agent to edit the parent", () => {
    const { prompt } = composeRequest(
      preview("Poster", "/?v-hero=poster"),
      "warmer",
      "variant",
    );

    expect(prompt).not.toContain("Make the change in that file");
    expect(prompt).not.toContain("change only");
  });
});

describe("variantSlot", () => {
  test("reads the surface and option a scaffold url names", () => {
    expect(variantSlot("/?v-hero=poster")).toEqual({ option: "poster", surface: "hero" });
  });

  test("refuses anything that could climb out of the variants directory", () => {
    expect(variantSlot("/?v-hero=../../etc/passwd")).toBeNull();
  });

  test("has nothing to say about a url the scaffold did not write", () => {
    expect(variantSlot("/pricing")).toBeNull();
  });
});

describe("composeRequest", () => {
  test("names the direction so the agent knows what is being changed", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "make it warmer", "replace");

    expect(prompt).toContain("Aurora");
    expect(prompt).toContain("make it warmer");
  });

  test("points at the exact file when the url reveals one", () => {
    const { prompt, target } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer", "replace");

    expect(target).toBe(".leglas/variants/hero/aurora.tsx");
    expect(prompt).toContain(".leglas/variants/hero/aurora.tsx");
  });

  test("still produces a usable prompt when the file cannot be derived", () => {
    const { prompt, target } = composeRequest(preview("Pricing v2", "/pricing-v2"), "tighten it", "replace");

    expect(target).toBeNull();
    expect(prompt).toContain("Pricing v2");
    expect(prompt).toContain("/pricing-v2");
  });

  test("tells the agent the change is scoped, so it skips the verification ceremony", () => {
    const known = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer", "replace").prompt;
    const unknown = composeRequest(preview("Pricing v2", "/pricing-v2"), "warmer", "replace").prompt;

    // The measured cost of leaving this out is minutes of post-edit test
    // runs and repo searches per request, not seconds.
    expect(known).toContain("Make the change in that file and finish.");
    expect(unknown).toContain("Once found, make the change and finish.");
    for (const prompt of [known, unknown]) {
      expect(prompt).toContain("no test run, no build");
      expect(prompt).toContain("checked visually in a live preview");
    }
  });

  test("tells the agent to change only this direction, not its siblings", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer", "replace");

    expect(prompt.toLowerCase()).toContain("only");
  });

  test("does not ask the agent to re-register a direction that already exists", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "warmer", "replace");

    expect(prompt).not.toContain("leglas add");
  });

  test("trims the intent, so padding from a textarea does not reach the agent", () => {
    const { prompt } = composeRequest(preview("Aurora", "/?v-hero=aurora"), "  warmer\n\n", "replace");

    expect(prompt).toContain("What to change: warmer");
    expect(prompt).not.toMatch(/\n{3}/);
  });
});

describe("request lifecycle", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "leglas-requests-"));
  const input = { title: "Aurora", url: "/", intent: "warmer", target: null, prompt: "prompt" };

  test("append assigns an id and queued status", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const [request] = await readRequests(root);
    expect(request).toMatchObject({ title: "Aurora", id: expect.any(String), status: "queued" });
  });

  test("collect marks requests picked-up and persists", async () => {
    const root = cwd();
    await appendRequest(root, input);
    const collected = await collectRequests(root);
    expect(collected[0]?.status).toBe("picked-up");
    expect((await readRequests(root))[0]?.status).toBe("picked-up");
  });

  test("collecting an empty queue leaves no trace on disk", async () => {
    const root = cwd();
    expect(await collectRequests(root)).toEqual([]);
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });

  test("reads legacy entries with a stable fallback id", async () => {
    const root = cwd();
    const queue = join(root, ".leglas/requests.json");
    mkdirSync(join(root, ".leglas"));
    writeFileSync(queue, JSON.stringify({ requests: [input] }));
    // A request written before the two modes existed rewrote the direction in
    // place, so that is what it is read back as. Nothing is written to say so:
    // the file on disk is left exactly as it was found.
    expect(await readRequests(root)).toEqual([
      { ...input, id: "0", mode: "replace", status: "queued" },
    ]);
    expect(JSON.parse(readFileSync(queue, "utf8"))).toEqual({ requests: [input] });
  });

  test("clear drops the work that was collected", async () => {
    const root = cwd();
    await appendRequest(root, input);
    await collectRequests(root);

    expect(await clearRequests(root)).toEqual({ cleared: 1, pending: 0 });
    expect(await readRequests(root)).toEqual([]);
  });

  test("clear keeps a request that arrived while the agent was working", async () => {
    // The queue is a mailbox the user keeps typing into. An agent that clears
    // everything it did not collect throws away an ask it never saw, and the
    // user has no way of knowing: the toast said the request landed.
    const root = cwd();
    await appendRequest(root, input);
    await collectRequests(root);
    await appendRequest(root, { ...input, intent: "and darker" });

    expect(await clearRequests(root)).toEqual({ cleared: 1, pending: 1 });
    const left = await readRequests(root);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ intent: "and darker", status: "queued" });
  });

  test("clearing an empty queue leaves no trace on disk", async () => {
    const root = cwd();

    expect(await clearRequests(root)).toEqual({ cleared: 0, pending: 0 });
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });

  test("marking one picked-up leaves the others queued", async () => {
    const root = cwd();
    await appendRequest(root, input);
    await appendRequest(root, { ...input, title: "Ledger" });
    const [first] = await readRequests(root);

    expect(await markPickedUp(root, first?.id ?? "")).toBe(true);

    expect((await readRequests(root)).map((request) => request.status)).toEqual([
      "picked-up",
      "queued",
    ]);
  });

  test("marking an unknown id changes nothing", async () => {
    const root = cwd();
    await appendRequest(root, input);
    expect(await markPickedUp(root, "nope")).toBe(false);
    expect((await readRequests(root))[0]?.status).toBe("queued");
  });

  test("removing one request leaves everything queued behind it", async () => {
    const root = cwd();
    await appendRequest(root, input);
    await appendRequest(root, { ...input, title: "Ledger" });
    const [first] = await readRequests(root);

    expect(await removeRequest(root, first?.id ?? "")).toBe(true);

    expect((await readRequests(root)).map((request) => request.title)).toEqual(["Ledger"]);
  });

  test("removing an unknown id is a no-op, not an empty queue", async () => {
    const root = cwd();
    await appendRequest(root, input);
    expect(await removeRequest(root, "nope")).toBe(false);
    expect(await readRequests(root)).toHaveLength(1);
  });

  test("removing from a queue that was never written leaves no trace on disk", async () => {
    const root = cwd();
    expect(await removeRequest(root, "nope")).toBe(false);
    expect(existsSync(join(root, ".leglas"))).toBe(false);
  });
});

describe("terminal requests", () => {
  const cwd = () => mkdtempSync(join(tmpdir(), "leglas-terminal-"));
  const input = (title: string) => ({
    title,
    url: "/",
    intent: `change ${title}`,
    target: null,
    prompt: `prompt for ${title}`,
  });

  test("a verdict survives the process that wrote it", async () => {
    const root = cwd();
    await appendRequest(root, input("Poster"));
    const [queued] = await readRequests(root);
    expect(
      await markFailed(root, queued?.id ?? "", {
        code: "provider-overloaded",
        message: "Claude's provider was overloaded and gave up.",
      }),
    ).toBe(true);

    // Read back by a process that never saw the run, which is the whole point:
    // the interface used to say "your agent is on it" about this forever.
    const [stored] = await readRequests(root);
    expect(stored?.status).toBe("failed");
    expect(stored?.failure?.code).toBe("provider-overloaded");
    // A stop is its own state, so nothing downstream can read it as a failure
    // worth rerunning on the user's behalf.
    await markFailed(root, queued?.id ?? "", { code: "cancelled", message: "You stopped this run." });
    expect((await readRequests(root))[0]?.status).toBe("cancelled");
    expect(await markFailed(root, "nope", { code: "cancelled", message: "x" })).toBe(false);
  });

  test("a hand-edited verdict is dropped rather than trusted", async () => {
    const root = cwd();
    mkdirSync(join(root, ".leglas"), { recursive: true });
    writeFileSync(
      join(root, ".leglas/requests.json"),
      JSON.stringify({
        requests: [
          { id: "a", status: "failed", title: "A", url: "/", intent: "i", target: null, prompt: "p", failure: { code: "made-up", message: "hi" } },
          { id: "b", status: "wat", title: "B", url: "/", intent: "i", target: null, prompt: "p" },
        ],
      }),
    );
    const [first, second] = await readRequests(root);
    expect(first?.status).toBe("failed");
    expect(first?.failure).toBeUndefined();
    // An unknown status is queued, the way it always was.
    expect(second?.status).toBe("queued");
  });

  test("collection never hands an ended request to another agent", async () => {
    const root = cwd();
    await appendRequest(root, input("Stopped"));
    await appendRequest(root, input("Live"));
    const [stopped] = await readRequests(root);
    await markFailed(root, stopped?.id ?? "", { code: "cancelled", message: "You stopped this run." });

    // Asking for the change the user just stopped would be the worst possible
    // reading of the queue.
    expect((await collectRequests(root)).map((request) => request.title)).toEqual(["Live"]);
    const after = await readRequests(root);
    expect(after.map((request) => request.status)).toEqual(["cancelled", "picked-up"]);
  });

  test("clearing counts only what is still waiting as pending", async () => {
    const root = cwd();
    await appendRequest(root, input("Failed"));
    await appendRequest(root, input("Waiting"));
    const [broken] = await readRequests(root);
    await markFailed(root, broken?.id ?? "", { code: "agent-error", message: "Codex exited with code 1." });

    // The failed one is finished with, not outstanding work, so it is swept up
    // rather than reported as still pending.
    expect(await clearRequests(root)).toEqual({ cleared: 1, pending: 1 });
    expect((await readRequests(root)).map((request) => request.title)).toEqual(["Waiting"]);
  });
});
