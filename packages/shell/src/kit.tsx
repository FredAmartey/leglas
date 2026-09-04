import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ThinkingOrb } from "thinking-orbs";

import { MOOD } from "./orb.js";
import { EASE } from "./prefs.js";
import { placeTip, type Placement } from "./tip.js";
import type { Toast } from "./toasts.js";
import type { BranchPreviewState } from "./types.js";

/**
 * The Leglas mark in its brand colours, the lockup's dark variant: the one
 * deliberate spot of hue in the chrome, sized by its height with the width
 * following the mark's own proportions. Stroked with its own paints so the
 * string and shafts hold up at icon sizes.
 */
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      height={size}
      strokeLinejoin="round"
      strokeWidth={22}
      viewBox="160 370 1050 1320"
      width={Math.round(size * (1050 / 1320))}
    >
      <defs>
        <linearGradient gradientUnits="userSpaceOnUse" id="lm-up" x1="791.957" x2="210" y1="723.095" y2="1010">
          <stop offset="0" stopColor="#7C38E8" />
          <stop offset="0.68" stopColor="#CDB6F1" />
          <stop offset="1" stopColor="#E9E0FA" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="lm-down" x1="789.954" x2="210" y1="1330.46" y2="1035">
          <stop offset="0" stopColor="#3EC2A8" />
          <stop offset="0.68" stopColor="#9EDAE8" />
          <stop offset="1" stopColor="#E1F2F6" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="lm-shaft" x1="884.016" x2="182" y1="1023.26" y2="1023.26">
          <stop offset="0" stopColor="#7E97DD" />
          <stop offset="0.48" stopColor="#5F7FD8" />
          <stop offset="0.71" stopColor="#9AABE2" />
          <stop offset="1" stopColor="#E2E8F6" />
        </linearGradient>
        <linearGradient gradientUnits="userSpaceOnUse" id="lm-head" x1="1192" x2="874.81" y1="1021.57" y2="1024.91">
          <stop offset="0" stopColor="#E8ECF7" />
          <stop offset="1" stopColor="#92A7E0" />
        </linearGradient>
      </defs>
      <path d="M 671.122 381.199 C 708.12 378.001 733.579 414.981 702.643 437.984 C 705.64 430.245 708.163 423.315 705.553 415.028 C 700.981 400.516 684.107 396.94 671.252 401.81 C 662.713 405.098 655.849 411.671 652.193 420.059 C 645.933 434.059 649.404 447.111 654.599 460.446 C 665.665 467.718 660.114 472.463 666.664 480.695 C 694.852 516.12 737.817 543.026 774.246 568.848 C 841.225 616.324 905.267 670.31 939.022 747.101 C 953.651 782.815 964.144 815.411 953.49 854.107 C 944.702 886.028 889.413 910.644 901.624 945.63 C 905.247 956.01 926.305 965.294 936.684 957.439 C 947.74 949.072 949.919 942.473 953.06 929.336 C 967.974 962.891 939.504 987.655 907.14 982.376 C 893.109 980.134 880.552 972.384 872.258 960.847 C 839.018 914.253 888.968 876.15 898.307 834.712 C 902.782 814.853 894.952 783.534 888.142 764.672 C 860.48 688.068 798.139 632.327 735.838 583.312 C 700.284 555.045 669.551 529.466 642.632 492.392 C 627.896 510.927 608.893 531.804 593.068 550.006 L 506.523 649.582 L 278.039 912.109 C 245.455 949.199 213.059 986.454 180.851 1023.87 C 231.765 1079.46 283.65 1142.04 333.374 1199.45 L 642.829 1555.74 C 666.446 1520.75 700.163 1494.07 732.424 1467.5 C 795.117 1417.7 858.256 1363.37 887.261 1286.25 C 898.113 1256.93 906.911 1217.89 889.705 1189.06 C 873.478 1161.87 852.143 1132.56 865.539 1099.12 C 871.003 1085.24 881.904 1074.2 895.712 1068.56 C 930.406 1054.52 970.704 1079.86 953.232 1118.88 C 950.548 1106.58 948.459 1099.64 937.837 1091.37 C 926.133 1082.27 907.942 1089.57 901.99 1101.66 C 890.169 1127.27 924.549 1151.85 939.219 1169.81 C 966.471 1203.18 959.658 1245.71 945.71 1284.44 C 914.285 1371.69 840.069 1433.7 765.809 1484.61 C 733.647 1506.66 698.091 1531.58 672.306 1561.08 C 665.933 1568.59 659.014 1581.87 653.634 1590.29 C 648.506 1598.32 647.787 1615.38 650.833 1624.56 C 653.881 1633.77 660.579 1641.32 669.359 1645.45 C 681.85 1651.27 699.281 1649.12 705.041 1634.65 C 708.705 1625.45 705.419 1617.29 701.581 1608.8 L 702.848 1609.85 C 737.88 1638.68 697.51 1681.47 657.106 1662.8 C 643.389 1656.45 632.826 1644.83 627.824 1630.56 C 619.064 1605.85 626.824 1585.32 637.489 1563.26 C 610.659 1534.07 581.755 1498.91 555.456 1468.66 L 383.745 1271.03 L 242.504 1108.25 C 219.223 1081.36 191.596 1051.06 169.707 1023.52 C 181.894 1007.58 201.352 986.522 215.082 970.737 L 301.342 871.646 L 539.659 597.67 C 572.041 560.265 605.914 522.417 637.6 484.482 C 616.356 444.192 617.849 392.637 671.122 381.199 z" fill="#E8ECF7" stroke="#E8ECF7" />
      <path d="M 791.002 712.436 C 791.99 712.378 791.355 712.338 792.831 712.983 C 791.837 718.407 719.488 841.546 710.03 858.509 C 707.23 840.677 702.304 817.013 698.274 799.446 C 555 895 360 995 182 1023 C 355 963 525 870 674.863 761.103 C 659.702 748.905 644.649 736.575 629.704 724.113 C 681.16 722.084 738.984 715.793 791.002 712.436 z" fill="url(#lm-up)" stroke="url(#lm-up)" />
      <path d="M 182 1023 C 360 1051 555 1151 698.326 1248.65 C 702.16 1232.41 707.425 1206.32 709.871 1189.79 C 737.246 1238.39 766.184 1286.55 793.713 1335.16 C 739.167 1331.05 684.598 1327.24 630.009 1323.75 C 644.462 1311.53 659.652 1298.21 674.331 1286.42 C 525 1176 355 1083 182 1023 z" fill="url(#lm-down)" stroke="url(#lm-down)" />
      <path d="M 182 1023.5 L 884.044 1002.33 L 881.311 1004.34 C 882.15 1018.85 886.981 1021.89 881.356 1038.74 C 878.766 1040.79 876.225 1042.9 873.734 1045.08 z" fill="url(#lm-shaft)" stroke="url(#lm-shaft)" />
      <path d="M 1005.63 925.199 L 1121.78 984.34 C 1142.45 994.767 1179.5 1012.52 1198.4 1023.72 L 1070.98 1089.03 C 1051.67 1098.95 1023.69 1114.54 1004.93 1122.53 C 1013.61 1097.65 1022.5 1072.85 1031.59 1048.12 L 873.734 1045.08 C 876.225 1042.9 878.766 1040.79 881.356 1038.74 C 886.981 1021.89 882.15 1018.85 881.311 1004.34 L 884.044 1002.33 L 1030.81 999.036 C 1023.04 976.689 1012.03 947.529 1005.63 925.199 z" fill="url(#lm-head)" stroke="url(#lm-head)" />
    </svg>
  );
}

