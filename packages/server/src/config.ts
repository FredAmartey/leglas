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
  /**
   * A project-relative HTML file to preview instead of a URL. Leglas serves
   * the file's directory itself, so a project with no dev server at all can
   * still compare directions: the greenfield case. The url is filled in at
   * boot, exactly as a branch preview's is.
   */
  file?: string | undefined;
  /**
   * The title of the direction this preview is a shade of. The rail groups a
   * direction with its shades and a shade's default comparison is its parent.
   * Purely descriptive: an unknown title makes the preview an ordinary root.
   */
  basedOn?: string | undefined;
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

export type NormalizeOptions = {
  /**
   * The shared config must pair a branch preview with a devCommand, or the
   * checkout cannot be started. The local previews file is validated without
   * that coupling, because its devCommand lives in the shared config.
   */
  requireDevCommand?: boolean;
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
 * A preview file is served from inside the project, so anything absolute or
 * climbing out of it is refused before it can name a file it should not.
 */
function isSafePreviewFile(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]/).some((segment) => segment === "..");
}

/**
 * Validate and fill in a raw config. Collects every problem rather than
 * stopping at the first, so one run fixes the whole file, and returns a null
 * config when anything is wrong so callers cannot half-use a broken one.
 */
export function normalizeConfig(raw: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const requireDevCommand = options.requireDevCommand ?? true;
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
    const file = entry["file"];

    if (typeof title !== "string" || title.trim() === "") {
      errors.push(`${at} needs a title; the rail has nothing to show without one.`);
    } else if (seenTitles.has(title)) {
      errors.push(`${at} repeats the title ${JSON.stringify(title)}; titles must be unique.`);
    } else {
      seenTitles.add(title);
    }

    if (file !== undefined) {
      // A file preview's url is Leglas's to assign at boot; declaring one too
      // would make the entry claim two different sources.
      if (typeof file !== "string" || !isSafePreviewFile(file)) {
        errors.push(
          `${at} has an unusable file ${JSON.stringify(file)}; use a path inside the project, like "directions/hero.html".`,
        );
      }
      if (url !== undefined) {
        errors.push(`${at} names a file and a url; a file preview's url is assigned by Leglas.`);
      }
    } else if (typeof url !== "string" || url.trim() === "") {
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
      if (file !== undefined) {
        errors.push(
          `${at} names a branch and a file; a file preview is served by Leglas itself and has no checkout.`,
        );
      }
    }

    const basedOn = entry["basedOn"];
    if (basedOn !== undefined && (typeof basedOn !== "string" || basedOn.trim() === "")) {
      errors.push(`${at} has a basedOn that is not a direction title.`);
    }

    const tags = entry["tags"];
    previews.push({
      title: typeof title === "string" ? title : "",
      url: typeof url === "string" ? url : "",
      note: typeof entry["note"] === "string" ? entry["note"] : undefined,
      tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
      ...(typeof branch === "string" ? { branch } : {}),
      ...(typeof file === "string" ? { file } : {}),
      ...(typeof basedOn === "string" && basedOn.trim() !== "" ? { basedOn } : {}),
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
  if (
    requireDevCommand &&
    previews.some((preview) => preview.branch !== undefined) &&
    devCommand === undefined
  ) {
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
