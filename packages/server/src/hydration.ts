export type HydrationEvidence = { framework: string; message: string };

/**
 * The first message that says the app rebuilt the page in the browser after
 * load, and which framework said it. Null when nothing did.
 *
 * An exception arrives as its description, which carries the stack under the
 * first line. The first line is the sentence; the rest is where it was thrown,
 * which the prompt and `leglas show` have no use for.
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
    // Anything else has to say hydration and describe the markup it disagreed
    // with: what it expected against what it found, or a mismatch on a named
    // part of the document. A cache or a store also "rehydrates", and a
    // persisted state that failed to rehydrate says nothing about the screen.
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
