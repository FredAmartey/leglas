import { useState } from "react";

import { P, PIcon } from "../ui/kit.js";

/** The rail's search field, with the chord that reaches it shown until it is in use. */
export function Search({
  cap,
  inputRef,
  onQuery,
  query,
}: {
  /** The chord as written on this platform's keyboard. */
  cap: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  query: string;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <div className="px-3 pb-1 pt-2">
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#D1D5DB]">
          <PIcon d={P.search} />
        </span>
        {/* The hint steps aside once the field is in use, so it never sits
            behind the typing. */}
        <kbd
          className={`pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-[#232328] bg-[#2E2E2E]/60 px-1.5 py-0.5 font-sans text-[10px] leading-none tracking-wide text-[#84848C] transition-opacity duration-150 motion-reduce:transition-none ${
            query || focused ? "opacity-0" : "opacity-100"
          }`}
        >
          {cap}
        </kbd>
        <input
          aria-label="Search directions"
          className="w-full rounded-md border border-[#232328] bg-[#2E2E2E]/40 py-1.5 pl-7 pr-16 text-xs text-white placeholder:text-[#E8EAED] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/60"
          onBlur={() => setFocused(false)}
          onFocus={() => setFocused(true)}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;

            if (query) onQuery("");
            else event.currentTarget.blur();
          }}
          placeholder="Search directions…"
          ref={inputRef}
          type="text"
          value={query}
        />
      </div>
    </div>
  );
}
