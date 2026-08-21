import { useEffect, useRef, useState, type RefObject } from "react";

import { copyText } from "./clipboard.js";
import {
  MCP_CONNECT_OPTIONS,
  connectionStatus,
  copyActionLabel,
  type McpClient,
  type McpCopyState,
} from "./mcp-connect.js";
import { BrandMark, Mark, P, PIcon, Wordmark } from "./kit.js";

function ClientMarks({ client }: { client: McpClient }) {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-5 w-7 shrink-0 items-center justify-center text-[#D1D5DB]"
    >
      {client === "claude" ? (
        <BrandMark id="claude" size={17} />
      ) : (
        <span className="flex -space-x-1.5">
          <span className="flex size-5 items-center justify-center rounded-full bg-[#25252B] ring-1 ring-[#3A3A42]">
            <BrandMark id="codex" size={14} />
          </span>
          <span className="flex size-5 items-center justify-center rounded-full bg-[#25252B] ring-1 ring-[#3A3A42]">
            <BrandMark id="cursor" size={13} />
          </span>
        </span>
      )}
    </span>
  );
}

export function McpConnectDialog({
  connected,
  fallbackFocusRef,
  onClose,
}: {
  connected: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [client, setClient] = useState<McpClient>("claude");
  const [copyState, setCopyState] = useState<McpCopyState>("idle");
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const firstClientRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const returnTo = document.activeElement as HTMLElement | null;
    const close = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
        ),
      );
      const first = controls[0];
      const last = controls.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("cancel", close);
    dialog.addEventListener("keydown", trapFocus);
    if (!dialog.open) dialog.showModal();
    firstClientRef.current?.focus();
    return () => {
      dialog.removeEventListener("cancel", close);
      dialog.removeEventListener("keydown", trapFocus);
      if (dialog.open) dialog.close();
      const fallback = fallbackFocusRef.current;
      (fallback?.isConnected ? fallback : returnTo)?.focus();
    };
  }, [fallbackFocusRef]);

  const option = MCP_CONNECT_OPTIONS[client];
  const status = connectionStatus(connected);
  const chooseClient = (next: McpClient) => {
    setClient(next);
    setCopyState("idle");
  };
  const copy = async () => {
    if (copyState === "copying") return;
    setCopyState("copying");
    const outcome = await copyText(option.snippet);
    setCopyState(outcome === "copied" ? "copied" : "blocked");
  };

  return (
    <dialog
      aria-describedby="mcp-connect-description"
      aria-labelledby="mcp-connect-title"
      aria-modal="true"
      className="m-auto max-h-[calc(100dvh-2rem)] max-w-none overflow-visible border-0 bg-transparent p-0 text-start text-inherit backdrop:bg-black/55 backdrop:backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="w-[calc(100vw-2rem)] max-w-lg overscroll-contain rounded-xl border border-[#2A2A30] bg-[#1E1E22] p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-[#34343B] bg-[#25252A] shadow-inner"
          >
            <Mark size={24} />
          </span>
          <div className="min-w-0 pt-0.5">
            <div className="flex items-center gap-2">
              <Wordmark height={11} />
              <span className="rounded-full bg-[#7C9CFF]/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-[#AFC2FF]">
                MCP setup
              </span>
            </div>
            <h2 className="mt-2 text-base font-medium text-white" id="mcp-connect-title">
              Connect agent via MCP
            </h2>
            <p
              className="mt-1.5 max-w-md text-xs leading-relaxed text-[#9CA3AF]"
              id="mcp-connect-description"
            >
              Connect an MCP-compatible agent so it can handle requests in this project.
            </p>
          </div>
        </div>

        <fieldset className="mt-5">
          <legend className="text-[10px] font-medium uppercase tracking-[0.08em] text-[#84848C]">
            MCP client
          </legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(Object.keys(MCP_CONNECT_OPTIONS) as McpClient[]).map((id, index) => {
              const entry = MCP_CONNECT_OPTIONS[id];
              const selected = client === id;
              return (
                <label
                  className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-[background-color,border-color,color] duration-150 ${
                    selected
                      ? "border-[#6678B8] bg-[#7C9CFF]/10 text-white"
                      : "border-[#2A2A30] bg-[#19191D] text-[#D1D5DB] hover:border-[#3A3A42] hover:bg-[#24242A]"
                  }`}
                  key={id}
                >
                  <input
                    checked={selected}
                    className="mt-0.5 size-3.5 shrink-0 accent-[#AFC2FF] focus-visible:outline-2 focus-visible:outline-offset-2"
                    name="mcp-client"
                    onChange={() => chooseClient(id)}
                    ref={index === 0 ? firstClientRef : undefined}
                    type="radio"
                    value={id}
                  />
                  <ClientMarks client={id} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{entry.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-relaxed text-[#84848C]">
                      {entry.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="mt-5 overflow-hidden rounded-lg border border-[#2A2A30] bg-[#151519]">
          <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[#2A2A30] px-3">
            <span className="text-[10px] font-medium text-[#84848C]">{option.codeLabel}</span>
            <button
              className="flex min-h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium text-[#D1D5DB] transition-[background-color,color,scale] duration-150 hover:bg-white/[0.06] hover:text-white active:scale-[0.96] disabled:opacity-60"
              disabled={copyState === "copying"}
              onClick={() => void copy()}
              type="button"
            >
              <PIcon d={P.copy} size={12} />
              {copyActionLabel(option, copyState)}
            </button>
          </div>
          <pre
            aria-label={option.codeLabel}
            className="max-h-44 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-[#D1D5DB]"
            tabIndex={0}
          >
            <code>{option.snippet}</code>
          </pre>
        </div>

        <p className="mt-2 min-h-4 text-[10px] leading-relaxed" role="status">
          {copyState === "blocked" ? (
            <span className="text-red-300">
              Clipboard access is blocked. Select and copy the text above.
            </span>
          ) : copyState === "copied" ? (
            <span className="text-emerald-300">Copied to the clipboard.</span>
          ) : null}
        </p>

        <div className="mt-4 space-y-4">
          <p className="text-xs leading-relaxed text-[#9CA3AF]">{option.nextStep}</p>
          <div
            className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 ${
              connected ? "bg-emerald-400/10" : "bg-white/[0.04]"
            }`}
            role="status"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full ${
                connected ? "bg-emerald-400 text-[#123326]" : "border border-[#5B5B66]"
              }`}
            >
              {connected ? (
                <svg fill="none" height="10" viewBox="0 0 12 12" width="10">
                  <path
                    d="m2.2 6.1 2.2 2.2 5.4-5.2"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.8"
                  />
                </svg>
              ) : null}
            </span>
            <span className="min-w-0">
              <span className={`block text-xs font-medium ${connected ? "text-emerald-200" : "text-[#D1D5DB]"}`}>
                {status.title}
              </span>
              <span className="mt-0.5 block text-[10px] leading-relaxed text-[#84848C]">
                {status.detail}
              </span>
            </span>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            className="rounded-md bg-[#E8E8EA] px-3 py-1.5 text-xs font-medium text-[#1C1C20] transition-[background-color,scale] duration-150 hover:bg-white active:scale-[0.96]"
            onClick={onClose}
            type="button"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
