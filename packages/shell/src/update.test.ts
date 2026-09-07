import { describe, expect, test } from "vitest";

import {
  CHANGELOG_URL,
  ago,
  chipLabel,
  hasNews,
  pinnedCommand,
  startAgain,
  updateView,
} from "./update.js";
import type { UpdateStatus } from "./types.js";

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
  });

  test("an unreadable time is not a number on screen", () => {
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
  test("before the first read there is only a spinner", () => {
    const view = updateView(null, { status: "none" }, false, NOW);
    expect(view.spinner).toBe(true);
    expect(view.primary).toBeNull();
  });

  test("never checked offers a check", () => {
    const view = updateView(status(), { status: "none" }, false, NOW);
    expect(view.heading).toBe("1.0.0");
    expect(view.detail).toBe("Not checked yet.");
    expect(view.primary).toEqual({ label: "Check for updates", action: "check", disabled: false });
    expect(view.link).toEqual({ label: "Changelog", url: CHANGELOG_URL });
  });

  test("up to date says so and when it was checked", () => {
    const view = updateView(
      status({ latest: { ...newer, version: "1.0.0" }, checkedAt: "2026-09-07T10:00:00Z" }),
      { status: "none" },
      false,
      NOW,
    );
    expect(view.detail).toBe("This is the latest version.");
    expect(view.meta).toBe("Checked 2 hours ago");
    expect(view.primary?.label).toBe("Check again");
    expect(view.skip).toBe(false);
  });

  test("a check in flight disables the button and says who it is asking", () => {
    const view = updateView(status(), { status: "none" }, true, NOW);
    expect(view.detail).toBe("Asking npm…");
    expect(view.spinner).toBe(true);
    expect(view.primary?.disabled).toBe(true);
  });

  test("a failed check quotes the server's sentence and offers a retry", () => {
    const view = updateView(
      status({ checkError: "Could not reach npm.", checkedAt: "2026-09-06T10:00:00Z" }),
      { status: "none" },
      false,
      NOW,
    );
    expect(view.detail).toBe("Could not reach npm.");
    expect(view.meta).toBe("Last answer yesterday");
    expect(view.warning).toBe(true);
    expect(view.primary).toEqual({ label: "Try again", action: "check", disabled: false });
  });

  test("a newer version leads with it and says what Update will run", () => {
    const view = updateView(status({ latest: newer, available: true }), { status: "none" }, false, NOW);
    expect(view.heading).toBe("1.1.0 is out");
    expect(view.title).toBe(newer.title);
    expect(view.meta).toBe("You have 1.0.0");
    expect(view.note).toBe(
      "Runs npm i -g leglas@1.1.0, then restarts Leglas. Your rail stays as it is.",
    );
    expect(view.link).toEqual({ label: "What's new", url: newer.url });
    expect(view.primary).toEqual({ label: "Update", action: "install", disabled: false });
    expect(view.skip).toBe(true);
  });

  test("each install kind gets its own note", () => {
    const of = (install: UpdateStatus["install"]) =>
      updateView(status({ latest: newer, available: true, install }), { status: "none" }, false, NOW);
    expect(of({ kind: "npx", manager: "npm", command: "npx leglas@latest" }).note).toBe(
      "Restarts Leglas with 1.1.0. Your rail stays as it is.",
    );
    expect(
      of({ kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/app" }).note,
    ).toBe("Runs pnpm up leglas@1.1.0 in this project, then restarts Leglas. Your rail stays as it is.");
    const source = of({ kind: "source", manager: "npm", command: null });
    expect(source.note).toBe("You run Leglas from a checkout, so pull to update.");
    expect(source.primary).toBeNull();
    expect(source.skip).toBe(true);
  });

  test("a running change holds the button and says why", () => {
    const view = updateView(
      status({ latest: newer, available: true, busy: true }),
      { status: "none" },
      false,
      NOW,
    );
    expect(view.primary?.disabled).toBe(true);
    expect(view.note).toBe("Wait for the running change to finish, then update.");
  });

  test("a skipped version stays offered, without the skip", () => {
    const view = updateView(
      status({ latest: newer, available: true, skipped: "1.1.0" }),
      { status: "none" },
      false,
      NOW,
    );
    expect(view.detail).toBe("Skipped. Nothing will nag until the next release.");
    expect(view.primary?.label).toBe("Update anyway");
    expect(view.skip).toBe(false);
  });

  test("installing and restarting show progress and nothing to press", () => {
    const installing = updateView(
      status({ latest: newer, available: true, phase: { status: "installing", version: "1.1.0" } }),
      { status: "none" },
      false,
      NOW,
    );
    expect(installing.heading).toBe("Updating to 1.1.0");
    expect(installing.detail).toBe("Installing with npm…");
    expect(installing.spinner).toBe(true);
    expect(installing.primary).toBeNull();
    const restarting = updateView(
      status({ latest: newer, available: true, phase: { status: "restarting", version: "1.1.0" } }),
      { status: "none" },
      false,
      NOW,
    );
    expect(restarting.heading).toBe("Restarting Leglas");
    expect(restarting.detail).toBe("This page reloads once 1.1.0 answers.");
  });

  test("a failed install gives the reason, a retry and the command to run by hand", () => {
    const view = updateView(
      status({
        latest: newer,
        available: true,
        phase: { status: "failed", version: "1.1.0", reason: "npm i -g leglas@1.1.0 exited 1." },
      }),
      { status: "none" },
      false,
      NOW,
    );
    expect(view.heading).toBe("Could not update to 1.1.0");
    expect(view.detail).toBe("npm i -g leglas@1.1.0 exited 1.");
    expect(view.warning).toBe(true);
    expect(view.primary).toEqual({ label: "Try again", action: "install", disabled: false });
    expect(view.note).toBe("Or run npm i -g leglas@1.1.0 yourself.");
  });

  test("the wait states win over whatever the last status said", () => {
    const gone = status({ latest: newer, available: true, phase: { status: "restarting", version: "1.1.0" } });
    expect(updateView(gone, { status: "waiting", version: "1.1.0", since: NOW }, false, NOW)).toMatchObject({
      heading: "Restarting Leglas",
      spinner: true,
      primary: null,
    });
    expect(updateView(gone, { status: "lost", version: "1.1.0" }, false, NOW)).toMatchObject({
      heading: "Leglas did not come back",
      note: "Start it again from your terminal: leglas",
      warning: true,
    });
    expect(updateView(gone, { status: "wrong", version: "1.1.0", got: "1.0.0" }, false, NOW)).toMatchObject({
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
    expect(startAgain(null)).toBe("npx leglas");
    expect(startAgain(status({ install: { kind: "npx", manager: "npm", command: "npx leglas@latest" } }))).toBe("npx leglas");
    expect(startAgain(status())).toBe("leglas");
    expect(
      startAgain(status({ install: { kind: "project", manager: "pnpm", command: "pnpm up leglas@latest", root: "/app" } })),
    ).toBe("pnpm exec leglas");
    expect(
      startAgain(status({ install: { kind: "project", manager: "npm", command: "npm install leglas@latest", root: "/app" } })),
    ).toBe("npx leglas");
  });
});
