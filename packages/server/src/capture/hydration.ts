export type HydrationEvidence = { framework: string; message: string };

/**
 * The first message saying the app rebuilt the page in the browser after load,
 * and which framework said it; null if none. An exception's description carries
 * the stack after its first line, and only that first line is kept.
 */
export function hydrationEvidence(messages: readonly string[]): HydrationEvidence | null {
  for (const raw of messages) {
    const message = raw.split("\n", 1)[0]?.trim() ?? "";

    if (/Minified React error #(418|419|422|423|425)\b/.test(message)) {
      return { framework: "React", message };
    }

    if (
      /Hydration failed because/.test(message) ||
      /error while hydrating/i.test(message) ||
      /Text content (did not|does not) match/i.test(message) ||
      /Expected server HTML to contain/i.test(message) ||
      /did not match\. Server:/.test(message)
    ) {
      return { framework: "React", message };
    }

    if (
      /Hydration (node|text|children|class|style|attribute) mismatch/i.test(message) ||
      /Hydration completed but contains mismatches/i.test(message)
    ) {
      return { framework: "Vue", message };
    }

    if (/hydration_mismatch/.test(message)) {
      return { framework: "Svelte", message };
    }

    if (/Hydration Mismatch\. Unable to find DOM nodes/.test(message)) {
      return { framework: "Solid", message };
    }

    // Anything else must say hydration and describe the markup it disagreed
    // with (expected against found, or a mismatch on a named part). A cache or
    // store also "rehydrates", which says nothing about the screen.
    if (
      /hydrat/i.test(message) &&
      (/expected .+ but found/i.test(message) ||
        (/mismatch/i.test(message) &&
          /(node|element|markup|dom|tag|text|attribute|server|client)/i.test(message)))
    ) {
      return { framework: "the app", message };
    }
  }

  return null;
}
