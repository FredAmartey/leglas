export type PreviewFrameWatcher = {
  frame: HTMLIFrameElement;
  onFailure: () => void;
  onReady: () => void;
  sameOrigin: boolean;
  timeoutMs: number;
};

export type LoadedPreviews = Readonly<Record<string, string>>;

/**
 * The document generation a loading verdict belongs to.
 *
 * A title alone is not an identity: an agent can replace its URL in place, and
 * a retry deliberately remounts the same URL. Keeping all three parts in the
 * key prevents either navigation from inheriting a completed older frame.
 */
export function previewIdentity(title: string, url: string, reload: number): string {
  return `${title}\u0000${url}\u0000${reload}`;
}

export function previewIsLoaded(
  loaded: LoadedPreviews,
  title: string,
  identity: string,
): boolean {
  return loaded[title] === identity;
}

export function markPreviewLoaded(
  loaded: LoadedPreviews,
  title: string,
  identity: string,
): Record<string, string> {
  return loaded[title] === identity ? loaded : { ...loaded, [title]: identity };
}

export function resetPreviewLoaded(
  loaded: LoadedPreviews,
  title: string,
): Record<string, string> {
  if (!(title in loaded)) return loaded;
  const next = { ...loaded };
  delete next[title];
  return next;
}

/**
 * A cached iframe may already be complete before a framework observes its
 * load event. Same-origin previews let us verify the real document directly.
 */
export function previewFrameIsReady(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument;
    return (
      doc !== null &&
      doc.location.href !== "about:blank" &&
      doc.readyState !== "loading"
    );
  } catch {
    return false;
  }
}

/**
 * Own one iframe navigation from mount to ready, failure, timeout or cleanup.
 *
 * The native listener covers ordinary navigation, the immediate readiness
 * check covers a cached load that completed before the listener attached and
 * the timeout performs one last readiness check before declaring failure.
 */
export function watchPreviewFrame({
  frame,
  onFailure,
  onReady,
  sameOrigin,
  timeoutMs,
}: PreviewFrameWatcher): () => void {
  let settled = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const cleanup = () => {
    frame.removeEventListener("load", onLoad);
    frame.removeEventListener("error", onError);
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };

  const ready = (allowOpaqueDocument: boolean) => {
    if (settled) return false;
    if (sameOrigin ? !previewFrameIsReady(frame) : !allowOpaqueDocument) {
      return false;
    }
    settled = true;
    cleanup();
    onReady();
    return true;
  };

  const fail = (checkDocumentFirst: boolean) => {
    if (settled) return;
    if (checkDocumentFirst && sameOrigin && ready(false)) return;
    settled = true;
    cleanup();
    onFailure();
  };

  function onLoad() {
    ready(!sameOrigin);
  }

  function onError() {
    fail(false);
  }

  frame.addEventListener("load", onLoad);
  frame.addEventListener("error", onError);
  timer = globalThis.setTimeout(() => fail(true), timeoutMs);

  // Close the cached-load race after the listeners and timeout both exist.
  if (sameOrigin) ready(false);

  return () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
}
