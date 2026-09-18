import type { ViewerInfo } from "../types.js";
import { LiveDot, Tip } from "../ui/kit.js";

/**
 * Whose rail this is, said once at the top and left there: a viewer should
 * never wonder why the composer is missing.
 */
export function ViewerBanner({ scope }: { scope: ViewerInfo["scope"] }) {
  return (
    <Tip
      label={
        <>
          <span className="block">Someone is sharing their Leglas with you, live.</span>
          <span className="block text-[#9CA3AF]">
            Flip, compare and change the width. Nothing you do reaches their machine.
          </span>
        </>
      }
      side="right"
      wide
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[#232328] bg-[#1E1E22] px-3 py-1.5">
        <LiveDot />
        <span className="text-[11px] text-[#D1D5DB]">Shared with you</span>
        <span className="ml-auto min-w-0 truncate text-[10px] text-[#84848C]">
          {scope === "rail"
            ? "the whole rail"
            : scope === "compare"
              ? "a comparison"
              : "one direction"}
        </span>
      </div>
    </Tip>
  );
}
