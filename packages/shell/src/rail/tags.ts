/**
 * Tag pills colour themselves from their text: bright accents spaced around the
 * wheel at one saturation, so no tag outranks another. Same text, same colour
 * every session, no palette to configure. No amber, which means "duplicate"
 * here.
 */
const TAG_TONES = ["#34D399", "#38BDF8", "#818CF8", "#C084FC", "#FB7185", "#FB923C"] as const;

export function tagTone(tag: string) {
  let hash = 0;

  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const tone = TAG_TONES[Math.abs(hash) % TAG_TONES.length] ?? TAG_TONES[0];

  // Full-strength text on a 13% wash of itself, so the pill glows a little on
  // the dark rail.
  return { backgroundColor: `${tone}22`, color: tone };
}
