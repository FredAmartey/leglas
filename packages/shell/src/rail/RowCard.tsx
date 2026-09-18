import { provenanceOf } from "../lineage/provenance.js";
import type { Preview } from "../types.js";
import { Tip } from "../ui/kit.js";

/**
 * What the rail cannot fit, on hover: the note in full, and the origin under
 * a rule. Only there when there is something to say.
 *
 * The rail asks for a card on every row and gets one on the few rows that
 * record where they came from. Wrapping unconditionally and letting the label
 * be empty would open an empty bubble on every hover, which is how a surface
 * teaches people to ignore it.
 *
 * The note is repeated deliberately. It is clamped to two lines in the row,
 * and the moment someone hovers a row to ask what it is, the truncated half
 * is the half they wanted. `basedOn` holds the parent's title as it was at
 * registration, so it is resolved through the same rename map the rail uses
 * or a renamed parent is named twice, differently, on one screen.
 */
export function RowCard({
  children,
  displayName,
  name,
  preview,
  quiet,
}: {
  children: React.ReactNode;
  displayName: (title: string) => string;
  name: string;
  preview: Preview | undefined;
  /** Hold the card back, for a row that is busy being renamed. */
  quiet: boolean;
}) {
  const origin = quiet ? null : provenanceOf(preview);
  if (origin === null) return <>{children}</>;

  return (
    <Tip
      label={
        <>
          <span className="block text-white">{name}</span>
          {preview?.note ? (
            <span className="mt-0.5 block font-normal text-[#D1D5DB]">{preview.note}</span>
          ) : null}
          <span className="mt-1.5 block border-t border-white/10 pt-1.5 font-normal text-[#84848C]">
            {origin.basedOn === null ? null : (
              <span className="block">Variant of {displayName(origin.basedOn)}</span>
            )}
            {origin.askedFor === null ? null : (
              <span className="mt-0.5 block">You asked for “{origin.askedFor}”</span>
            )}
          </span>
        </>
      }
      side="right"
      wide
    >
      {children}
    </Tip>
  );
}
