import { describe, expect, test } from "vitest";

import { dismissToast, pushToast, TOAST_LIMIT, type Toast } from "./toasts.js";

const toast = (id: number, kind: string): Toast => ({
  id,
  kind,
  message: `toast ${id}`,
  tone: "info",
  ttl: 2600,
});

describe("pushToast", () => {
  test("keeps one toast per removed direction, so each undo survives", () => {
    const first = pushToast([], toast(1, "remove:Hero A"));
    const both = pushToast(first, toast(2, "remove:Hero B"));
    expect(both.map((entry) => entry.kind)).toEqual(["remove:Hero A", "remove:Hero B"]);
  });

  test("moves a superseded kind to the end, where the newest toast belongs", () => {
    const stack = [toast(1, "copy"), toast(2, "remove:Hero A")];
    expect(pushToast(stack, toast(3, "copy")).map((entry) => entry.id)).toEqual([2, 3]);
  });

  test("drops the oldest past the limit rather than growing without end", () => {
    const stack = Array.from({ length: TOAST_LIMIT }, (_, index) =>
      toast(index + 1, `remove:${index}`),
    );

    const result = pushToast(stack, toast(99, "remove:new"));
    expect(result).toHaveLength(TOAST_LIMIT);
    expect(result.at(0)?.id).toBe(2);
    expect(result.at(-1)?.id).toBe(99);
  });
});

test("dismissToast removes only the toast asked for, and nothing once it is gone", () => {
  const stack = [toast(1, "copy"), toast(2, "remove:Hero A")];

  expect(dismissToast(stack, 1).map((entry) => entry.id)).toEqual([2]);
  expect(dismissToast(stack, 9)).toEqual(stack);
});
