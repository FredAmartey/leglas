import { describe, expect, test } from "vitest";

import { baselineFrom } from "./baseline.js";

describe("baselineFrom", () => {
  // Re-exporting means editing the real component changes the baseline too.
  // The specifier drops the extension, as bundlers expect, and the comment
  // names the file so the generated code explains itself.
  test("re-exports a named component by a path bundlers resolve, naming its file", () => {
    const contents =
      baselineFrom("hero", "src/Hero.tsx", "export function Hero() { return null; }")?.contents ??
      "";

    expect(contents.split("\n")).toContain('import { Hero } from "../../../src/Hero";');
    expect(contents).toContain("<Hero />");
    expect(contents).toContain("src/Hero.tsx");
  });

  test.each([
    [
      "a default export, given a local name",
      "src/Hero.tsx",
      "export default function Hero() {}",
      'import Hero from "../../../src/Hero";',
    ],
    [
      "an arrow component assigned to a const",
      "src/Hero.tsx",
      "export const Hero = () => null;",
      'import { Hero } from "../../../src/Hero";',
    ],
    [
      "a nested surface directory",
      "app/components/marketing/Hero.tsx",
      "export function Hero() {}",
      'import { Hero } from "../../../app/components/marketing/Hero";',
    ],
  ])("imports %s", (_export, path, source, line) => {
    expect(baselineFrom("hero", path, source)?.contents.split("\n")).toContain(line);
  });

  test.each([
    ["no component it can name", "const x = 1;"],
    ["only a lowercase export, which is not a component", "export function helper() {}"],
  ])("refuses a file with %s", (_why, source) => {
    expect(baselineFrom("hero", "src/util.ts", source)).toBeNull();
  });
});
