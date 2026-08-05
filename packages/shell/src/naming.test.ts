import { describe, expect, test } from "vitest";

import { checkName } from "./naming.js";

/** Hero A renamed to Warm; Hero B left as it came from the config. */
const names = new Map([
  ["Hero A", "Warm"],
  ["Hero B", "Hero B"],
]);

describe("checkName", () => {
  test("takes a fresh name", () => {
    expect(checkName("Cool", "Hero A", names)).toEqual({ kind: "set", value: "Cool" });
  });

  test("trims and collapses whitespace, so two names cannot differ by a space", () => {
    expect(checkName("  Cool   morning ", "Hero A", names)).toEqual({
      kind: "set",
      value: "Cool morning",
    });
  });

  test("an emptied field puts the config's own title back", () => {
    expect(checkName("   ", "Hero A", names)).toEqual({ kind: "reset", value: "Hero A" });
  });

  test("typing the title back is a reset too, not a rename to the same thing", () => {
    expect(checkName("Hero A", "Hero A", names)).toEqual({ kind: "reset", value: "Hero A" });
  });

  test("clearing a direction that was never renamed changes nothing", () => {
    expect(checkName("", "Hero B", names)).toEqual({ kind: "same" });
  });

  test("retyping the current name changes nothing", () => {
    expect(checkName("Warm", "Hero A", names)).toEqual({ kind: "same" });
  });

  // Two identical rows in the rail cannot be told apart, so this is refused
  // rather than written and confusing.
  test("refuses a name another direction already shows", () => {
    expect(checkName("Hero B", "Hero A", names)).toEqual({ kind: "taken", by: "Hero B" });
  });

  test("refuses it whatever the casing or spacing", () => {
    expect(checkName("  hero   b  ", "Hero A", names)).toEqual({ kind: "taken", by: "Hero B" });
  });

  test("names the other direction as it reads on screen", () => {
    expect(checkName("Warm", "Hero B", names)).toEqual({ kind: "taken", by: "Warm" });
  });

  // "Hero A" is that direction's title but it answers to Warm now, so the name
  // is free: refusing it for clashing with something invisible reads as a bug.
  test("allows a title that has been renamed away", () => {
    expect(checkName("Hero A", "Hero B", names)).toEqual({ kind: "set", value: "Hero A" });
  });
});
