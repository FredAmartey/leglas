import { useEffect, useRef, useState } from "react";

import { ErrorOverlay, ICON_BUTTON, Mark, P, PIcon, RenameForm, SkeletonOverlay, Tip } from "./kit.js";
import { EASE } from "./prefs.js";
import { useShellState } from "./useShellState.js";
import type { Preview } from "./types.js";

/**
 * The Leglas chrome. Warm dark surfaces (#1C1C20 main, #1E1E22 strips,
 * #232328 borders, #2E2E2E inputs), a 368px rail, two type tiers, flat rows
 * with a sliding highlight and a hover-revealed action cluster, drag to
 * reorder, hidden scrollbars, no top bar, and a floating widget whose popover
 * holds the typeface picker, viewport presets, copy, and open-in-tab.
 *
 * The typeface is a user preference, not a design variant.
 */
const FONTS = [
  { key: "satoshi", label: "Satoshi", stack: "var(--font-satoshi)" },
  { key: "outfit", label: "Outfit", stack: "var(--font-outfit)" },
  { key: "manrope", label: "Manrope", stack: "var(--font-manrope)" },
] as const;

/** How long a preview may take before it is treated as failed. */
const LOAD_TIMEOUT_MS = 15_000;

type Drag = {
  dy: number;
  from: number;
  /** Gap between rows, measured at drag start so shifts clear it. */
  gap: number;
  /** Dragged row height, captured at drag start for render-time shifts. */
  height: number;
  title: string;
  /** After release: easing into the target slot before the order commits. */
  settling: boolean;
  started: boolean;
  to: number;
};

