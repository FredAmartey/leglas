// Reads vitest's JSON report and refuses a run in which any hidden test file
// did not run, ran no tests or did not pass. The exit code of `vitest run`
// is 0 for "every collected test passed", which is also true of a run that
// collected nothing, so the verifier checks the files by name.
//
//   node collected.mjs <vitest.json> <files.txt>
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const [reportPath, listPath] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const expected = readFileSync(listPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

// Exact paths from the working directory, which is the tree under test. A
// suffix match would let a decoy at another/packages/x/y.test.ts stand in
// for the hidden file, since vitest's file arguments are substring filters.
let ok = true;
for (const file of expected) {
  const result = (report.testResults ?? []).find(
    (entry) => relative(process.cwd(), resolve(entry.name)) === file,
  );
  const tests = result?.assertionResults ?? [];
  const failed = tests.filter((test) => test.status !== "passed");
  if (result === undefined) {
    console.log(`${file}: not collected`);
    ok = false;
  } else if (tests.length === 0) {
    console.log(`${file}: ran no tests`);
    ok = false;
  } else if (failed.length > 0) {
    console.log(`${file}: ${failed.length} of ${tests.length} not passed`);
    ok = false;
  } else {
    console.log(`${file}: ${tests.length} passed`);
  }
}
process.exit(ok ? 0 : 1);
