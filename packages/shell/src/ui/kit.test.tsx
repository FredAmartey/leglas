// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Tip } from "./kit.js";

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

/** Hover the control for long enough that its tip opens. */
function hover(control: Element): void {
  act(() => {
    control.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

/**
 * The rail fades its top and bottom edges with a mask on the scrolling list,
 * and a mask clips everything inside it, a `position: fixed` child included.
 * A row's card opens to the right, over the stage, so it was in the page at
 * full opacity and never painted. Nothing in a test can see paint, but it can
 * see the cause: the label was a descendant of whatever clips its control.
 */
test("a tip's label mounts on the shell, outside whatever clips its control", () => {
  document.body.innerHTML = `<main data-leglas-shell=""><div id="masked-list"></div></main>`;
  const shell = document.querySelector("main") as HTMLElement;
  const list = document.getElementById("masked-list") as HTMLElement;
  root = createRoot(list);
  act(() =>
    root.render(
      <Tip label="Variant of Counter" side="right" wide>
        <button type="button">Olive</button>
      </Tip>,
    ),
  );

  hover(list.querySelector("button") as Element);

  const label = document.querySelector(".leglas-tip");
  expect(label?.textContent).toBe("Variant of Counter");
  expect(list.contains(label)).toBe(false);
  // Still inside the shell, because that is where the typeface and the
  // smoothing it is drawn with are set.
  expect(shell.contains(label)).toBe(true);
});

test("inside a modal dialog the label stays in the dialog, which is the top layer", () => {
  document.body.innerHTML = `<main data-leglas-shell=""><dialog open><div id="body"></div></dialog></main>`;
  const dialog = document.querySelector("dialog") as HTMLElement;
  root = createRoot(document.getElementById("body") as HTMLElement);
  act(() =>
    root.render(
      <Tip label="Copy the link">
        <button type="button">Copy</button>
      </Tip>,
    ),
  );

  hover(dialog.querySelector("button") as Element);

  const label = document.querySelector(".leglas-tip");
  expect(label).not.toBeNull();
  expect(dialog.contains(label)).toBe(true);
  expect(document.getElementById("body")?.contains(label)).toBe(false);
});

test("with no shell around it the label goes to the body, and leaves when the pointer does", () => {
  document.body.innerHTML = `<div id="app"></div>`;
  const app = document.getElementById("app") as HTMLElement;
  root = createRoot(app);
  act(() =>
    root.render(
      <Tip label="Open updates">
        <button type="button">1.1.1</button>
      </Tip>,
    ),
  );
  const control = app.querySelector("button") as Element;

  hover(control);
  const label = document.querySelector(".leglas-tip");
  expect(label?.parentElement?.parentElement?.parentElement).toBe(document.body);

  act(() => {
    control.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(120);
  });
  expect(document.querySelector(".leglas-tip")).toBeNull();
});
