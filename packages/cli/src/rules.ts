import type { AddPreview, ShareReach, ShareTunnel } from "./args.js";

/**
 * What a command accepts beyond the shape of its arguments, for the parser and
 * the MCP tools alike. Syntax stays with the parser: unknown flags, missing
 * values, numbers that are not numbers.
 */

export const MIN_PORT = 1;

export const MAX_PORT = 65535;

export const MIN_SHOW_WIDTH = 320;

export const MAX_SHOW_WIDTH = 3840;

export const DEFAULT_EXPLORE_COUNT = 3;

export const DEFAULT_SHARE_REACH: ShareReach = "open";

export function portRefusal(flag: string, port: number): string | null {
  return port < MIN_PORT || port > MAX_PORT
    ? `${flag} must be between ${MIN_PORT} and ${MAX_PORT}, received ${port}.`
    : null;
}

export function valueRefusal(flag: string): string {
  return `${flag} needs a value.`;
}

/**
 * A preview needs something to show, and every text it carries has to say
 * something: an empty note or tag is a slip, not a choice.
 */
export function addRefusal(preview: AddPreview): string | null {
  const texts: [flag: string, value: string | undefined][] = [
    ["--title", preview.title],
    ["--url", preview.url],
    ["--note", preview.note],
    ["--branch", preview.branch],
    ["--file", preview.file],
    ["--based-on", preview.basedOn],
    ["--asked-for", preview.askedFor],
    ...(preview.tags ?? []).map((tag): [string, string] => ["--tag", tag]),
  ];

  const empty = texts.find(([, value]) => value === "");

  if (empty !== undefined) return valueRefusal(empty[0]);

  if (preview.url === undefined && preview.file === undefined) {
    return "leglas add needs --url (for example --url '/?v-hero=aurora') or --file for a page Leglas serves itself.";
  }

  return null;
}

/**
 * Stopping takes nothing that would start a share, and a share holds one
 * direction or a pair. Reach counts only when it was asked for, since it has
 * a default.
 */
export function shareRefusal(options: {
  titles: readonly string[];
  reach: ShareReach | undefined;
  tunnel: ShareTunnel | null;
  stop: boolean;
  rotate?: boolean;
  revoke?: string | null;
}): string | null {
  const acts = [
    options.stop && "--stop ends the share",
    options.rotate === true && "--rotate replaces every link",
    options.revoke !== undefined && options.revoke !== null && "--revoke ends one link",
  ].filter((act) => act !== false);

  if (acts.length > 1) {
    return "leglas share takes one of --stop, --rotate or --revoke at a time.";
  }

  const [act] = acts;

  if (
    act !== undefined &&
    (options.titles.length > 0 || options.reach !== undefined || options.tunnel !== null)
  ) {
    return `leglas share ${act}; it takes no directions, reach or tunnel.`;
  }

  if (options.titles.length > 2) {
    return "leglas share takes one direction to share alone, or two to compare. Name none to share the rail.";
  }

  return null;
}

export function linkRefusal(titles: readonly string[]): string | null {
  return titles.length > 2
    ? "leglas link takes one direction, or two to put side by side. Name none for the rail."
    : null;
}

export function widthRefusal(width: number): string | null {
  return width < MIN_SHOW_WIDTH || width > MAX_SHOW_WIDTH
    ? `--width must be between ${MIN_SHOW_WIDTH} and ${MAX_SHOW_WIDTH}, received ${width}.`
    : null;
}

/** A width or a port only means something for a screenshot. */
export function showRefusal(options: {
  screenshot: boolean;
  width: number | null;
  port: number | null;
}): string | null {
  if (options.width !== null && !options.screenshot) {
    return "leglas show --width needs --screenshot.";
  }

  if (options.port !== null && !options.screenshot) {
    return "leglas show --port needs --screenshot.";
  }

  return null;
}

export function fromRefusal(from: string | undefined): string | null {
  return from === "" ? "--from needs a path, for example --from src/Hero.tsx" : null;
}
