import { describe, expect, test } from "vitest";

import { baselineFrom } from "./baseline.js";

describe("baselineFrom", () => {
  test("re-exports the component instead of copying it", () => {
    const result = baselineFrom("hero", "src/Hero.tsx", "export function Hero() { return null; }");

    expect(result).not.toBeNull();
    expect(result?.contents).toContain('import { Hero } from "../../../src/Hero"');
    expect(result?.contents).toContain("<Hero />");
  });

  test("keeps the baseline live, so it tracks the real component", () => {
    // The point of re-exporting rather than copying: edit the real component
    // and the baseline changes with it, so a comparison is never against a
    // stale duplicate of your own code.
    const result = baselineFrom("hero", "src/Hero.tsx", "export function Hero() {}");

    expect(result?.contents).not.toContain("return (");
  });

  test("drops the extension from the import specifier, as bundlers expect", () => {
    const result = baselineFrom("hero", "src/Hero.tsx", "export function Hero() {}");
    const importLine = (result?.contents ?? "").split("\n").find((line) => line.startsWith("import"));

    expect(importLine).toContain('"../../../src/Hero"');
    expect(importLine).not.toContain(".tsx");
  });

  test("finds a default export and gives it a local name", () => {
    const result = baselineFrom("hero", "src/Hero.tsx", "export default function Hero() {}");

    expect(result?.contents).toContain('import Hero from "../../../src/Hero"');
  });

  test("handles an arrow component assigned to a const", () => {
    const result = baselineFrom("hero", "src/Hero.tsx", "export const Hero = () => null;");

    expect(result?.contents).toContain("{ Hero }");
  });

  test("computes the path from a nested surface directory", () => {
    const result = baselineFrom("hero", "app/components/marketing/Hero.tsx", "export function Hero() {}");

    expect(result?.contents).toContain('"../../../app/components/marketing/Hero"');
  });

  test("refuses a file with no component it can name", () => {
    expect(baselineFrom("hero", "src/util.ts", "const x = 1;")).toBeNull();
  });

  test("ignores a lowercase export, which is not a component", () => {
    expect(baselineFrom("hero", "src/util.ts", "export function helper() {}")).toBeNull();
  });

  test("names the file it re-exports, so the generated code explains itself", () => {
    const result = baselineFrom("hero", "src/Hero.tsx", "export function Hero() {}");

    expect(result?.contents).toContain("src/Hero.tsx");
  });
});
