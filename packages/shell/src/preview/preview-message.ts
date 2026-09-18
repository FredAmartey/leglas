export type PreviewMessageSignal = "error" | "ready";

/**
 * Parse the deliberately tiny protocol a same-origin preview can use to tell
 * the shell that its client-side setup has completed (or failed).
 */
export function previewMessageSignal(data: unknown): PreviewMessageSignal | null {
  if (typeof data !== "object" || data === null) return null;
  const type = Reflect.get(data, "type");
  if (type === "leglas:preview-ready") return "ready";
  if (type === "leglas:preview-error") return "error";
  return null;
}

/** Find a mounted preview by its WindowProxy, never by untrusted message data. */
export function previewFrameForSource(
  frames: Iterable<HTMLIFrameElement>,
  source: MessageEventSource | null,
): HTMLIFrameElement | null {
  if (source === null) return null;
  for (const frame of frames) {
    if (frame.contentWindow === source) return frame;
  }
  return null;
}
