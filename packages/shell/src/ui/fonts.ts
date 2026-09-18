/**
 * The typefaces the interface can wear. A user preference, not a design
 * variant: it changes the chrome and never a direction.
 */
export const FONTS = [
  { key: "satoshi", label: "Satoshi", stack: "var(--font-satoshi)" },
  { key: "outfit", label: "Outfit", stack: "var(--font-outfit)" },
  { key: "geist", label: "Geist", stack: "var(--font-geist)" },
] as const;
