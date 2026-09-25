import { describe, expect, test } from "vitest";

import { isBoolean, isJsonRecord, isNumber, isString, parseJson } from "./json.js";

describe("JSON boundaries", () => {
  test.each([null, undefined, [], 1, "text", true])(
    "refuses %j as an object container",
    (value) => {
      expect(isJsonRecord(value)).toBe(false);
    },
  );

  test("does not coerce primitive values", () => {
    expect([isString(""), isString(1)]).toEqual([true, false]);
    expect([isNumber(0), isNumber("0"), isNumber(NaN)]).toEqual([true, false, true]);
    expect([isBoolean(false), isBoolean("false")]).toEqual([true, false]);
  });

  test("leaves malformed JSON to the caller's error handling", () => {
    expect(() => parseJson("{")).toThrow(SyntaxError);
  });
});
