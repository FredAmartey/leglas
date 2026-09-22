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

/**
 * The files that decide what build, typecheck and vitest mean: test.sh scores
 * 0 if any differ from the base state. The root four, plus every package's
 * manifest and compiler or bundler configuration, since `pnpm build` and
 * `pnpm -r typecheck` delegate to those, and the root tsconfigs they inherit
 * from.
 */
const GUARDED_ROOT = [
  "vitest.config.ts",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
  ".npmrc",
  ".pnpmfile.cjs",
];

const GUARDED_IN_PACKAGES =
  /^packages\/[^/]+\/(package\.json|tsconfig[^/]*\.json|tsup\.config\.ts|vite[^/]*\.config\.ts|vitest[^/]*\.config\.ts)$/;

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

  // Baseline copies of the files the verifier refuses changes to. They sit
  // beside the hidden tests, which the agent cannot reach, rather than in the
  // tree's own git, which it can rewrite. baseline.txt lists them, so the
  // verifier compares exactly what was captured for this task's base commit.
  // Each copy carries a .snapshot suffix so nothing that scans the tree for
  // manifests, GitHub's dependency graph included, takes eight old lockfiles
  // for eight projects to keep patched.
  // The root list is filtered by what the base commit has: the root
  // tsconfig.json arrived after some of these fixes.
  const guarded = [
    ...GUARDED_ROOT.filter((f) => git("ls-tree", "--name-only", parent, "--", f).trim() === f),
    ...git("ls-tree", "-r", "--name-only", parent, "packages")
      .trim()
      .split("\n")
      .filter((f) => GUARDED_IN_PACKAGES.test(f)),
  ];

  for (const f of guarded) {
    const target = join(dir, "tests/baseline", `${f}.snapshot`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git("show", `${parent}:${f}`));
  }

  writeFileSync(join(dir, "tests/baseline.txt"), guarded.join("\n") + "\n");
  writeFileSync(
    join(dir, "tests/test.sh"),
    readFileSync(join(root, "evals/templates/test.sh"), "utf8"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "tests/collected.mjs"),
    readFileSync(join(root, "evals/templates/collected.mjs"), "utf8"),
  );

  // Oracle: the fix without its tests or changelog entry.
  const patch = git(
    "diff",
    parent,
    task.fix,
    "--",
    ".",
    ":(exclude)*.test.ts",
    ":(exclude)CHANGELOG.md",
  );

  mkdirSync(join(dir, "solution"), { recursive: true });
  writeFileSync(join(dir, "solution/fix.patch"), patch);
  writeFileSync(
    join(dir, "solution/solve.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\ncd /app\ngit apply --whitespace=nowarn /solution/fix.patch\n",
    { mode: 0o755 },
  );

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

  console.log(
    `${task.name}: parent ${parent.slice(0, 7)}, ${tests.length} hidden test file(s), patch ${patch.split("\n").length} lines`,
  );
}
