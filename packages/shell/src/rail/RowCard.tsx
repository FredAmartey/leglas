import { provenanceOf } from "../lineage/provenance.js";
import type { Preview } from "../types.js";
import { Tip } from "../ui/kit.js";

/**
 * What the rail can't fit, on hover: the full note, and the origin under a
 * rule. Only when there's something to say, since an empty bubble on every
 * hover teaches people to ignore it. The note repeats because the row clamps it
 * to two lines, and the truncated half is what someone hovering wants.
 * `basedOn` holds the parent's registration title, so it's resolved through the
 * rail's rename map.
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
