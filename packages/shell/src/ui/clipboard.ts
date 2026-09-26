/**
 * Copying, and knowing whether it happened. `navigator.clipboard` is missing
 * outside a secure context, as when the shell is opened from a phone on the
 * LAN, and rejects when the document isn't focused or permission is refused.
 * So: the real clipboard, then the deprecated command, then an honest failure,
 * on which the caller shows the link.
 */
export type CopyOutcome = "blocked" | "copied";

export type CopyDeps = {
  clipboard?: { writeText: (text: string) => Promise<void> } | undefined;
  legacy?: ((text: string) => boolean) | undefined;
};

/** A hidden field, selected and copied: the only path in an insecure context. */
export function execCopy(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(field);
  field.select();

  try {
    return document.execCommand("copy");
  } finally {
    field.remove();
  }
}

export function browserCopy(): CopyDeps {
  return {
    clipboard: typeof navigator === "undefined" ? undefined : navigator.clipboard,
    legacy: typeof document === "undefined" ? undefined : execCopy,
  };
}

export async function copyText(text: string, deps: CopyDeps = browserCopy()): Promise<CopyOutcome> {
  if (deps.clipboard) {
    try {
      await deps.clipboard.writeText(text);

      return "copied";
    } catch {
      // Denied or unfocused; the legacy path is sometimes still allowed, so
      // fall through.
    }
  }

  try {
    if (deps.legacy?.(text)) return "copied";
  } catch {
    // A browser that has removed the command entirely.
  }

  return "blocked";
}