/**
 * The wordmark from the logo, drawn rather than set: the chrome's own type
 * would be a different Leglas than the one on the readme and the tab.
 */
export function Wordmark({ height = 16 }: { height?: number }) {
  return (
    <svg
      aria-label="Leglas"
      fill="#E8ECF7"
      height={height}
      role="img"
      viewBox="1256 928 642 222"
      width={Math.round(height * (642 / 222))}
    >
      <path d="M 1532.93 979.19 C 1552.43 978.051 1561.54 979.865 1574.88 995.12 L 1575.07 981.036 L 1598.92 981.151 L 1598.96 1052.38 C 1598.98 1086.98 1603.87 1127.82 1557.89 1134.37 C 1533.59 1137.83 1517.6 1134.59 1498.35 1119.87 L 1504.96 1108.54 L 1508.69 1102.35 C 1525.04 1114.93 1548.42 1124.68 1566.62 1107.48 C 1575.66 1098.94 1575.05 1084.76 1574.99 1073.16 C 1568.8 1080.06 1562.18 1085.4 1553.24 1088.34 C 1542.19 1091.88 1530.17 1090.79 1519.94 1085.31 C 1486.94 1067.75 1484.12 1009.92 1513.66 987.847 C 1520.32 982.873 1525.18 981.186 1532.93 979.19 z M 1541.52 1000.13 C 1555.85 998.918 1566.45 1003.26 1574.9 1015.05 C 1575.09 1027.93 1574.91 1041.22 1574.89 1054.14 C 1567.52 1063.25 1562.65 1066.25 1551.25 1068.92 C 1511.01 1069.99 1505.34 1012.62 1541.52 1000.13 z" fillRule="evenodd" />
      <path d="M 1416.95 979.231 C 1461.09 974.139 1477.7 1004.91 1478.08 1043.29 L 1395.13 1043.56 C 1404.31 1072.49 1429.03 1082.58 1454.48 1064.74 C 1457.34 1062.33 1456.68 1062.04 1459.58 1062.05 C 1464.01 1065.22 1467.95 1071.97 1471.41 1076.59 C 1414.1 1122.22 1344.57 1064.4 1381 1001.64 C 1388.32 989.03 1403.12 982.109 1416.95 979.231 z M 1419.64 998.169 C 1442.21 996.072 1449.85 1006.61 1455.14 1026.51 C 1448.55 1026.96 1438.16 1026.58 1431.31 1026.54 C 1419.15 1026.65 1406.99 1026.63 1394.83 1026.48 C 1398.74 1009.86 1403.7 1003.36 1419.64 998.169 z" fillRule="evenodd" />
      <path d="M 1713.27 979.252 C 1728.04 977.573 1745.26 979.123 1756.3 989.97 C 1768.26 1001.72 1767.44 1017.49 1767.31 1032.81 C 1767.15 1051.82 1767.12 1070.77 1767.06 1089.74 L 1757.36 1089.93 C 1733.55 1090.35 1748.04 1086.51 1742.3 1080.97 C 1727.07 1089.66 1714.5 1096.6 1695.79 1090.38 C 1685.07 1086.81 1679.16 1079.18 1674.51 1069.31 C 1663.26 1025.76 1710.42 1008.22 1743.06 1033.45 C 1743.17 1029.64 1743.75 1021.08 1742.89 1017.76 C 1734.81 986.781 1704.35 998.377 1687.37 1012 C 1684.28 1006.47 1681.22 1000.93 1678.2 995.358 C 1689.81 985.727 1698.69 981.852 1713.27 979.252 z M 1714.53 1038.21 C 1726.37 1037.77 1733.38 1039.57 1742.94 1046.21 C 1743.21 1052.09 1743.05 1058.97 1743.05 1064.94 C 1736.15 1071.44 1733.92 1072.52 1724.6 1074.96 C 1709.1 1075.75 1690.77 1070.07 1698.16 1048.49 C 1700.08 1042.9 1708.94 1039.56 1714.53 1038.21 z" fillRule="evenodd" />
      <path d="M 1823.29 979.174 C 1843.68 977.649 1857.91 980.343 1873.82 993.561 L 1864.19 1010.31 C 1854.9 1002.37 1842.52 996.264 1830.29 997.499 C 1810.54 999.496 1804.87 1016.41 1827.99 1021.78 C 1853.42 1027.68 1886.98 1035.62 1875.05 1070.07 C 1869.31 1086.64 1852.8 1091.05 1837.21 1092.35 C 1816.02 1092.18 1803.14 1089.58 1786.76 1075.52 L 1797.03 1058.98 C 1810.81 1068.5 1823.36 1075.69 1840.97 1072.95 C 1848.65 1071.76 1856.31 1065.31 1853.69 1057.02 C 1850.58 1049.89 1837.32 1046.22 1830.02 1044.91 C 1802.77 1040.01 1777.57 1024.93 1796.42 994.719 C 1802.7 984.652 1812.04 981.686 1823.29 979.174 z" />
      <path d="M 1266.98 939.821 L 1293.02 939.95 L 1293.03 1066.58 L 1358.72 1066.65 L 1358.8 1089.73 L 1266.88 1089.69 L 1266.98 939.821 z" />
      <path d="M 1627.11 939.241 L 1650.97 939.358 L 1650.98 1089.81 L 1627.17 1089.88 C 1626.5 1040.3 1626.89 988.911 1627.11 939.241 z" />
    </svg>
  );
}

