import { describe, expect, test } from "vitest";

import {
  CHANGELOG_URL,
  ago,
  chipLabel,
  hasNews,
  pinnedCommand,
  startAgain,
  updateView,
  type Wait,
} from "./update.js";
import type { UpdateStatus } from "../types.js";

const NOW = Date.parse("2026-09-07T12:00:00Z");

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    version: "1.0.0",
    install: { kind: "global", manager: "npm", command: "npm i -g leglas@latest" },
    latest: null,
    checkedAt: null,
    checkError: null,
    skipped: null,
    available: false,
    phase: { status: "idle" },
    busy: false,
    ...over,
  };
}

const newer = {
  version: "1.1.0",
  title: "Share the rail with someone who has no repo",
  url: "https://leglas.vercel.app/changelog/#v1.1.0",
};

describe("ago", () => {
  test("rounds down to the unit a person would say", () => {
    expect(ago("2026-09-07T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-09-07T11:59:00Z", NOW)).toBe("1 minute ago");
    expect(ago("2026-09-07T11:16:00Z", NOW)).toBe("44 minutes ago");
    expect(ago("2026-09-07T09:10:00Z", NOW)).toBe("2 hours ago");
    expect(ago("2026-09-06T09:00:00Z", NOW)).toBe("yesterday");
    expect(ago("2026-09-01T09:00:00Z", NOW)).toBe("6 days ago");
    // An unreadable time is not a number on screen.
    expect(ago("never", NOW)).toBe("just now");
  });
});

describe("hasNews and the chip", () => {
  test("a newer version that was not skipped is news", () => {
    expect(hasNews(status({ latest: newer, available: true }))).toBe(true);
    expect(chipLabel(status({ latest: newer, available: true }))).toBe("1.1.0 is out");
  });

  test("a skipped version is not, and neither is being up to date", () => {
    expect(hasNews(status({ latest: newer, available: true, skipped: "1.1.0" }))).toBe(false);
    expect(hasNews(status({ latest: { ...newer, version: "1.0.0" } }))).toBe(false);
    expect(chipLabel(status())).toBe("Leglas 1.0.0");
    expect(chipLabel(null)).toBe("Leglas");
  });
});

