/**
 * Below this, a page has not drawn anything worth comparing.
 *
 * A single-page app serves one near-empty shell for every URL and fills it in
 * the browser. Reading it too early, or reading one that never fills, would
 * make every direction look identical.
 */
const MEANINGFUL_TEXT = 12;

/**
 * What a preview actually drew.
 *
 * The earlier version of this compared what the server sent, which cannot work
 * for a client-rendered app: the server returns the same shell for every URL
 * and the direction is chosen in the browser. Every direction looked identical
 * and the check had to be silenced, which meant it never fired for the apps
 * most likely to need it.
 *
 * Comparing the rendered page fixes that and is the more honest rule anyway.
 * Two previews are the same when they look the same, which is the claim being
 * made on screen.
 *
 * Text, structure, and paint together. Text alone would call two very
 * different layouts of the same copy identical; structure alone would call
 * two different headlines in the same layout identical; and without paint,
 * deliberate colour variants of one direction were flagged as duplicates, which
 * they visibly are not. An accidental duplicate renders identical colours
 * along with identical words, so it stays caught.
 */
export function renderedSignature(
  text: string,
  tags: readonly string[],
  paint: readonly string[] = [],
): string | null {
  const normalised = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalised.length < MEANINGFUL_TEXT) return null;
  return `${tags.join(">")} ${normalised} ${paint.join("|")}`.trimEnd();
}

/** The style values that carry a page's colour, per sampled element. */
export type PaintStyle = { backgroundColor: string; backgroundImage: string; color: string };

/**
 * Elements that render nothing and so cannot be the page surface. Vite puts
 * its module script inside body, so every app it serves has one of these
 * beside the root; counting them as branches would end the descent at the
 * body, whose colour says nothing.
 */
const UNPAINTED = new Set(["LINK", "META", "NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);

type PaintNode = { children: ArrayLike<unknown>; tagName?: string };

/**
 * The colours a page is painted with, sampled where apps actually put them.
 *
 * The page surface is rarely the body: a React app nests body > root div >
 * page element, and the gradient or background sits on that inner element.
 * Descending while there is exactly one rendered child unwraps those wrappers
 * without ever guessing at app structure, and sampling every level on the way
 * catches the surface wherever it is. Depth is capped so a pathological chain
 * cannot make this expensive.
 */
export function paintSample(
  body: PaintNode | null,
  styleOf: (element: unknown) => PaintStyle,
): string[] {
  if (!body) return [];
  const samples: string[] = [];
  let current: PaintNode = body;
  for (let depth = 0; depth < 4; depth += 1) {
    const style = styleOf(current);
    samples.push(`${style.backgroundColor};${style.backgroundImage};${style.color}`);
    const rendered = Array.from(current.children as ArrayLike<PaintNode>).filter(
      (child) => !UNPAINTED.has(child.tagName ?? ""),
    );
    const only = rendered.length === 1 ? rendered[0] : undefined;
    if (only === undefined) break;
    current = only;
  }
  return samples;
}

/** For each preview, the others that drew the same page. */
export function twinsOf(signatures: Record<string, string | null>): Record<string, string[]> {
  const bySignature = new Map<string, string[]>();
  for (const [title, signature] of Object.entries(signatures)) {
    if (signature === null) continue;
    const group = bySignature.get(signature);
    if (group) group.push(title);
    else bySignature.set(signature, [title]);
  }

  const twins: Record<string, string[]> = {};
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    for (const title of group) {
      twins[title] = group.filter((other) => other !== title);
    }
  }
  return twins;
}
