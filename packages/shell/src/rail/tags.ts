/**
 * Tag pills colour themselves from their text: bright accents spaced around
 * the wheel, all at the same saturation so no tag reads as more important
 * than another. The same text lands on the same colour every session, so
 * nobody configures a palette. Amber is left out; it means "duplicate" here.
 */
const TAG_TONES = ["#34D399", "#38BDF8", "#818CF8", "#C084FC", "#FB7185", "#FB923C"] as const;

export function tagTone(tag: string) {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const tone = TAG_TONES[Math.abs(hash) % TAG_TONES.length] ?? TAG_TONES[0];
  // Text at full strength on a 13% wash of itself, so the pill glows a
  // little against the dark rail instead of sitting flat on it.
  return { backgroundColor: `${tone}22`, color: tone };
}