/** Phosphor paths, 256 viewBox. */
export const P = {
  copy: "M216,28H88A12,12,0,0,0,76,40V76H40A12,12,0,0,0,28,88V216a12,12,0,0,0,12,12H168a12,12,0,0,0,12-12V180h36a12,12,0,0,0,12-12V40A12,12,0,0,0,216,28ZM156,204H52V100H156Zm48-48H180V88a12,12,0,0,0-12-12H100V52H204Z",
  pencil:
    "M230.14,70.54,185.46,25.85a20,20,0,0,0-28.29,0L33.86,149.17A19.85,19.85,0,0,0,28,163.31V208a20,20,0,0,0,20,20H92.69a19.86,19.86,0,0,0,14.14-5.86L230.14,98.82a20,20,0,0,0,0-28.28ZM91,204H52V165l84-84,39,39ZM192,103,153,64l18.34-18.34,39,39Z",
  // link-simple rather than link: the diagonal chain silts up at 13px, where
  // this one still reads as two links meeting.
  link: "M87.5,151.52l64-64a12,12,0,0,1,17,17l-64,64a12,12,0,0,1-17-17Zm131-114a60.08,60.08,0,0,0-84.87,0L103.51,67.61a12,12,0,0,0,17,17l30.07-30.06a36,36,0,0,1,50.93,50.92L171.4,135.52a12,12,0,1,0,17,17l30.08-30.06A60.09,60.09,0,0,0,218.45,37.55ZM135.52,171.4l-30.07,30.08a36,36,0,0,1-50.92-50.93l30.06-30.07a12,12,0,0,0-17-17L37.55,133.58a60,60,0,0,0,84.88,84.87l30.06-30.07a12,12,0,0,0-17-17Z",
  search:
    "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z",
  split:
    "M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60h72V196H44ZM212,196H140V60h72Z",
  sidebar:
    "M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36ZM44,60H76V196H44ZM212,196H100V60H212Z",
  trash:
    "M216,48H40a12,12,0,0,0,0,24h4V208a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V72h4a12,12,0,0,0,0-24ZM188,204H68V72H188ZM76,20A12,12,0,0,1,88,8h80a12,12,0,0,1,0,24H88A12,12,0,0,1,76,20Z",
} as const;

