import { BrandMark, P, PIcon, ROW_BUTTON } from "../ui/kit.js";
import type { AgentEffort, AgentOption, ComposerAgent } from "./request-status.js";

const EFFORT_LABELS: Record<AgentEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/**
 * Who runs the changes, beside the send it configures. With no agent on the
 * machine it is the way to connect one over MCP; otherwise it is an inline
 * select: the menu hangs off the chip itself, sized to its options, the way a
 * model picker behaves in every composer people know.
 */
export function AgentPicker({
  agents,
  chip,
  chosenSignedOut,
  connectRef,
  menuRef,
  onConnect,
  onPick,
  onPickEffort,
  onRefresh,
  open,
  pickingAgent,
  savingEffort,
  selectedAgent,
  selectedEffort,
  setOpen,
  triggerRef,
}: {
  agents: readonly AgentOption[];
  chip: ComposerAgent;
  chosenSignedOut: boolean;
  connectRef: React.RefObject<HTMLButtonElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onConnect: () => void;
  onPick: (agent: string) => void;
  onPickEffort: (effort: AgentEffort | null) => void;
  /** Ask the CLIs about their logins again. */
  onRefresh: () => void;
  open: boolean;
  /** The agent whose choice is being saved, if one is. */
  pickingAgent: string | null;
  savingEffort: boolean;
  selectedAgent: AgentOption | undefined;
  selectedEffort: AgentEffort | null;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  return chip.kind === "none" ? (
    <button
      className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[10px] leading-none text-[#84848C] transition-colors duration-150 hover:bg-white/[0.04] hover:text-[#D1D5DB]"
      onClick={onConnect}
      ref={connectRef}
      type="button"
    >
      <PIcon d={P.link} size={12} />
      <span className="truncate">Connect agent via MCP…</span>
    </button>
  ) : (
    /* An inline select beside the send it configures: the menu
 hangs off the chip itself, sized to its options, the way
 a model picker behaves in every composer people know. */
    <div className="relative flex min-w-0 items-center">
      <div
        aria-hidden={!open}
        aria-label="Who runs your changes"
        className={`absolute bottom-full right-0 z-10 mb-1.5 w-max min-w-48 origin-bottom-right rounded-lg border border-[#232328] bg-[#1E1E22] p-1 text-[#D1D5DB] shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
          open
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-1 scale-95 opacity-0"
        }`}
        inert={!open}
        ref={menuRef}
        role="dialog"
        tabIndex={-1}
      >
        {agents
          .filter((agent) => agent.available)
          .map((agent) => {
            const active = chip.kind === "chosen" && agent.id === chip.id;
            return (
              <button
                className={ROW_BUTTON}
                disabled={pickingAgent !== null || savingEffort}
                key={agent.id}
                onClick={() => (active ? setOpen(false) : onPick(agent.id))}
                type="button"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <BrandMark id={agent.id} />
                  <span className="truncate">{agent.name}</span>
                </span>
                {pickingAgent === agent.id ? (
                  <span
                    aria-label="selecting"
                    className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
                  />
                ) : agent.auth === "signed-out" ? (
                  /* Caught before the run instead of after
               it: the CLI itself says its login is
               gone, and hiding the row would only
               hide the fix. */
                  <span className="text-[10px] text-amber-400/80">signed out</span>
                ) : (
                  active && <span aria-label="current choice">✓</span>
                )}
              </button>
            );
          })}
        {chip.kind === "chosen" && chip.id === "custom" ? (
          <button className={ROW_BUTTON} onClick={() => setOpen(false)} type="button">
            <span className="flex min-w-0 items-center gap-2">
              <BrandMark id="custom" />
              <span className="truncate">{chip.name}</span>
            </span>
            <span aria-label="current choice">✓</span>
          </button>
        ) : null}
        {selectedAgent !== undefined && selectedAgent.efforts.length > 0 ? (
          <div className="mt-1 border-t border-[#232328] px-1 pb-0.5 pt-1.5">
            <label className="flex min-h-7 items-center justify-between gap-3">
              <span className="text-[10px] font-medium text-[#84848C]">Effort</span>
              <select
                aria-busy={savingEffort}
                aria-label={`${selectedAgent.name} effort`}
                className="min-h-7 rounded-md border border-[#303038] bg-[#17171B] px-2 text-[10px] text-[#D1D5DB] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
                disabled={savingEffort || pickingAgent !== null}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onPickEffort(value === "" ? null : (value as AgentEffort));
                }}
                value={selectedEffort ?? ""}
              >
                <option value="">Agent default</option>
                {selectedAgent.efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {EFFORT_LABELS[effort]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <div className="mt-1 border-t border-[#232328] pt-1">
          <button
            className={`${ROW_BUTTON} text-[#84848C]`}
            onClick={() => {
              setOpen(false);
              onConnect();
            }}
            ref={connectRef}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <PIcon d={P.link} size={14} />
              <span className="truncate">Connect agent via MCP…</span>
            </span>
          </button>
        </div>
      </div>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-[11px] leading-none text-[#84848C] transition-colors hover:bg-white/[0.04] hover:text-[#D1D5DB]"
        onClick={() => {
          // Opening re-asks the CLIs about their logins, so a
          // sign-in that happened after boot shows up here.
          if (!open) onRefresh();
          setOpen((open) => !open);
        }}
        ref={triggerRef}
        type="button"
      >
        {chip.kind === "chosen" && <BrandMark id={chip.id} size={12} />}
        <span className="truncate">
          {chip.kind === "chosen"
            ? `${chip.name}${selectedEffort === null ? "" : ` · ${EFFORT_LABELS[selectedEffort]}`}`
            : "Choose an agent"}
        </span>
        {chosenSignedOut && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-400"
            title="This CLI is signed out. Sign in in your terminal."
          >
            <span className="sr-only">signed out</span>
          </span>
        )}
        <svg
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-180" : ""
          }`}
          fill="none"
          height="12"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          viewBox="0 0 16 16"
          width="12"
        >
          <path d="M4 6.5 8 10.5l4-4" />
        </svg>
      </button>
    </div>
  );
}
