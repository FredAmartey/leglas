import { describe, expect, test } from "vitest";

import type { PendingRequest } from "./requests.js";
import { commandFor, nextRequest, parseTemplate } from "./agent-command.js";

function template(raw: string) {
  const parsed = parseTemplate(raw);
  if (!parsed.ok) throw new Error(`expected a usable template, got ${parsed.error}`);
  return parsed.template;
}

function refusal(raw: string): string {
  const parsed = parseTemplate(raw);
  if (parsed.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`);
  return parsed.error;
}

const request = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  id: "a",
  status: "queued",
  title: "Aurora",
  url: "/?v-hero=aurora",
  intent: "warmer",
  target: ".leglas/variants/hero/aurora.tsx",
  prompt: "make it warmer",
  ...over,
});

describe("parseTemplate", () => {
  test("splits an agent command into argv, with no shell involved", () => {
    expect(template("claude -p {prompt}")).toEqual({ command: "claude", args: ["-p", "{prompt}"] });
  });

  test("accepts a command with no placeholder; the prompt rides along at the end", () => {
    expect(template("aider --message")).toEqual({ command: "aider", args: ["--message"] });
    expect(
      commandFor({ command: "aider", args: ["--message"] }, "make it warmer"),
    ).toEqual({ command: "aider", args: ["--message", "make it warmer"] });
    expect(commandFor({ command: "my-agent", args: [] }, "make it warmer")).toEqual({
      command: "my-agent",
      args: ["make it warmer"],
    });
  });

  test("refuses a placeholder glued to another word, which is always a typo for substitution", () => {
    const error = refusal("claude --message={prompt}");
    expect(error).toContain("{prompt}");
    expect(error.split("\n")).toHaveLength(1);
  });

  test("refuses a second placeholder rather than filling both", () => {
    expect(refusal("claude -p {prompt} {prompt}")).toContain("once");
  });

  test("refuses a placeholder used as the program itself", () => {
    expect(refusal("{prompt}")).toContain("program");
  });

  test("refuses an empty command", () => {
    expect(refusal("   ")).toContain("agent command");
  });

  test("keeps a double-quoted value together as one token", () => {
    expect(template('codex exec --config "model reasoning=high" {prompt}')).toEqual({
      command: "codex",
      args: ["exec", "--config", "model reasoning=high", "{prompt}"],
    });
  });

  test("takes single quotes too", () => {
    expect(template("agent --note 'two words' {prompt}").args).toEqual([
      "--note",
      "two words",
      "{prompt}",
    ]);
  });

  test("joins a quoted section to the word it is attached to", () => {
    expect(template('agent --note="two words" {prompt}').args).toEqual([
      "--note=two words",
      "{prompt}",
    ]);
  });

  test("refuses an unclosed quote instead of guessing where it ended", () => {
    expect(refusal('agent --note "two words {prompt}')).toContain("quote");
  });
});

describe("commandFor", () => {
  test("puts the whole prompt in one argv entry, however many words it has", () => {
    const { command, args } = commandFor(template("claude -p {prompt}"), "line one\nline two");

    expect(command).toBe("claude");
    expect(args).toEqual(["-p", "line one\nline two"]);
  });

  test("leaves a prompt full of shell punctuation exactly as it is", () => {
    const prompt = 'make it warmer; rm -rf $HOME && echo "done" `whoami`';

    expect(commandFor(template("claude -p {prompt}"), prompt).args).toEqual(["-p", prompt]);
  });

  test("carries a stub script through unchanged, which is how the loop is smoke tested", () => {
    const { command, args } = commandFor(
      template('node ./stub.js --out "run log.txt" {prompt}'),
      "make it warmer",
    );

    expect(command).toBe("node");
    expect(args).toEqual(["./stub.js", "--out", "run log.txt", "make it warmer"]);
  });
});

describe("nextRequest", () => {
  test("takes the first queued request, so the queue runs in order", () => {
    const requests = [request({ id: "a" }), request({ id: "b" })];

    expect(nextRequest(requests, new Set())?.id).toBe("a");
  });

  test("skips one that already failed, rather than burning tokens on it again", () => {
    const requests = [request({ id: "a" }), request({ id: "b" })];

    expect(nextRequest(requests, new Set(["a"]))?.id).toBe("b");
  });

  test("leaves a picked-up request alone, since another agent has it", () => {
    expect(nextRequest([request({ id: "a", status: "picked-up" })], new Set())).toBeNull();
  });

  test("has nothing to do with an empty queue", () => {
    expect(nextRequest([], new Set())).toBeNull();
  });

  test("returns nothing once every queued request has failed", () => {
    expect(nextRequest([request({ id: "a" })], new Set(["a"]))).toBeNull();
  });
});