export const ICON_BUTTON =
  "flex h-6 w-6 items-center justify-center rounded text-[#D1D5DB] hover:bg-[#2E2E2E] hover:text-white";

/**
 * The track a settings row flips. Presentation only: the row button carries
 * the switch role and the checked state, this just draws it.
 *
 * The off track is darker than the row's hover surface, not the same #2E2E2E,
 * so it stays visible under the pointer.
 */
export function Switch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors duration-150 motion-reduce:transition-none ${
        on ? "bg-[#E6E8EC]" : "bg-[#17181B]"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 size-2.5 rounded-full transition-transform duration-150 motion-reduce:transition-none ${
          on ? "translate-x-2.5 bg-[#17181B]" : "bg-[#84848C]"
        }`}
      />
    </span>
  );
}

/** A share that is live: the light's Ember, breathing, so "live" reads as the rail does. */
export function LiveDot({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`leglas-live-dot block size-1.5 rounded-full ${className}`} />;
}

/** The mark on the share control: an arrow leaving a tray. */
export function ShareGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 16 16"
      width={size}
    >
      <path d="M8 9.75V2.75" />
      <path d="m5.25 5.5 2.75-2.75 2.75 2.75" />
      <path d="M3.25 8.75v3.5a1.5 1.5 0 0 0 1.5 1.5h6.5a1.5 1.5 0 0 0 1.5-1.5v-3.5" />
    </svg>
  );
}

/** The small spinner the status card and the share panel share. */
export function Spinner({ size = 3 }: { size?: 3 | 3.5 }) {
  return (
    <span
      aria-hidden
      className={`block ${
        size === 3 ? "size-3" : "size-3.5"
      } shrink-0 animate-spin rounded-full border-[1.5px] border-white/15 border-t-white/70 motion-reduce:animate-none`}
    />
  );
}

/** The amber triangle a failure wears, the same one everywhere it appears. */
export function Warning({ size = 12 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-amber-400/90"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width={size}
    >
      <path d="M8 2.6 14.6 13.4H1.4Z" />
      <path d="M8 6.8v2.7" />
      <path d="M8 11.6h.01" />
    </svg>
  );
}

export function PIcon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden fill="currentColor" height={size} viewBox="0 0 256 256" width={size}>
      <path d={d} />
    </svg>
  );
}

/**
 * A dark bubble 8px off the control, with a 300ms first-hover delay and a
 * 300ms warm window so neighbouring controls answer instantly. Enters on a
 * slightly overshooting rise; closes on activation.
 */
let tipWarmUntil = 0;

export function Tip({
  children,
  label,
  side = "top",
  wide = false,
}: {
  children: React.ReactNode;
  label: React.ReactNode;
  side?: "right" | "top";
  /**
   * Let the label wrap inside a fixed width instead of running on one line.
   * A tip names a control in a few words; a card explains where a direction
   * came from, and that is a sentence someone typed.
   */
  wide?: boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tip, setTip] = useState<{
    at: Placement;
    out: boolean;
    shift: number;
    x: number;
    y: number;
  } | null>(null);

  /**
   * Nudge the label back on screen once it has been measured.
   *
   * Placing from the anchor alone puts it off the top in a top corner and past
   * the right edge in the bottom right, which is where the floating widget
   * lives. Corrections run before paint, so nothing is seen out of place, and
   * they converge: a pass that changes nothing returns null.
   *
   * The label is a dependency because it can change while the tip is open:
   * clicking the fold chevron swaps "Show 2 variants" for the wider "Fold the
   * variants away" without closing it, and a fit measured for the short label
   * left the long one clipped by the rail edge.
   */
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    const control = anchorRef.current?.firstElementChild;
    if (!tip || tip.out || !bubble || !control) return;
    // Layout size, not the painted rect: the label enters at scale(0.8), so
    // measuring the rect mid-animation reads it narrower than it lands and
    // under-corrects. Transforms do not touch offsetWidth.
    const corrected = placeTip(
      tip,
      { height: bubble.offsetHeight, width: bubble.offsetWidth },
      control.getBoundingClientRect(),
      { height: window.innerHeight, width: window.innerWidth },
    );
    if (corrected) {
      setTip((current) => (current ? { ...current, ...corrected } : current));
    }
  }, [label, tip?.at, tip?.out, tip?.shift, tip?.x, tip?.y]);

  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const open = () => {
    const control = anchorRef.current?.firstElementChild;
    if (!control) return;
    const rect = control.getBoundingClientRect();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setTip(
      side === "top"
        ? { at: "top", out: false, shift: 0, x: rect.left + rect.width / 2, y: rect.top - 8 }
        : { at: "right", out: false, shift: 0, x: rect.right + 8, y: rect.top + rect.height / 2 },
    );
  };
  const enter = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(open, Date.now() < tipWarmUntil ? 0 : 300);
  };
  const close = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    tipWarmUntil = Date.now() + 300;
    setTip((current) => (current && !current.out ? { ...current, out: true } : current));
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setTip(null), 120);
  };

  return (
    <span
      className="contents"
      onBlur={close}
      onFocus={(event) => {
        if ((event.target as HTMLElement).matches(":focus-visible")) open();
      }}
      onPointerDown={close}
      onPointerEnter={enter}
      onPointerLeave={close}
      ref={anchorRef}
    >
      {children}
      {tip && (
        <span
          aria-hidden
          className="pointer-events-none fixed z-[60]"
          style={{ left: tip.x + tip.shift, top: tip.y }}
        >
          <span
            className={`block ${
              {
                bottom: "-translate-x-1/2",
                right: "-translate-y-1/2",
                top: "-translate-x-1/2 -translate-y-full",
              }[tip.at]
            }`}
          >
            <span
              className={`leglas-tip block rounded-lg border border-white/10 bg-[#171717] px-2 py-1 text-xs font-medium text-white shadow-lg ${
                wide ? "w-64 whitespace-normal" : "whitespace-nowrap"
              } ${tip.out ? `leglas-tip-out-${tip.at}` : `leglas-tip-in-${tip.at}`}`}
              ref={bubbleRef}
            >
              {label}
            </span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * The name, made editable where it sits.
 *
 * It carries the title's own type and line height and draws its edge with a
 * ring rather than a border, because a ring takes no space: the row keeps its
 * exact height, and nothing below it moves while a name is being changed. The
 * caller owns the surrounding layout and shows the error in its own slot.
 *
 * Submitting and clicking away both commit, and they are told apart because
 * they deserve different treatment when the name is refused: a name typed and
 * entered should be correctable where it stands, while someone who has already
 * moved on should not be dragged back into a field they left.
 */
export function RenameForm({
  error,
  initial,
  label,
  onCancel,
  onCommit,
}: {
  error?: string | null;
  initial: string;
  label: string;
  onCancel: () => void;
  onCommit: (value: string, via: "blur" | "submit") => void;
}) {
  const cancelled = useRef(false);
  // A refused submit leaves the form standing, so the guard the submit raised
  // has to come back down or the corrected name would never commit on blur.
  useEffect(() => {
    if (error) cancelled.current = false;
  });

  return (
    <form
      className="leglas-rename min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("name");
        cancelled.current = true;
        onCommit(typeof value === "string" ? value.trim() : "", "submit");
      }}
    >
      <input
        aria-describedby={error ? "leglas-rename-error" : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={label}
        autoFocus
        className={`-mx-1 block w-[calc(100%+0.5rem)] rounded-[4px] bg-transparent px-1 py-0 text-sm font-medium leading-5 text-white outline-none ring-1 ${
          error ? "ring-amber-400/60" : "ring-[#D1D5DB]/45 focus:ring-[#D1D5DB]/70"
        }`}
        defaultValue={initial}
        name="name"
        onBlur={(event) => {
          if (cancelled.current) return;
          onCommit(event.currentTarget.value.trim(), "blur");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            cancelled.current = true;
            onCancel();
          }
        }}
        type="text"
      />
    </form>
  );
}

const TOAST_DOT = {
  danger: "bg-amber-300",
  info: "bg-[#9CA3AF]",
  success: "bg-emerald-300",
} as const;

/** How long the leaving animation runs; the toast holds its slot until then. */
const TOAST_OUT_MS = 140;

function ToastItem({ onDismiss, toast }: { onDismiss: () => void; toast: Toast }) {
  const [out, setOut] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** What is left of the toast's time, so a pause resumes instead of restarting. */
  const remaining = useRef(toast.ttl);
  const outTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const leave = () => {
    if (outTimer.current) return;
    setOut(true);
    outTimer.current = setTimeout(onDismiss, TOAST_OUT_MS);
  };

  // A toast holding an undo must not expire out from under the cursor reaching
  // for it, so hovering or focusing it stops the clock where it stands.
  const paused = hovered || focused;
  useEffect(() => {
    if (out || paused || remaining.current === null) return;
    const startedAt = Date.now();
    const timer = setTimeout(leave, remaining.current);
    return () => {
      clearTimeout(timer);
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [out, paused]);

  useEffect(
    () => () => {
      if (outTimer.current) clearTimeout(outTimer.current);
    },
    [],
  );

  // The surface is lighter than the rail it sits in, so a toast reads as
  // something that arrived rather than another panel that was always there.
  return (
    <li
      className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border border-white/10 bg-[#2E2E2E] px-3 py-2.5 shadow-xl shadow-black/40 ${
        out ? "leglas-toast-out" : "leglas-toast-in"
      }`}
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <span aria-hidden className={`mt-[5px] size-1.5 shrink-0 rounded-full ${TOAST_DOT[toast.tone]}`} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-snug text-[#E8E8EA]">{toast.message}</span>
        {toast.detail ? (
          <span
            className="mt-1 block cursor-text select-text break-all text-[10px] leading-snug text-[#9CA3AF]"
            data-selectable=""
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {toast.detail}
          </span>
        ) : null}
        {toast.note ? (
          <span className="mt-1 block text-[11px] leading-snug text-[#9CA3AF]">{toast.note}</span>
        ) : null}
      </span>
      {toast.action ? (
        <button
          className="shrink-0 rounded px-1 py-0.5 text-[11px] font-medium text-white underline decoration-white/30 underline-offset-2 transition-colors hover:decoration-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
          onClick={() => {
            toast.action?.run();
            leave();
          }}
          type="button"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        aria-label="Dismiss"
        className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-[#84848C] transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#D1D5DB]/60"
        onClick={leave}
        type="button"
      >
        <svg className="size-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 10 10">
          <path d="M2.5 2.5 7.5 7.5M7.5 2.5 2.5 7.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

/**
 * Outcomes, stacked at the foot of the rail rather than over the stage.
 *
 * Everything else in this chrome stays off the design being judged, and a
 * toast is no different: it belongs with the rows whose actions raised it.
 * Newest sits at the bottom, nearest where the eye already is. With the rail
 * collapsed there is no rail to sit in, so the stack steps just clear of it.
 */
export function Toasts({
  bottom,
  left,
  onDismiss,
  toasts,
  width,
}: {
  bottom: number;
  left: number;
  onDismiss: (id: number) => void;
  toasts: readonly Toast[];
  width: number;
}) {
  return (
    <ol
      aria-live="polite"
      className={`pointer-events-none fixed z-40 flex flex-col gap-2 transition-[bottom,left,width] duration-200 ${EASE} motion-reduce:transition-none`}
      style={{ bottom, left, width }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} onDismiss={() => onDismiss(toast.id)} toast={toast} />
      ))}
    </ol>
  );
}

/** Shaped like the page it resolves into, so the wait reads as loading rather than breakage. */
export function SkeletonOverlay({ loaded }: { loaded: boolean }) {
  return (
    <div
      aria-hidden
      className={`absolute inset-0 overflow-hidden bg-white transition-opacity duration-700 ${EASE} ${
        loaded ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div>
        <div className="mx-auto mt-6 h-12 w-[400px] max-w-[80%] rounded-full bg-neutral-200/80" />
        <div className="mx-auto mt-24 grid w-full max-w-5xl grid-cols-[1.05fr_0.95fr] items-start gap-16 px-12 max-[900px]:grid-cols-1">
          <div>
            <div className="h-14 w-4/5 rounded-lg bg-neutral-200" />
            <div className="mt-3 h-14 w-3/5 rounded-lg bg-neutral-200" />
            <div className="mt-8 h-4 w-full max-w-[420px] rounded bg-neutral-200/80" />
            <div className="mt-2 h-4 w-4/5 max-w-[360px] rounded bg-neutral-200/80" />
            <div className="mt-10 h-12 w-44 rounded-full bg-neutral-200" />
          </div>
          <div className="h-[420px] w-60 justify-self-center rounded-[2.5rem] bg-neutral-200 max-[900px]:hidden" />
        </div>
      </div>
      {/* One diagonal band sweeps the skeleton, a shimmer in place of a pulse. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
        <div
          className="absolute inset-0 -translate-x-full animate-[leglas-skeleton-sweep_1.6s_ease-in-out_infinite]"
          style={{
            background:
              "linear-gradient(100deg, transparent 32%, rgba(255,255,255,0.55) 50%, transparent 68%)",
          }}
        />
      </div>
      <span className="absolute bottom-4 right-5 flex items-center gap-2">
        <ThinkingOrb aria-label="" size={20} state={MOOD} theme="light" />
        <span className="leglas-shimmer-text text-xs font-medium">Loading preview…</span>
      </span>
    </div>
  );
}

/** Shown when a preview never loads: a quiet title, the reason, one affordance. */
/**
 * Where a branch's design will be, until its checkout is running.
 *
 * A branch preview is a whole other copy of the project: checked out,
 * installed and served. That used to happen before the interface appeared,
 * which cost every session the price of every branch whether or not anyone
 * opened one. Now it happens when you open it, and this is the seconds in
 * between, which is worth saying plainly rather than spinning at.
 */
export function BranchOverlay({
  branch,
  onStart,
  state,
}: {
  branch: string;
  onStart: () => void;
  state: BranchPreviewState;
}) {
  if (state.status === "failed") {
    return <ErrorOverlay onReload={onStart} reason={state.reason} />;
  }
  // `ready` never reaches here, because the pane renders the design instead.
  // Saying so in the narrowing rather than assuming it keeps this honest if
  // that ever stops being true.
  const line =
    state.status === "starting"
      ? {
          "checking out": `Checking out ${branch}`,
          installing: "Installing what it needs",
          starting: "Starting its dev server",
        }[state.phase]
      : `Opening ${branch}`;
  return (
    <div
      aria-live="polite"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center"
    >
      <span className="size-4 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800 motion-reduce:animate-none" />
      <div className="max-w-xs">
        <p className="text-sm font-medium text-neutral-800">{line}</p>
        <p className="mt-1 text-xs leading-snug text-neutral-500">
          A branch runs in its own checkout, built the first time you open it this session.
        </p>
      </div>
    </div>
  );
}

export function ErrorOverlay({ onReload, reason }: { onReload: () => void; reason: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white p-6 text-center"
      role="alert"
    >
      <div className="max-w-xs">
        <p className="text-sm font-medium text-neutral-800">Preview didn’t load</p>
        <p className="mt-1 text-xs leading-snug text-neutral-500">{reason}</p>
      </div>
      <button
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700"
        onClick={onReload}
        type="button"
      >
        Reload
      </button>
    </div>
  );
}

/**
 * The marks of the agents Leglas can run, so the selector reads before it is
 * read. Claude and Cursor are the official paths as distributed by
 * simple-icons; the Codex mark is the product's own, wearing the blue of its
 * app icon (sampled from the icon OpenAI ships) with the prompt kept white.
 * Custom commands get no mark on purpose.
 */
export function BrandMark({ id, size = 14 }: { id: string; size?: number }) {
  const gid = useId();
  if (id === "claude") {
    return (
      <svg aria-hidden="true" fill="#D97757" height={size} viewBox="0 0 24 24" width={size}>
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    );
  }
  if (id === "cursor") {
    return (
      <svg aria-hidden="true" fill="currentColor" height={size} viewBox="0 0 24 24" width={size}>
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      </svg>
    );
  }
  if (id === "codex") {
    return (
      <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#9B96F2" />
            <stop offset="0.55" stopColor="#5E6CF6" />
            <stop offset="1" stopColor="#3B32EF" />
          </linearGradient>
        </defs>
        <path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457z" fill={`url(#${gid})`} />
        <path d="M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zM12.728 14.547a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" fill="#F4F4FE" />
      </svg>
    );
  }
  if (id === "custom") {
    // No vendor to borrow a mark from: a terminal prompt in the text's own
    // colour says "your command" without pretending to be a brand.
    return (
      <svg
        aria-hidden="true"
        fill="none"
        height={size}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width={size}
      >
        <path d="m5 6 6 6-6 6M13 18h6" />
      </svg>
    );
  }
  return null;
}