export function Shell({ previews, project }: { previews: Preview[]; project: string }) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const st = useShellState({ previews, project, searchRef });
  const [widgetOpen, setWidgetOpen] = useState(false);
  const widgetButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // One white/6% panel behind the hovered row that eases between rows. The
  // active row carries its own persistent surface, so this is hover-only.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [glow, setGlow] = useState({ height: 0, on: false, top: 0 });

  // Window-level listeners rather than pointer capture, so a drag survives
  // leaving the rail; a 4px threshold separates it from a click.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const dragMeta = useRef<{
    maxDy: number;
    minDy: number;
    rows: { height: number; mid: number; title: string; top: number }[];
    startY: number;
    suppressed: boolean;
  } | null>(null);

  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);

  useEffect(() => {
    if (!drag) return;
    const meta = dragMeta.current;
    if (!meta) return;
    const onMove = (event: PointerEvent) => {
      const dy = event.clientY - meta.startY;
      setDrag((current) => {
        if (!current || current.settling) return current;
        if (!current.started && Math.abs(dy) <= 4) return { ...current, dy };
        if (!current.started) window.getSelection()?.removeAllRanges();
        const row = meta.rows[current.from];
        if (!row) return current;
        // Follow the pointer within the slot range plus one row of give, so
        // the row never detaches into empty space; the target index still
        // follows the raw pointer.
        const bounded = Math.max(meta.minDy, Math.min(meta.maxDy, dy));
        const center = row.mid + dy;
        let to = 0;
        meta.rows.forEach((candidate, index) => {
          if (index !== current.from && center > candidate.mid) to += 1;
        });
        return { ...current, dy: bounded, started: true, to };
      });
    };
    const onUp = () => {
      const current = dragRef.current;
      if (!current?.started) {
        setDrag(null);
        return;
      }
      meta.suppressed = true;
      // Ease the dragged row the rest of the way into its slot (the others are
      // already shifted to receive it), then commit so the swap has no snap.
      let settle = 0;
      if (current.to > current.from) {
        for (let index = current.from + 1; index <= current.to; index += 1) {
          settle += (meta.rows[index]?.height ?? 0) + current.gap;
        }
      } else {
        for (let index = current.to; index < current.from; index += 1) {
          settle -= (meta.rows[index]?.height ?? 0) + current.gap;
        }
      }
      setDrag({ ...current, dy: settle, settling: true });
      window.setTimeout(() => {
        st.moveOption(current.title, current.to);
        setDrag(null);
        window.setTimeout(() => {
          meta.suppressed = false;
        }, 0);
      }, 190);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  // Escape and outside clicks close the popover; focus moves in on open and
  // returns to the button on close. Clicking into a preview blurs the window,
  // which also closes it.
  useEffect(() => {
    if (!widgetOpen) return;
    popoverRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWidgetOpen(false);
        widgetButtonRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !widgetButtonRef.current?.contains(target)) {
        setWidgetOpen(false);
      }
    };
    const onWindowBlur = () => setWidgetOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [widgetOpen]);

  const activeFont = FONTS.find((font) => font.key === st.prefs.font) ?? FONTS[0];
  const framed = st.prefs.viewport !== null;
  const dragging = drag?.started ?? false;
  const busy = st.resizing || dragging;

  const [errored, setErrored] = useState<Record<string, boolean>>({});
  const [reloadTick, setReloadTick] = useState<Record<string, number>>({});

  // A declared URL can silently lie: a typo the app ignores serves the default
  // page, so two directions render identically and the comparison is empty.
  // Asked for once at startup, and never allowed to break anything if it fails.
  const [twins, setTwins] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    void fetch("/leglas/api/duplicates")
      .then((response) => response.json() as Promise<{ groups: string[][] }>)
      .then(({ groups }) => {
        if (cancelled) return;
        const next: Record<string, string[]> = {};
        for (const group of groups) {
          for (const title of group) next[title] = group.filter((other) => other !== title);
        }
        setTwins(next);
      })
      .catch(() => {
        // A courtesy check; its failure is not the user's problem.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (st.loaded[st.active] || errored[st.active]) return;
    const timer = setTimeout(
      () => setErrored((current) => ({ ...current, [st.active]: true })),
      LOAD_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [st.active, st.loaded, errored, reloadTick]);

  const reloadPane = (title: string) => {
    setErrored((current) => ({ ...current, [title]: false }));
    st.resetLoaded(title);
    setReloadTick((current) => ({ ...current, [title]: (current[title] ?? 0) + 1 }));
  };

  const onRowPointerDown =
    (title: string, index: number) => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      if (st.renaming || st.query.trim() || st.rows.length < 2) return;
      // Buttons keep their clicks; the note keeps text selection.
      if ((event.target as HTMLElement).closest("button, [data-selectable]")) return;
      const list = listRef.current;
      const scroller = list?.parentElement;
      if (!list || !scroller) return;
      const items = [...list.querySelectorAll<HTMLLIElement>("li[data-title]")];
      const rows = items.map((item) => ({
        height: item.offsetHeight,
        mid: item.offsetTop + item.offsetHeight / 2,
        title: item.dataset.title ?? "",
        top: item.offsetTop,
      }));
      const view = scroller.getBoundingClientRect();
      const rowRect = items[index]?.getBoundingClientRect();
      dragMeta.current = {
        maxDy: rowRect ? view.bottom - rowRect.bottom : 0,
        minDy: rowRect ? view.top - rowRect.top : 0,
        rows,
        startY: event.clientY,
        suppressed: false,
      };
      const first = rows[0];
      const second = rows[1];
      setDrag({
        dy: 0,
        from: index,
        gap: first && second ? second.top - first.top - first.height : 0,
        height: rows[index]?.height ?? 0,
        title,
        settling: false,
        started: false,
        to: index,
      });
    };

  // Rows other than the dragged one make room: down by the dragged row's
  // height when the insertion point passes above them, up when below.
  const shiftFor = (index: number): number => {
    if (!drag?.started) return 0;
    const pitch = drag.height + drag.gap;
    if (index < drag.from && index >= drag.to) return pitch;
    if (index > drag.from && index <= drag.to) return -pitch;
    return 0;
  };

  const renderRow = (title: string, index: number) => {
    const isActive = title === st.active;
    const preview = st.previewFor(title);
    const isDragged = dragging && drag?.title === title;
    const shift = dragging && !isDragged ? shiftFor(index) : 0;

    if (st.renaming === title) {
      return (
        <li className="relative z-10" key={title}>
          <RenameForm
            initial={st.displayName(title)}
            label={`Rename the ${st.displayName(title)} direction`}
            onCancel={() => st.setRenaming(null)}
            onCommit={(value) => st.rename(title, value)}
          />
        </li>
      );
    }

    return (
      <li
        className={`group relative ${
          isDragged
            ? `z-30 rounded-md bg-white/[0.06] shadow-2xl ${
                drag?.settling
                  ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
                  : ""
              }`
            : "z-10"
        } ${
          dragging && !isDragged
            ? `transition-transform duration-200 ${EASE} motion-reduce:transition-none`
            : ""
        }`}
        data-title={title}
        key={title}
        onPointerEnter={(event) =>
          setGlow({
            height: event.currentTarget.offsetHeight,
            on: true,
            top: event.currentTarget.offsetTop,
          })
        }
        style={
          isDragged
            ? { transform: `translateY(${drag?.dy ?? 0}px)` }
            : shift
              ? { transform: `translateY(${shift}px)` }
              : undefined
        }
      >
        <div
          aria-pressed={isActive}
          className={`relative flex w-full cursor-grab items-start gap-2 rounded-md px-3 py-2 text-left transition-colors active:cursor-grabbing ${
            isActive ? "bg-[#2E2E2E] ring-1 ring-inset ring-[#D1D5DB]/40" : ""
          }`}
          onClick={() => {
            if (dragMeta.current?.suppressed) {
              dragMeta.current.suppressed = false;
              return;
            }
            st.setActive(title);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              st.setActive(title);
            }
          }}
          onPointerDown={onRowPointerDown(title, index)}
          role="button"
          tabIndex={0}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span
                className={`min-w-0 flex-1 select-text truncate text-sm font-medium transition-colors duration-150 ${
                  isActive ? "text-white" : "text-[#D1D5DB] group-hover:text-[#E8EAED]"
                }`}
              >
                {st.displayName(title)}
              </span>
              {twins[title] ? (
                <Tip
                  label={`Renders the same page as ${twins[title]?.join(", ")}. Check the URL.`}
                >
                  <span
                    className={`shrink-0 rounded-md bg-amber-400/10 px-2 py-[3px] text-[11px] leading-none text-amber-300/90 transition-opacity duration-150 ${
                      dragging
                        ? ""
                        : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                    }`}
                  >
                    Same as {twins[title]?.length === 1 ? twins[title]?.[0] : `${twins[title]?.length} others`}
                  </span>
                </Tip>
              ) : (
                preview?.tags[0] && (
                  <span
                    className={`shrink-0 rounded-md bg-[#A9BC7C]/10 px-2 py-[3px] text-[11px] leading-none text-[#A9BC7C] transition-opacity duration-150 ${
                      dragging
                        ? ""
                        : "group-hover:opacity-0 group-has-[button:focus-visible]:opacity-0"
                    }`}
                  >
                    {preview.tags[0]}
                  </span>
                )
              )}
            </span>
            <span
              className={`mt-0.5 line-clamp-2 block cursor-text select-text text-xs leading-snug transition-colors ${
                isActive ? "text-[#D1D5DB]" : "text-[#84848C]"
              }`}
              data-selectable=""
            >
              {preview?.note ?? preview?.url}
            </span>
          </span>
        </div>
        <div
          className={`pointer-events-none absolute right-2 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ${
            dragging
              ? ""
              : "group-hover:pointer-events-auto group-hover:opacity-100 group-has-[button:focus-visible]:pointer-events-auto group-has-[button:focus-visible]:opacity-100"
          }`}
        >
          <Tip label={st.copied === title ? "Copied" : "Copy reference URL"}>
            <button
              aria-label={`Copy link to the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.copyReference(title)}
              type="button"
            >
              {st.copied === title ? (
                <span className="text-[10px] text-emerald-300">✓</span>
              ) : (
                <PIcon d={P.copy} />
              )}
            </button>
          </Tip>
          <Tip label="Rename">
            <button
              aria-label={`Rename the ${st.displayName(title)} direction`}
              className={ICON_BUTTON}
              onClick={() => st.setRenaming(title)}
              type="button"
            >
              <PIcon d={P.pencil} size={12} />
            </button>
          </Tip>
          <Tip label="Remove from list">
            <button
              aria-label={`Remove the ${st.displayName(title)} direction from the list`}
              className={ICON_BUTTON}
              onClick={() => st.hide(title)}
              type="button"
            >
              <PIcon d={P.trash} size={12} />
            </button>
          </Tip>
        </div>
      </li>
    );
  };

  return (
    <main
      className={`flex h-dvh bg-[#1C1C20] text-white antialiased selection:bg-[#E6E8EC] selection:text-[#17181B] ${
        st.resizing ? "cursor-col-resize" : ""
      } ${busy ? "select-none" : ""}`}
      data-leglas-shell=""
      style={{ fontFamily: activeFont.stack }}
    >
      <aside
        className={`relative shrink-0 overflow-hidden border-r border-[#232328] ${
          st.prefs.collapsed ? "" : "shadow-2xl"
        } ${
          st.resizing
            ? ""
            : `transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
        }`}
        style={{ width: st.prefs.collapsed ? 48 : st.prefs.width }}
      >
        <div
          className={`flex h-full flex-col transition-opacity duration-150 ${
            st.prefs.collapsed ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
          inert={st.prefs.collapsed}
          style={{ width: st.prefs.width }}
        >
          <div className="z-10 flex shrink-0 items-center justify-between gap-2 border-b border-[#232328] bg-[#1E1E22] px-2.5 py-2.5">
            <span className="min-w-0 truncate text-sm font-medium text-white">Directions</span>
            <Tip
              label={
                <>
                  Collapse panel <kbd className="ml-1 text-[#9CA3AF]">[</kbd>
                </>
              }
              side="right"
            >
              <button
                aria-label="Collapse the directions panel"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#2E2E2E] hover:text-white"
                onClick={() => st.setPrefs((prefs) => ({ ...prefs, collapsed: true }))}
                type="button"
              >
                <PIcon d={P.sidebar} size={16} />
              </button>
            </Tip>
          </div>

          <div className="px-3 pb-1 pt-2">
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[#D1D5DB]">
                <PIcon d={P.search} />
              </span>
              <input
                aria-label="Search directions"
                className="w-full rounded-md border border-[#232328] bg-[#2E2E2E]/40 py-1.5 pl-7 pr-2 text-xs text-white placeholder:text-[#E8EAED] focus:outline-none focus:ring-1 focus:ring-[#D1D5DB]/60"
                onChange={(event) => st.setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (st.query) st.setQuery("");
                  else event.currentTarget.blur();
                }}
                placeholder="Search directions…"
                ref={searchRef}
                type="text"
                value={st.query}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <ul
              className="relative flex flex-col gap-1"
              onPointerLeave={() => setGlow((current) => ({ ...current, on: false }))}
              ref={listRef}
            >
              <div
                aria-hidden
                className={`pointer-events-none absolute left-0 right-0 z-0 rounded-md bg-white/[0.06] transition-[transform,height,opacity] duration-150 ${EASE} motion-reduce:transition-none`}
                style={{
                  height: glow.height,
                  opacity: glow.on && !dragging ? 1 : 0,
                  transform: `translateY(${glow.top}px)`,
                }}
              />
              {st.rows.map((title, index) => renderRow(title, index))}
            </ul>

            {st.rows.length === 0 && (
              <div className="px-3 py-2">
                {st.query.trim() ? (
                  <>
                    <p className="text-xs text-[#9CA3AF]">Nothing matches “{st.query}”.</p>
                    <button
                      className="mt-1 rounded text-xs text-[#84848C] underline underline-offset-2 transition-colors hover:text-[#D1D5DB]"
                      onClick={() => st.setQuery("")}
                      type="button"
                    >
                      Clear search
                    </button>
                  </>
                ) : (
                  <p className="text-xs leading-snug text-[#9CA3AF]">
                    {st.visibleCount === 0 && st.hiddenCount > 0
                      ? "Every direction is removed. Restore one below."
                      : "No directions yet. Add them to leglas.config.ts."}
                  </p>
                )}
              </div>
            )}

            {st.hiddenCount > 0 && (
              <button
                className="mt-1 rounded px-3 py-1.5 text-left text-[11px] text-[#84848C] transition-colors hover:text-[#D1D5DB]"
                onClick={() => st.setShowHidden((value) => !value)}
                type="button"
              >
                {st.showHidden ? "Hide" : "Show"} removed ({st.hiddenCount})
              </button>
            )}

            {st.showHidden && (
              <ul className="relative">
                {st.prefs.hidden.filter(st.matches).map((title) => (
                  <li className="group relative" key={title}>
                    <div className="flex items-center justify-between rounded-md px-3 py-2 transition-colors group-hover:bg-white/[0.04]">
                      <span className="truncate text-sm font-medium text-[#9CA3AF]">
                        {st.displayName(title)}
                      </span>
                      <button
                        className="rounded text-[11px] text-[#9CA3AF] transition-colors hover:text-white"
                        onClick={() =>
                          st.setPrefs((prefs) => ({
                            ...prefs,
                            hidden: prefs.hidden.filter((entry) => entry !== title),
                          }))
                        }
                        type="button"
                      >
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex justify-end px-3 py-2">
            <Tip label="Copy a link to the active direction">
              <button
                className="rounded-md bg-[#2E2E2E]/60 px-3.5 py-1.5 text-xs font-medium text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E] hover:text-white"
                onClick={() => st.copyReference(st.active)}
                type="button"
              >
                {st.copied === st.active ? "Copied" : "Share"}
              </button>
            </Tip>
          </div>
        </div>

        <div
          className={`absolute inset-y-0 left-0 z-30 flex w-12 flex-col items-center bg-[#1C1C20] py-3 transition-opacity duration-150 ${
            st.prefs.collapsed ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          inert={!st.prefs.collapsed}
        >
          <Mark size={16} />
          <Tip
            label={
              <>
                Open directions <kbd className="ml-1 text-[#9CA3AF]">[</kbd>
              </>
            }
            side="right"
          >
            <button
              aria-label="Open the directions panel"
              className="mt-3 flex h-6 w-6 items-center justify-center rounded p-1 text-[#9CA3AF] transition-colors hover:bg-[#2E2E2E] hover:text-white"
              onClick={() => st.setPrefs((prefs) => ({ ...prefs, collapsed: false }))}
              type="button"
            >
              <PIcon d={P.sidebar} size={16} />
            </button>
          </Tip>
        </div>

        {!st.prefs.collapsed && (
          <div
            aria-hidden
            className="group/resize absolute inset-y-0 right-0 z-20 flex w-3 cursor-col-resize touch-none justify-end"
            onPointerDown={st.onHandlePointerDown}
          >
            <span
              className={`h-full transition-all duration-150 ${
                st.resizing
                  ? "w-0.5 bg-[#9CA3AF]"
                  : "w-px bg-[#232328] group-hover/resize:w-0.5 group-hover/resize:bg-[#9CA3AF]"
              }`}
            />
          </div>
        )}
      </aside>

      <span aria-live="polite" className="sr-only" role="status">
        {st.copied ? "Reference URL copied" : ""}
      </span>

      <div className="relative min-w-0 flex-1 overflow-auto">
        {st.panes.map((title) => (
          <div
            className={`${title === st.active ? "" : "hidden"} ${
              framed ? "flex min-h-full justify-center p-6" : "absolute inset-0"
            }`}
            key={title}
          >
            <div
              className={
                framed
                  ? `relative h-[calc(100dvh-48px)] shrink-0 overflow-hidden rounded-[10px] shadow-[0_0_0_1px_rgba(255,255,255,0.10)] transition-[width] duration-200 ${EASE} motion-reduce:transition-none`
                  : "relative size-full"
              }
              style={framed ? { width: st.prefs.viewport ?? undefined } : undefined}
            >
              <iframe
                className={`size-full border-0 bg-white ${busy ? "pointer-events-none" : ""}`}
                key={reloadTick[title] ?? 0}
                onError={() => setErrored((current) => ({ ...current, [title]: true }))}
                onLoad={(event) => {
                  // A failed navigation still fires load, but lands on a
                  // cross-origin error document whose contentDocument reads as
                  // null or throws. A real preview is same-origin and readable.
                  let ok = false;
                  try {
                    ok = event.currentTarget.contentDocument != null;
                  } catch {
                    ok = false;
                  }
                  if (ok) {
                    st.markLoaded(title);
                    setErrored((current) => (current[title] ? { ...current, [title]: false } : current));
                  } else {
                    setErrored((current) => ({ ...current, [title]: true }));
                  }
                }}
                src={st.urlFor(title)}
                title={`Preview: ${st.displayName(title)}`}
              />
              {errored[title] ? (
                <ErrorOverlay
                  onReload={() => reloadPane(title)}
                  reason={`${st.urlFor(title)} didn’t respond. Check your dev server is running.`}
                />
              ) : (
                <SkeletonOverlay loaded={Boolean(st.loaded[title])} />
              )}
            </div>
          </div>
        ))}

        <div className="absolute bottom-4 right-4 z-50 flex flex-col items-end gap-2">
          <div
            aria-hidden={!widgetOpen}
            aria-label="Leglas tools"
            className={`w-56 origin-bottom-right rounded-lg border border-[#232328] bg-[#1E1E22] p-1.5 shadow-2xl transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.165,0.84,0.44,1)] focus:outline-none motion-reduce:transition-none ${
              widgetOpen
                ? "translate-y-0 scale-100 opacity-100"
                : "pointer-events-none translate-y-1 scale-95 opacity-0"
            }`}
            inert={!widgetOpen}
            ref={popoverRef}
            role="dialog"
            tabIndex={-1}
          >
            <span className="block px-1 pb-1 pt-0.5 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
              Typeface
            </span>
            <div
              aria-label="Interface typeface"
              className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
              role="group"
            >
              {FONTS.map((font) => (
                <button
                  aria-pressed={activeFont.key === font.key}
                  className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                    activeFont.key === font.key
                      ? "bg-[#2E2E2E] font-medium text-white"
                      : "text-[#9CA3AF] hover:text-[#D1D5DB]"
                  }`}
                  key={font.key}
                  onClick={() => st.setPrefs((prefs) => ({ ...prefs, font: font.key }))}
                  style={{ fontFamily: font.stack }}
                  type="button"
                >
                  {font.label}
                </button>
              ))}
            </div>

            <span className="block px-1 pb-1 pt-2 text-[10px] uppercase tracking-[0.08em] text-[#84848C]">
              Viewport
            </span>
            <div
              aria-label="Viewport width"
              className="flex items-center gap-0.5 rounded-md bg-[#2E2E2E]/40 p-0.5"
              role="group"
            >
              {st.viewports.map(({ label, width }) => (
                <button
                  className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                    st.prefs.viewport === width
                      ? "bg-[#2E2E2E] font-medium text-white"
                      : "text-[#9CA3AF] hover:text-[#D1D5DB]"
                  }`}
                  key={label}
                  onClick={() => st.setPrefs((prefs) => ({ ...prefs, viewport: width }))}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
              onClick={() => st.copyReference(st.active)}
              type="button"
            >
              <PIcon d={P.copy} size={12} />
              {st.copied === st.active ? "Copied" : "Copy reference URL"}
            </button>
            <a
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#D1D5DB] transition-colors hover:bg-[#2E2E2E]/60 hover:text-white"
              href={st.urlFor(st.active)}
              rel="noreferrer"
              target="_blank"
            >
              <span className="inline-block size-3 rounded-sm border border-current" />
              Open in new tab
            </a>
          </div>

          <Tip label="Leglas tools">
            <button
              aria-expanded={widgetOpen}
              aria-haspopup="dialog"
              aria-label="Leglas tools"
              className="relative flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-[#1C1C20] shadow-lg transition-[border-color,transform] duration-150 hover:scale-[1.04] hover:border-white/20 active:scale-[0.95] motion-reduce:transform-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100"
              onClick={() => setWidgetOpen((value) => !value)}
              ref={widgetButtonRef}
              type="button"
            >
              <Mark size={20} />
              {!st.loaded[st.active] && (
                <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-amber-400 motion-reduce:animate-none" />
              )}
            </button>
          </Tip>
        </div>
      </div>
    </main>
  );
}
