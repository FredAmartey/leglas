/**
 * Materialise the Harbor tasks in evals/tasks from evals/manifest.json.
 *
 * Every task is a real fix from this repository's history. The environment
 * is the repo at the fix's parent commit; the hidden tests are the test
 * files that fix touched, taken from the fix commit; the oracle solution is
 * the fix's source diff with the tests and changelog left out. Those three
 * pieces are derived here so they cannot drift from git. The instruction
 * and task.toml are written by hand and left alone when they exist.
 *
 *   node evals/build.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "evals/manifest.json"), "utf8"));

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

for (const task of manifest.tasks) {
  const dir = join(root, "evals/tasks", task.name);
  const parent = git("rev-parse", `${task.fix}^`).trim();
  const changed = git("diff", "--name-only", parent, task.fix).trim().split("\n");
  const tests = changed.filter((f) => f.endsWith(".test.ts"));
  if (tests.length === 0) throw new Error(`${task.name}: the fix touched no test files`);

  // Hidden tests: the fix commit's version of every test file it touched.
  for (const f of tests) {
    const target = join(dir, "tests/files", f);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git("show", `${task.fix}:${f}`));
  }
  writeFileSync(join(dir, "tests/files.txt"), tests.join("\n") + "\n");
  writeFileSync(join(dir, "tests/test.sh"), readFileSync(join(root, "evals/templates/test.sh"), "utf8"), { mode: 0o755 });
  writeFileSync(join(dir, "tests/collected.mjs"), readFileSync(join(root, "evals/templates/collected.mjs"), "utf8"));

  // Oracle: the fix without its tests or changelog entry.
  const patch = git("diff", parent, task.fix, "--", ".", ":(exclude)*.test.ts", ":(exclude)CHANGELOG.md");
  mkdirSync(join(dir, "solution"), { recursive: true });
  writeFileSync(join(dir, "solution/fix.patch"), patch);
  writeFileSync(join(dir, "solution/solve.sh"), "#!/usr/bin/env bash\nset -euo pipefail\ncd /app\ngit apply --whitespace=nowarn /solution/fix.patch\n", { mode: 0o755 });

  // Environment: the repo at the parent commit, installed and built.
  mkdirSync(join(dir, "environment"), { recursive: true });
  const dockerfile = readFileSync(join(root, "evals/templates/Dockerfile"), "utf8")
    .replaceAll("{{REPO}}", manifest.repo)
    .replaceAll("{{SHA}}", parent)
    .replaceAll("{{PNPM}}", manifest.pnpm);
  writeFileSync(join(dir, "environment/Dockerfile"), dockerfile);

  if (!existsSync(join(dir, "task.toml"))) {
    writeFileSync(
      join(dir, "task.toml"),
      readFileSync(join(root, "evals/templates/task.toml"), "utf8")
        .replaceAll("{{FIX}}", task.fix)
        .replaceAll("{{PARENT}}", parent)
        .replaceAll("{{AREA}}", task.area),
    );
  }
  if (!existsSync(join(dir, "instruction.md"))) {
    writeFileSync(join(dir, "instruction.md"), "TODO: write the instruction for this task.\n");
  }
  console.log(`${task.name}: parent ${parent.slice(0, 7)}, ${tests.length} hidden test file(s), patch ${patch.split("\n").length} lines`);
}