describe("updateView", () => {
  const none: Wait = { status: "none" };

  const view = (over: Partial<UpdateStatus> | null, checking = false) =>
    updateView(over === null ? null : status(over), none, checking, NOW);

  const out = { latest: newer, available: true };

  test("with nothing newer: a spinner, then a check to run, its answer or why it failed", () => {
    // Before the first read.
    expect(view(null)).toMatchObject({ spinner: true, primary: null });
    expect(view({})).toMatchObject({
      heading: "1.0.0",
      detail: "Not checked yet.",
      primary: { label: "Check for updates", action: "check", disabled: false },
      link: { label: "Changelog", url: CHANGELOG_URL },
    });
    expect(
      view({ latest: { ...newer, version: "1.0.0" }, checkedAt: "2026-09-07T10:00:00Z" }),
    ).toMatchObject({
      detail: "This is the latest version.",
      meta: "Checked 2 hours ago",
      primary: { label: "Check again" },
      skip: false,
    });
    // A check in flight disables the button and says who it is asking.
    expect(view({}, true)).toMatchObject({
      detail: "Asking npm…",
      spinner: true,
      primary: { disabled: true },
    });
    // A failed check quotes the server's sentence and offers a retry.
    expect(
      view({ checkError: "Could not reach npm.", checkedAt: "2026-09-06T10:00:00Z" }),
    ).toMatchObject({
      detail: "Could not reach npm.",
      meta: "Last answer yesterday",
      warning: true,
      primary: { label: "Try again", action: "check", disabled: false },
    });
  });

  test("a newer version leads with it and says what Update will run", () => {
    expect(view(out)).toMatchObject({
      heading: "1.1.0 is out",
      title: newer.title,
      meta: "You have 1.0.0",
      note: "Runs npm i -g leglas@1.1.0, then restarts Leglas. Your rail stays as it is.",
      link: { label: "What's new", url: newer.url },
      primary: { label: "Update", action: "install", disabled: false },
      skip: true,
    });

    // Each install kind gets its own note.
    const note = (install: UpdateStatus["install"]) => view({ ...out, install }).note;

    expect(note({ kind: "npx", manager: "npm", command: "npx leglas@latest" })).toBe(
      "Restarts Leglas with 1.1.0 through npx. Your rail stays as it is.",
    );
    expect(note({ kind: "npx", manager: "pnpm", command: "pnpm dlx leglas@latest" })).toBe(
      "Restarts Leglas with 1.1.0 through pnpm dlx. Your rail stays as it is.",
    );
    expect(
      note({ kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/app" }),
    ).toBe(
      "Runs pnpm up leglas@1.1.0 in this project, then restarts Leglas. Your rail stays as it is.",
    );
    expect(
      view({ ...out, install: { kind: "source", manager: "npm", command: null } }),
    ).toMatchObject({
      note: "You run Leglas from a checkout, so pull to update.",
      primary: null,
      skip: true,
    });

    // A running change holds the button and says why.
    expect(view({ ...out, busy: true })).toMatchObject({
      primary: { disabled: true },
      note: "Wait for the running change to finish, then update.",
    });
    // A skipped version stays offered, without the skip.
    expect(view({ ...out, skipped: "1.1.0" })).toMatchObject({
      detail: "Skipped. Nothing will nag until the next release.",
      primary: { label: "Update anyway" },
      skip: false,
    });
  });

  test("an update under way shows its progress and nothing to press, and a failed one what to do", () => {
    const at = (phase: UpdateStatus["phase"]) => view({ ...out, phase });

    expect(at({ status: "installing", version: "1.1.0" })).toMatchObject({
      heading: "Updating to 1.1.0",
      detail: "Installing with npm…",
      spinner: true,
      primary: null,
    });
    expect(at({ status: "restarting", version: "1.1.0" })).toMatchObject({
      heading: "Restarting Leglas",
      detail: "This page reloads once 1.1.0 answers.",
    });
    expect(at({ status: "waiting", version: "1.1.0" })).toMatchObject({
      heading: "Updating to 1.1.0",
      detail: "Installed. Waiting for the running change to finish, then restarting.",
      spinner: true,
      primary: null,
    });
    expect(
      at({ status: "failed", version: "1.1.0", reason: "npm i -g leglas@1.1.0 exited 1." }),
    ).toMatchObject({
      heading: "Could not update to 1.1.0",
      detail: "npm i -g leglas@1.1.0 exited 1.",
      warning: true,
      primary: { label: "Try again", action: "install", disabled: false },
      note: "Or run npm i -g leglas@1.1.0 yourself.",
    });
  });

  test("the wait states win over whatever the last status said", () => {
    const gone = status({ ...out, phase: { status: "restarting", version: "1.1.0" } });
    const waiting = (wait: Wait) => updateView(gone, wait, false, NOW);

    expect(
      waiting({ status: "waiting", version: "1.1.0", since: NOW, until: NOW + 90_000 }),
    ).toMatchObject({ heading: "Restarting Leglas", spinner: true, primary: null });
    expect(waiting({ status: "lost", version: "1.1.0" })).toMatchObject({
      heading: "Leglas did not come back",
      note: "Look in the terminal: it may have started on another port. Otherwise start it again there with leglas.",
      warning: true,
    });
    expect(waiting({ status: "wrong", version: "1.1.0", got: "1.0.0" })).toMatchObject({
      heading: "Something else answered",
      detail: "Leglas 1.0.0 is on this port now, not the 1.1.0 that was installed.",
    });
  });
});

describe("the commands a person is told", () => {
  test("pinnedCommand names the version that will be installed", () => {
    expect(pinnedCommand("pnpm add -g leglas@latest", "1.1.0")).toBe("pnpm add -g leglas@1.1.0");
  });

  test("startAgain matches how Leglas was started", () => {
    const after = (install: UpdateStatus["install"]) => startAgain(status({ install }));

    expect(startAgain(null)).toBe("npx leglas");
    expect(after({ kind: "npx", manager: "npm", command: "npx leglas@latest" })).toBe("npx leglas");
    expect(after({ kind: "npx", manager: "bun", command: "bunx leglas@latest" })).toBe(
      "bunx leglas",
    );
    expect(after({ kind: "npx", manager: "yarn", command: "yarn dlx leglas@latest" })).toBe(
      "yarn dlx leglas",
    );
    expect(startAgain(status())).toBe("leglas");
    expect(
      after({ kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/app" }),
    ).toBe("pnpm exec leglas");
    expect(
      after({
        kind: "project",
        manager: "npm",
        command: "npm install leglas@latest",
        root: "/app",
      }),
    ).toBe("npx leglas");
  });
});
