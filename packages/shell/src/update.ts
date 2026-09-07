import type { UpdateStatus } from "./types.js";

/**
 * What the update panel says, worked out from the server's status and the
 * interface's own side of a restart.
 *
 * The server knows the versions, how Leglas was installed and how far an
 * install has got. It cannot know that it has gone: once it restarts, the
 * interface is alone with a port that stops answering, so the waiting, the
 * reload and the giving up are the interface's to hold, and they live here
 * as `Wait` beside the status rather than inside it.
 */

/** How long the interface waits for a restarted Leglas before giving up on it. */
export const RESTART_WAIT_MS = 90_000;

/** Where the changelog lives, for a Leglas with nothing newer to point at. */
export const CHANGELOG_URL = "https://leglas.vercel.app/changelog/";

/**
 * Carried across the reload in sessionStorage, so the restarted interface
 * can say the update landed rather than opening as if nothing happened.
 */
export const UPDATED_KEY = "leglas:updated";

export type Wait =
  | { status: "none" }
  /** The server stopped answering after it said it was restarting. */
  | { status: "waiting"; version: string; since: number }
  /** Something answered on the port, and it is not the version that was installed. */
  | { status: "wrong"; version: string; got: string }
  /** Nothing answered in time. */
  | { status: "lost"; version: string };

export type UpdateView = {
  heading: string;
  /** The release's title from the changelog, under the heading. */
  title: string | null;
  detail: string | null;
  /** A quieter line under the detail: when it was checked, what version this is. */
  meta: string | null;
  /** What the primary action will do, or why there is none. */
  note: string | null;
  link: { label: string; url: string } | null;
  spinner: boolean;
  warning: boolean;
  primary: { label: string; action: "check" | "install"; disabled: boolean } | null;
  /** Whether to offer skipping the newest version. */
  skip: boolean;
};

/** A newer version that the person has not waved away. What the chip's dot means. */
export function hasNews(status: UpdateStatus | null): boolean {
  return (
    status !== null &&
    status.available &&
    status.latest !== null &&
    status.latest.version !== status.skipped
  );
}

/** The chip's tooltip: the version, or the news. */
export function chipLabel(status: UpdateStatus | null): string {
  if (status === null) return "Leglas";
  return hasNews(status) && status.latest !== null
    ? `${status.latest.version} is out`
    : `Leglas ${status.version}`;
}

/** "just now", "4 minutes ago", "3 hours ago", "yesterday", "5 days ago". */
export function ago(iso: string, now: number): string {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The install command with the version that will actually be installed in it. */
export function pinnedCommand(command: string, version: string): string {
  return command.replace("@latest", `@${version}`);
}

/** How to start Leglas again by hand, for when the restart did not come back. */
export function startAgain(status: UpdateStatus | null): string {
  if (status === null) return "npx leglas";
  switch (status.install.kind) {
    case "npx":
      return "npx leglas";
    case "project":
      return `${status.install.manager === "npm" ? "npx" : `${status.install.manager} exec`} leglas`;
    default:
      return "leglas";
  }
}

/** What pressing Update will do, in one line, or why it cannot be pressed. */
function updateNote(status: UpdateStatus, version: string): string | null {
  const { install } = status;
  if (install.kind === "source") return "You run Leglas from a checkout, so pull to update.";
  if (status.busy) return "Wait for the running change to finish, then update.";
  if (install.kind === "npx") return `Restarts Leglas with ${version}. Your rail stays as it is.`;
  if (install.command === null) return null;
  const where = install.kind === "project" ? " in this project" : "";
  return `Runs ${pinnedCommand(install.command, version)}${where}, then restarts Leglas. Your rail stays as it is.`;
}

export function updateView(
  status: UpdateStatus | null,
  wait: Wait,
  checking: boolean,
  now: number,
): UpdateView {
  const quiet: UpdateView = {
    heading: "Leglas",
    title: null,
    detail: null,
    meta: null,
    note: null,
    link: null,
    spinner: false,
    warning: false,
    primary: null,
    skip: false,
  };

  if (wait.status === "waiting") {
    return {
      ...quiet,
      heading: `Restarting Leglas`,
      detail: `This page reloads once ${wait.version} answers.`,
      spinner: true,
    };
  }
  if (wait.status === "wrong") {
    return {
      ...quiet,
      heading: "Something else answered",
      detail: `Leglas ${wait.got} is on this port now, not the ${wait.version} that was installed.`,
      note: `Start it again from your terminal: ${startAgain(status)}`,
      warning: true,
    };
  }
  if (wait.status === "lost") {
    return {
      ...quiet,
      heading: "Leglas did not come back",
      detail: `${wait.version} was installed, but nothing answered here.`,
      note: `Start it again from your terminal: ${startAgain(status)}`,
      warning: true,
    };
  }

  if (status === null) return { ...quiet, detail: "Reading…", spinner: true };

  const { phase } = status;
  if (phase.status === "installing") {
    return {
      ...quiet,
      heading: `Updating to ${phase.version}`,
      detail: `Installing with ${status.install.manager}…`,
      spinner: true,
    };
  }
  if (phase.status === "restarting") {
    return {
      ...quiet,
      heading: "Restarting Leglas",
      detail: `This page reloads once ${phase.version} answers.`,
      spinner: true,
    };
  }
  if (phase.status === "failed") {
    return {
      ...quiet,
      heading: `Could not update to ${phase.version}`,
      detail: phase.reason,
      note:
        status.install.command === null
          ? null
          : `Or run ${pinnedCommand(status.install.command, phase.version)} yourself.`,
      warning: true,
      primary: { label: "Try again", action: "install", disabled: status.busy },
    };
  }

  const busy = checking || phase.status === "checking";

  if (status.available && status.latest !== null) {
    const { latest } = status;
    const skipped = latest.version === status.skipped;
    const canInstall = status.install.kind !== "source";
    return {
      ...quiet,
      heading: `${latest.version} is out`,
      title: latest.title,
      detail: skipped ? "Skipped. Nothing will nag until the next release." : null,
      meta: `You have ${status.version}`,
      note: updateNote(status, latest.version),
      link: { label: "What's new", url: latest.url },
      primary: canInstall
        ? { label: skipped ? "Update anyway" : "Update", action: "install", disabled: status.busy }
        : null,
      skip: !skipped,
    };
  }

  const checked = status.checkedAt === null ? null : `Checked ${ago(status.checkedAt, now)}`;
  if (busy) {
    return {
      ...quiet,
      heading: status.version,
      detail: "Asking npm…",
      meta: checked,
      link: { label: "Changelog", url: CHANGELOG_URL },
      spinner: true,
      primary: { label: "Check again", action: "check", disabled: true },
    };
  }
  if (status.checkError !== null) {
    return {
      ...quiet,
      heading: status.version,
      detail: status.checkError,
      meta: checked === null ? null : `Last answer ${ago(status.checkedAt!, now)}`,
      link: { label: "Changelog", url: CHANGELOG_URL },
      warning: true,
      primary: { label: "Try again", action: "check", disabled: false },
    };
  }
  if (status.latest === null) {
    return {
      ...quiet,
      heading: status.version,
      detail: "Not checked yet.",
      link: { label: "Changelog", url: CHANGELOG_URL },
      primary: { label: "Check for updates", action: "check", disabled: false },
    };
  }
  return {
    ...quiet,
    heading: status.version,
    detail: "This is the latest version.",
    meta: checked,
    link: { label: "Changelog", url: CHANGELOG_URL },
    primary: { label: "Check again", action: "check", disabled: false },
  };
}
