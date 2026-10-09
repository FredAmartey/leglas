// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Tip } from "./kit.js";
import { must } from "../must.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/**
 * Mounts a tip on a button inside `#holder` of `html`, then hovers the button
 * for long enough that its tip opens. Returns the button and the open label.
 */
function hovered(html: string, tip: ReactElement) {
  document.body.innerHTML = html;
  root = createRoot(must(document.getElementById("holder"), "the holder"));
  act(() => root.render(tip));

  const control = must(document.querySelector("#holder button"), "the button");
  act(() => {
    control.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });

  return { control, label: document.querySelector(".leglas-tip") };
}

/**
 * The rail fades its edges with a mask on the scrolling list, and a mask clips
 * everything inside it, `position: fixed` included. A row's card opens over the
 * stage, so it was in the page at full opacity and never painted. Tests can't
 * see paint, but can see the cause: the label inside whatever clips its
 * control.
 */
test("a tip's label mounts on the shell, outside whatever clips its control", () => {
  const { label } = hovered(
    `<main data-leglas-shell=""><div id="holder"></div></main>`,
    <Tip label="Variant of Counter" side="right" wide>
      <button type="button">Olive</button>
    </Tip>,
  );

  expect(label?.textContent).toBe("Variant of Counter");
  expect(document.getElementById("holder")?.contains(label)).toBe(false);
  // Still inside the shell, where its typeface and smoothing are set.
  expect(document.querySelector("main")?.contains(label)).toBe(true);
});

test("inside a modal dialog the label stays in the dialog, which is the top layer", () => {
  const { label } = hovered(
    `<main data-leglas-shell=""><dialog open><div id="holder"></div></dialog></main>`,
    <Tip label="Copy the link">
      <button type="button">Copy</button>
    </Tip>,
  );

  expect(label).not.toBeNull();
  expect(document.querySelector("dialog")?.contains(label)).toBe(true);
  expect(document.getElementById("holder")?.contains(label)).toBe(false);
});

test("with no shell around it the label goes to the body, and leaves when the pointer does", () => {
  // A shell elsewhere on the page isn't around the control, so the label
  // doesn't belong there either.
  const { control, label } = hovered(
    `<main data-leglas-shell=""></main><div id="holder"></div>`,
    <Tip label="Open updates">
      <button type="button">1.1.1</button>
    </Tip>,
  );

  expect(document.body.contains(label)).toBe(true);
  expect(document.getElementById("holder")?.contains(label)).toBe(false);
  expect(label?.closest("[data-leglas-shell]")).toBeNull();

  act(() => {
    control.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(120);
  });
  expect(document.querySelector(".leglas-tip")).toBeNull();
});
