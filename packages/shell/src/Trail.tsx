import { useEffect, useId, useRef } from "react";

import type { Mark } from "./lineage.js";

/**
 * The light in a traced lineage.
 *
 * Two things move, and neither ever stops. A slow current of colour runs down
 * the whole lineage all the time, the mark's own violet, indigo, cyan and
 * teal in a long repeating sweep, faint enough to read as the line being
 * alive rather than as a display. And every few seconds a surge travels the
 * same way: a soft brightening a couple of rows long, no head and no edge,
 * that gathers at the root, moves through the tree, splitting where the tree
 * splits because it is a band of height rather than a point on a path, and
 * fades out past the last row while the next one is already gathering. Each
 * mark it passes blooms and settles.
 *
 * Both run off one clock shared by every trail on the page, so when the
 * lineage under the pointer changes, the old light fades and the new one
 * fades in mid-flow, at the same colour and the same beat: the current
 * reroutes rather than restarting.
 *
 * All of it is a handful of gradient attributes set each frame. There is no
 * dash arithmetic and nothing to filter, so it costs almost nothing and
 * stops with the tab. For someone who asked for less motion the current
 * stands still along the line and nothing else is drawn: the lineage is
 * still told in colour, it just does not move.
 */

/** One full sweep of the current's colours, in pixels. */
const CYCLE = 320;
/** How fast the current drifts down the line, in pixels a second. */
const DRIFT = 22;
/** The surge's height, and how long it takes to pass, in pixels a second before easing. */
const SURGE = 240;
const PACE = 150;
const SURGE_MIN_MS = 2600;
const SURGE_MAX_MS = 5200;
/** The quiet between surges, during which only the current moves. */
const BETWEEN_MS = 2200;
/** How long a mark takes to settle after the surge has passed it. */
const BLOOM_MS = 900;
/** Fading in on arrival and out on leaving, so a change of lineage is a crossfade. */
const FADE_MS = 420;

/**
 * The current's colours, one full sweep, first and last the same so the cycle
 * repeats without a seam, and the tint a mark blooms in as the surge passes
 * it. Ember: rose through orange and pink to magenta, chosen over sixteen
 * others.
 */
export const PALETTE = {
  current: ["#FB7185", "#FB923C", "#F9A8D4", "#E879F9", "#FB7185"],
  bloom: "#FECDD3",
} as const;

/** A shared clock, so every trail on the page moves to the same beat. */
const T0 = typeof performance !== "undefined" ? performance.now() : 0;

