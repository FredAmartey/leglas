import { describe, expect, test } from "vitest";

import { classifyFailure, sessionShaped, type FailureCode } from "./failure.js";

const verdict = (input: Parameters<typeof classifyFailure>[0]): FailureCode =>
  classifyFailure(input).code;

describe("classifyFailure", () => {
  test("what Leglas did itself outranks anything the agent said", () => {
    // A stop lands as a SIGTERM, and a dying CLI can print anything on its way
    // out. None of it changes who ended the run.
    expect(
      verdict({
        agent: "Claude",
        error: "cancelled",
        lines: ["API Error: 529 overloaded", "Not inside a trusted directory"],
      }),
    ).toBe("cancelled");
    expect(verdict({ agent: "Claude", error: "stopped by SIGTERM" })).toBe("stopped");
    expect(classifyFailure({ agent: "Claude", error: "cancelled" }).message).toBe(
      "You stopped this run.",
    );
  });

  test("a binary that never ran is not a provider problem", () => {
    expect(verdict({ agent: "Cursor", error: "spawn cursor-agent ENOENT" })).toBe("missing-agent");
    expect(verdict({ agent: "Cursor", error: "spawn cursor-agent EACCES" })).toBe("missing-agent");
  });

  test("codex's refusal of an untrusted directory is named as itself", () => {
    // Verbatim from codex-cli 0.147.0, run in a directory with no git repo.
    const failure = classifyFailure({
      agent: "Codex",
      exitCode: 1,
      lines: [
        "Reading additional input from stdin...",
        "Not inside a trusted directory and --skip-git-repo-check was not specified.",
      ],
    });
    expect(failure.code).toBe("needs-trust");
    expect(failure.message).toContain("not a git repository");
  });

  test("the vendor's own retry event decides an overload, a limit and a login", () => {
    // Shapes captured from claude stream-json against a local endpoint
    // returning each status.
    const retry = (status: number, reason: string) => ({
      agent: "Claude",
      exitCode: 1,
      retry: { attempt: 10, max: 10, status, reason },
    });
    expect(verdict(retry(529, "overloaded"))).toBe("provider-overloaded");
    expect(verdict(retry(401, "authentication_failed"))).toBe("not-signed-in");
    expect(verdict(retry(429, "rate_limit"))).toBe("provider-limit");
    expect(classifyFailure(retry(529, "overloaded")).message).toBe(
      "Claude's provider was overloaded and gave up. It retried 10 times first.",
    );
  });

  test("output carries the verdict when no retry event does", () => {
    expect(
      verdict({ agent: "Claude", exitCode: 1, lines: ["API Error: 529 Overloaded"] }),
    ).toBe("provider-overloaded");
    expect(
      verdict({ agent: "Codex", exitCode: 1, lines: ["stream error: 429 Too Many Requests"] }),
    ).toBe("provider-limit");
    expect(
      verdict({ agent: "Codex", exitCode: 1, lines: ["You are not logged in. Run codex login."] }),
    ).toBe("not-signed-in");
  });

  test("the last word wins, because that is the one it stopped for", () => {
    // A warning early in a run must not outrank the refusal that ended it.
    expect(
      verdict({
        agent: "Codex",
        exitCode: 1,
        lines: ["warning: 529 seen earlier, retrying", "Not inside a trusted directory"],
      }),
    ).toBe("needs-trust");
  });

  test("an agent that just exited gets an honest, quotable message", () => {
    const failure = classifyFailure({ agent: "Claude", exitCode: 2, lines: ["oh dear"] });
    expect(failure.code).toBe("agent-error");
    // The output stays in the terminal: a card is the wrong place for a log
    // that can carry a prompt, a path or a token.
    expect(failure.message).not.toContain("oh dear");
    expect(failure.message).toBe(
      "Claude exited with code 2. Its last output is in the Leglas terminal.",
    );
  });

  test("only a session-shaped failure earns a second run", () => {
    expect(sessionShaped("agent-error")).toBe(true);
    for (const code of [
      "cancelled",
      "stopped",
      "missing-agent",
      "not-signed-in",
      "provider-overloaded",
      "provider-limit",
      "needs-trust",
    ] as const) {
      expect([code, sessionShaped(code)]).toEqual([code, false]);
    }
  });
});
