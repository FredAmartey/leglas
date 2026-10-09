import { describe, expect, test } from "vitest";

import type { PendingRequest } from "../requests/requests.js";
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
    expect(commandFor({ command: "aider", args: ["--message"] }, "make it warmer")).toEqual({
      command: "aider",
      args: ["--message", "make it warmer"],
    });
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

  test("keeps a quoted value together as one token, in either quote", () => {
    expect(template('codex exec --config "model reasoning=high" {prompt}')).toEqual({
      command: "codex",
      args: ["exec", "--config", "model reasoning=high", "{prompt}"],
    });
    expect(template("agent --note 'two words' {prompt}").args).toEqual([
      "--note",
      "two words",
      "{prompt}",
    ]);
    // Attached to a word, the quoted section joins it.
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
  test("puts the whole prompt in one argv entry, whatever it contains", () => {
    const { command, args } = commandFor(template("claude -p {prompt}"), "line one\nline two");

    expect(command).toBe("claude");
    expect(args).toEqual(["-p", "line one\nline two"]);

    // Shell punctuation stays exactly as it is.
    const prompt = 'make it warmer; rm -rf $HOME && echo "done" `whoami`';

    expect(commandFor(template("claude -p {prompt}"), prompt).args).toEqual(["-p", prompt]);
  });
});

describe("nextRequest", () => {
  test("takes the first queued request in order, skipping any that already failed", () => {
    const requests = [request({ id: "a" }), request({ id: "b" })];

    expect(nextRequest(requests, new Set())?.id).toBe("a");
    // A failed one is not run again, rather than burning tokens on it.
    expect(nextRequest(requests, new Set(["a"]))?.id).toBe("b");
    expect(nextRequest(requests, new Set(["a", "b"]))).toBeNull();
  });

  test("leaves a picked-up request alone, since another agent has it", () => {
    expect(nextRequest([request({ id: "a", status: "picked-up" })], new Set())).toBeNull();
  });
});
