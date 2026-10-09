import { expect, test } from "vitest";

import { checkName } from "./naming.js";

/** Hero A renamed to Warm; Hero B left as it came from the config. */
const names = new Map([
  ["Hero A", "Warm"],
  ["Hero B", "Hero B"],
]);

test("checkName takes a fresh name, trimmed and with its whitespace collapsed", () => {
  expect(checkName("Cool", "Hero A", names)).toEqual({ kind: "set", value: "Cool" });
  // So two names cannot differ by a space.
  expect(checkName("  Cool   morning ", "Hero A", names)).toEqual({
    kind: "set",
    value: "Cool morning",
  });
  // "Hero A" answers to Warm now, so the name is free; refusing it for clashing
  // with something invisible reads as a bug.
  expect(checkName("Hero A", "Hero B", names)).toEqual({ kind: "set", value: "Hero A" });
});

test("checkName puts the config's title back, or changes nothing", () => {
  // An emptied field, or the title typed back, is a reset, not a rename.
  expect(checkName("   ", "Hero A", names)).toEqual({ kind: "reset", value: "Hero A" });
  expect(checkName("Hero A", "Hero A", names)).toEqual({ kind: "reset", value: "Hero A" });
  // Clearing a direction never renamed, or retyping the current name.
  expect(checkName("", "Hero B", names)).toEqual({ kind: "same" });
  expect(checkName("Warm", "Hero A", names)).toEqual({ kind: "same" });
});

// Two identical rail rows can't be told apart, so this is refused.
test("checkName refuses a name another direction already shows, as it reads on screen", () => {
  expect(checkName("Hero B", "Hero A", names)).toEqual({ kind: "taken", by: "Hero B" });
  // Whatever the casing or spacing.
  expect(checkName("  hero   b  ", "Hero A", names)).toEqual({ kind: "taken", by: "Hero B" });
  expect(checkName("Warm", "Hero B", names)).toEqual({ kind: "taken", by: "Warm" });
});
