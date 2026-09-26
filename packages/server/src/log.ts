import type { Attachment } from "./requests/attachments.js";
import type { Preview } from "./config/config.js";
import type { PendingRequest } from "./requests/requests.js";
import type { Annotation } from "./requests/annotations.js";

/** Where entries go unless a project says otherwise. */
export const DEFAULT_LOG_DIR = "design-log";

export type LogEntry = {
  /** `2026-08-27-hero`, the stem shared by the entry and its picture folder. */
  slug: string;
  markdown: string;
  /** Captures worth keeping, as `from` inside `.leglas/` and `to` beside the entry. */
  pictures: readonly { from: string; to: string }[];
};

export type LogInput = {
  surface: string;
  /** The winning direction's title, and the source file it became. */
  won: { title: string; to: string };
  previews: readonly Preview[];
  requests: readonly PendingRequest[];
  annotations: readonly Annotation[];
  /** Today, injected rather than read, so an entry is reproducible in a test. */
  date: string;
};

/** A filename that survives every filesystem and still reads as what it is. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "untitled"
  );
}

/**
 * The best picture of a direction: the last one sent to the agent for it, the
 * only render anyone captured. The latest wins, so a twice-changed direction
 * shows its later self.
 */
function frameFor(title: string, requests: readonly PendingRequest[]): Attachment | null {
  let found: Attachment | null = null;

  for (const request of requests) {
    if (request.title !== title) continue;

    for (const attachment of request.attachments ?? []) {
      if (attachment.kind === "frame") found = attachment;
    }
  }

  return found;
}

/**
 * The words typed about a direction that actually landed. A failed change is
 * listed once at the foot with why; listing it here too reads as though it
 * happened.
 */
function askedOf(title: string, requests: readonly PendingRequest[]): string[] {
  return requests.flatMap((request) =>
    request.title === title && request.status !== "failed" && request.intent.trim() !== ""
      ? [request.intent.trim()]
      : [],
  );
}

/**
 * One exploration, written down from what was about to be deleted by `leglas
 * keep`. Nothing is invented: a direction with no note gets no note, since an
 * embellished record can't be trusted. Markdown and PNGs so it reads in three
 * months without this tool, on GitHub or in a diff.
 */
export function composeEntry(input: LogInput): LogEntry {
  const slug = `${input.date}-${slugify(input.surface)}`;
  const pictures: { from: string; to: string }[] = [];
  const lines: string[] = [];

  lines.push(`# ${input.surface}, ${input.date}`);
  lines.push("");
  lines.push(
    `**${input.won.title}** won and became \`${input.won.to}\`. ` +
      `${input.previews.length === 1 ? "It was the only direction." : `${input.previews.length} directions were compared.`}`,
  );
  lines.push("");

  for (const preview of input.previews) {
    const won = preview.title === input.won.title;
    lines.push(`## ${preview.title}${won ? " — kept" : ""}`);
    lines.push("");

    if (preview.note !== undefined && preview.note.trim() !== "") {
      lines.push(preview.note.trim());
      lines.push("");
    }

    const frame = frameFor(preview.title, input.requests);

    if (frame !== null) {
      const name = `${slugify(preview.title)}.png`;
      pictures.push({ from: frame.file, to: name });
      lines.push(`![${preview.title}](${slug}/${name})`);
      lines.push("");
    }

    if (preview.basedOn !== undefined) {
      lines.push(`A variant of ${preview.basedOn}.`);
      lines.push("");
    }

    const asked = askedOf(preview.title, input.requests);

    if (asked.length > 0) {
      lines.push("Asked for:");
      lines.push("");

      for (const words of asked) lines.push(`- ${words}`);
      lines.push("");
    }

    const notes = input.annotations.filter((note) => note.title === preview.title);

    if (notes.length > 0) {
      lines.push("Marked on the design:");
      lines.push("");

      for (const note of notes) lines.push(`- ${note.note}`);
      lines.push("");
    }
  }

  const failed = input.requests.filter((request) => request.status === "failed");

  if (failed.length > 0) {
    lines.push("## Changes that did not land");
    lines.push("");

    for (const request of failed) {
      const why = request.failure?.message;
      lines.push(`- ${request.title}: ${request.intent}${why === undefined ? "" : ` (${why})`}`);
    }

    lines.push("");
  }

  return { slug, markdown: `${lines.join("\n").trimEnd()}\n`, pictures };
}
