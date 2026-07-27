export const DEFAULT_DEV_SERVER = "http://localhost:3000";

/** Enough to install a fresh checkout with the package manager most repos use. */
export const DEFAULT_INSTALL_COMMAND = "npm install";

export type Preview = {
  title: string;
  url: string;
  note: string | undefined;
  tags: readonly string[];
  /**
   * A git branch to preview instead of the running dev server. Leglas creates a
   * worktree for it and starts the app there, so the preview is a URL on
   * another port. Undefined for the ordinary case, where the URL points at the
   * server the user already has running.
   */
  branch?: string | undefined;
};

export type LeglasConfig = {
  devServer: string;
  previews: Preview[];
  /** How to start the app in a checkout Leglas manages. `{port}` is required. */
  devCommand: string | undefined;
  installCommand: string;
};

export type NormalizeResult = {
  config: LeglasConfig | null;
  errors: string[];
};

/** Zero-config: with no file, preview the app root and let the user add the rest live. */
const IMPLICIT_PREVIEW = { title: "App", url: "/" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Branch names become directory names under .leglas/worktrees, so anything that
 * could climb out of it or be read as a flag is refused.
 */
function isSafeBranch(value: string): boolean {
  if (value === "" || value.startsWith("-")) return false;
  if (value.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

/**
 * A preview URL is either root-relative (served through the proxy, same-origin
 * with the shell) or absolute (loaded directly, subject to the target's frame
 * policy). A bare "pricing" is neither and would resolve unpredictably.
 */
function isValidPreviewUrl(value: string): boolean {
  return value.startsWith("/") || isValidOrigin(value);
}

/**
 * Validate and fill in a raw config. Collects every problem rather than
 * stopping at the first, so one run fixes the whole file, and returns a null
 * config when anything is wrong so callers cannot half-use a broken one.
 */
export function normalizeConfig(raw: unknown): NormalizeResult {
  const errors: string[] = [];
  const source = raw === undefined || raw === null ? {} : raw;

  if (!isRecord(source)) {
    return { config: null, errors: ["Config must export an object."] };
  }

  const devServer = source["devServer"] ?? DEFAULT_DEV_SERVER;
  if (typeof devServer !== "string" || !isValidOrigin(devServer)) {
    errors.push(
      `devServer must be an http(s) URL, received ${JSON.stringify(devServer)}.`,
    );
  }

  const rawPreviews = source["previews"] ?? [IMPLICIT_PREVIEW];
  if (!Array.isArray(rawPreviews)) {
    errors.push(`previews must be an array, received ${JSON.stringify(rawPreviews)}.`);
    return { config: null, errors };
  }

  const previews: Preview[] = [];
  const seenTitles = new Set<string>();

  rawPreviews.forEach((entry, index) => {
    const at = `previews[${index}]`;

    if (!isRecord(entry)) {
      errors.push(`${at} must be an object.`);
      return;
    }

    const title = entry["title"];
    const url = entry["url"];

    if (typeof title !== "string" || title.trim() === "") {
      errors.push(`${at} needs a title; the rail has nothing to show without one.`);
    } else if (seenTitles.has(title)) {
      errors.push(`${at} repeats the title ${JSON.stringify(title)}; titles must be unique.`);
    } else {
      seenTitles.add(title);
    }

    if (typeof url !== "string" || url.trim() === "") {
      errors.push(`${at} needs a url.`);
    } else if (!isValidPreviewUrl(url)) {
      errors.push(
        `${at} has url ${JSON.stringify(url)}; use a root-relative path ("/pricing") or a full URL.`,
      );
    }

    const branch = entry["branch"];
    if (branch !== undefined) {
      if (typeof branch !== "string" || !isSafeBranch(branch)) {
        errors.push(
          `${at} has an unusable branch ${JSON.stringify(branch)}; use a plain git branch name.`,
        );
      } else if (typeof url === "string" && !url.startsWith("/")) {
        errors.push(
          `${at} names a branch and an absolute url; a branch preview is served by Leglas, so its url must be a path.`,
        );
      }
    }

    const tags = entry["tags"];
    previews.push({
      title: typeof title === "string" ? title : "",
      url: typeof url === "string" ? url : "",
      note: typeof entry["note"] === "string" ? entry["note"] : undefined,
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
      ...(typeof branch === "string" ? { branch } : {}),
    });
  });

  const devCommand = source["devCommand"];
  if (devCommand !== undefined && typeof devCommand !== "string") {
    errors.push("devCommand must be a string.");
  } else if (typeof devCommand === "string" && !devCommand.includes("{port}")) {
    errors.push(
      `devCommand must include {port}, so Leglas can start each checkout on a free port. Received ${JSON.stringify(devCommand)}.`,
    );
  }

  // A branch preview cannot be served without knowing how to start the app.
  if (previews.some((preview) => preview.branch !== undefined) && devCommand === undefined) {
    errors.push(
      "A preview names a branch, so devCommand is required: Leglas has to start that checkout itself.",
    );
  }

  const installCommand = source["installCommand"] ?? DEFAULT_INSTALL_COMMAND;
  if (typeof installCommand !== "string" || installCommand.trim() === "") {
    errors.push("installCommand must be a non-empty string.");
  }

  if (errors.length > 0) return { config: null, errors };

  return {
    config: {
      devServer: devServer as string,
      previews,
      devCommand: typeof devCommand === "string" ? devCommand : undefined,
      installCommand: installCommand as string,
    },
    errors: [],
  };
}