/** Where the surge is at a point of its run: gathers, moves, settles. */
function pace(t: number): number {
  const bezier = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(0.5, 0.2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bezier(0, 1, (lo + hi) / 2);
}

export function Trail({
  d,
  height,
  leaving = false,
  marks,
  still = false,
  width,
}: {
  /** Every edge of the traced lineage, as one path of many subpaths, in the rail's coordinates. */
  d: string;
  height: number;
  /** The lineage has changed; fade this light out rather than dropping it. */
  leaving?: boolean;
  /** The marks the lineage runs through, for the bloom as the surge passes each one. */
  marks: readonly Mark[];
  /** Less motion was asked for: the current stands still and nothing surges or blooms. */
  still?: boolean;
  width: number;
}) {
  const id = useId().replace(/\W/g, "");
  const currentId = `current-${id}`;
  const surgeId = `surge-${id}`;
  const current = useRef<SVGLinearGradientElement | null>(null);
  const surge = useRef<SVGLinearGradientElement | null>(null);
  const surgeLayer = useRef<SVGGElement | null>(null);
  const blooms = useRef<(SVGCircleElement | null)[]>([]);
  const shape = useRef(marks);
  shape.current = marks;

  useEffect(() => {
    if (still) return;
    const flow = current.current;
    const band = surge.current;
    const layer = surgeLayer.current;
    if (!flow || !band || !layer) return;
    const marks = shape.current;
    const top = Math.min(...marks.map((mark) => mark.y));
    const bottom = Math.max(...marks.map((mark) => mark.y));
    // The surge gathers above the first mark and is gone below the last, so
    // it emerges from the root and drains past the leaves rather than
    // switching on and off on the line.
    const from = top - SURGE;
    const to = bottom + SURGE;
    const run = Math.min(SURGE_MAX_MS, Math.max(SURGE_MIN_MS, ((to - from) / PACE) * 1000));
    const period = run + BETWEEN_MS;
    const passed: number[] = marks.map(() => -Infinity);
    let frame = 0;
    const draw = (now: number) => {
      const t = Math.max(0, now - T0);
      // The current: one repeating sweep, drifting down.
      const phase = (t / 1000) * DRIFT;
      flow.setAttribute("y1", `${phase % CYCLE}`);
      flow.setAttribute("y2", `${(phase % CYCLE) + CYCLE}`);
      // The surge: a band of height moving down the lineage on the shared beat.
      const at = t % period;
      const inRun = at < run;
      const centre = from + (to - from) * (inRun ? pace(at / run) : 1);
      band.setAttribute("y1", `${centre - SURGE / 2}`);
      band.setAttribute("y2", `${centre + SURGE / 2}`);
      // Never a hard edge in time either: the surge fades up as it gathers
      // and down as it drains, and is simply absent between runs.
      const rise = Math.min(1, at / 500);
      const fall = Math.min(1, Math.max(0, (run - at) / 700));
      layer.setAttribute("opacity", `${inRun ? Math.min(rise, fall).toFixed(3) : "0"}`);
      const cycleStart = t - at;
      marks.forEach((mark, index) => {
        const bloom = blooms.current[index];
        if (!bloom) return;
        if (inRun && centre >= mark.y && (passed[index] ?? -Infinity) < cycleStart) passed[index] = t;
        const since = t - (passed[index] ?? -Infinity);
        const settle = since < BLOOM_MS ? 1 - since / BLOOM_MS : 0;
        const glow = settle * settle * (3 - 2 * settle);
        bloom.setAttribute("opacity", `${(glow * 0.75).toFixed(3)}`);
        bloom.setAttribute("r", `${(2.5 + (1 - glow) * 6).toFixed(2)}`);
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [d, still]);

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 z-20"
      fill="none"
      height={height}
      style={{
        animation: leaving || still ? undefined : `leglas-arrive ${FADE_MS}ms ease-out both`,
        opacity: leaving ? 0 : undefined,
        transition: still ? undefined : `opacity ${FADE_MS}ms ease-in`,
      }}
      width={width}
    >
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={currentId}
          ref={current}
          spreadMethod="repeat"
          x1={0}
          x2={0}
          y1={0}
          y2={CYCLE}
        >
          {PALETTE.current.map((colour, index) => (
            <stop key={index} offset={index / (PALETTE.current.length - 1)} stopColor={colour} />
          ))}
        </linearGradient>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={surgeId}
          ref={surge}
          x1={0}
          x2={0}
          y1={-SURGE}
          y2={0}
        >
          <stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
          <stop offset="0.3" stopColor="#F0F4FF" stopOpacity={0.35} />
          <stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.95} />
          <stop offset="0.7" stopColor="#F0F4FF" stopOpacity={0.35} />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </linearGradient>
      </defs>
      <g stroke={`url(#${currentId})`} strokeLinecap="round" strokeLinejoin="round">
        <path d={d} opacity={0.1} strokeWidth={7} />
        <path d={d} opacity={0.24} strokeWidth={3.5} />
        <path d={d} opacity={0.85} strokeWidth={1.75} />
      </g>
      <g opacity={0} ref={surgeLayer} stroke={`url(#${surgeId})`} strokeLinecap="round" strokeLinejoin="round">
        <path d={d} opacity={0.16} strokeWidth={9} />
        <path d={d} opacity={0.4} strokeWidth={4} />
        <path d={d} opacity={0.9} strokeWidth={1.75} />
      </g>
      {marks.map((mark, index) => (
        <circle
          cx={mark.x}
          cy={mark.y}
          fill={PALETTE.bloom}
          key={`${mark.x},${mark.y}`}
          opacity={0}
          r={2.5}
          ref={(node) => {
            blooms.current[index] = node;
          }}
        />
      ))}
    </svg>
  );
}
