/**
 * Copying, and knowing whether it actually happened.
 *
 * `navigator.clipboard` is missing outside a secure context, which is not a
 * hypothetical for a dev tool: open the shell from a phone on the same network
 * and the origin is a bare LAN address, so the async clipboard is simply not
 * there. It also rejects when the document is not focused or permission is
 * refused. Every one of those used to end in a promise nobody was listening
 * to, so the tick never appeared and nothing said why.
 *
 * So: try the real clipboard, fall back to the deprecated command that still
 * works where it doesn't, and report failure honestly when neither lands. The
 * caller shows the link when it comes back blocked, which is the only useful
 * thing left to offer.
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
      // Denied, or an unfocused document. The legacy path is sometimes still
      // allowed, so fall through rather than give up here.
    }
  }
  try {
    if (deps.legacy?.(text)) return "copied";
  } catch {
    // A browser that has removed the command entirely.
  }
  return "blocked";
}
