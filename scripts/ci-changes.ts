#!/usr/bin/env bun

const conditionalJobs = [
  "builds",
  "unit",
  "cloudflare-adapters",
  "cloudflare-infra",
  "browser",
  "security-sast",
  "security-sca",
] as const;
type ConditionalJob = (typeof conditionalJobs)[number];
type CheckPlan = Readonly<Record<ConditionalJob, boolean>>;

const runtimeJobs: ReadonlyArray<ConditionalJob> = [
  "builds",
  "unit",
  "cloudflare-adapters",
  "cloudflare-infra",
  "browser",
  "security-sast",
];
const ownedPaths: ReadonlyArray<{
  readonly prefix: string;
  readonly jobs: ReadonlyArray<ConditionalJob>;
}> = [
  { prefix: "apps/server/", jobs: runtimeJobs },
  { prefix: "apps/cli/", jobs: runtimeJobs },
  { prefix: "infra/cloudflare/", jobs: runtimeJobs },
  { prefix: "apps/web/", jobs: ["builds", "unit", "cloudflare-infra", "browser", "security-sast"] },
];
const scannerPaths = {
  ".fluidattacks/sca.yaml": ["security-sca"],
  ".fluidattacks/sast.yaml": ["security-sast"],
  ".gitleaks.toml": [],
  ".trufflehog-exclude-paths.txt": [],
  ".fluidattacks/secrets.yaml": [],
} as const;

const isProse = (path: string): boolean =>
  path.endsWith(".md") &&
  (!path.includes("/") ||
    ["docs/", ".agents/", ".claude/", ".patterns/", "research/"].some((prefix) =>
      path.startsWith(prefix)
    ) ||
    path.endsWith("/ARCHITECTURE.md"));

const isDependencyInput = (path: string): boolean =>
  /(?:^|\/)(?:package\.json|bunfig\.toml|[^/]*lock[^/]*|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.(?:py|cfg)|Cargo\.toml|go\.(?:mod|sum)|composer\.json|Gemfile|[^/]*\.gemspec|pom\.xml|[^/]*\.gradle(?:\.kts)?|gradle\.properties|pubspec\.yaml|[^/]*\.(?:csproj|fsproj)|packages\.config|Dockerfile[^/]*)$/u.test(
    path
  );

const checksForPath = (path: string): ReadonlyArray<ConditionalJob> => {
  // Prose is still formatted and policy-checked by the unconditional workspace gate.
  if (isProse(path)) return [];
  if (isDependencyInput(path)) return conditionalJobs;
  const scanner = Object.entries(scannerPaths).find(([scannerPath]) => scannerPath === path);
  if (scanner !== undefined) return scanner[1];
  // Shared tooling, workflow definitions, executable evidence, and new packages
  // have no narrower ownership guarantee.
  return ownedPaths.find(({ prefix }) => path.startsWith(prefix))?.jobs ?? conditionalJobs;
};

/** Selects expensive PR checks; unrecognized paths run everything rather than silently losing coverage. */
export const selectChecks = (paths: ReadonlyArray<string>): CheckPlan => {
  const selected: Record<ConditionalJob, boolean> = {
    builds: false,
    unit: false,
    "cloudflare-adapters": false,
    "cloudflare-infra": false,
    browser: false,
    "security-sast": false,
    "security-sca": false,
  };
  for (const path of paths) {
    for (const job of checksForPath(path)) selected[job] = true;
  }
  return selected;
};

if (import.meta.main) {
  const base = Bun.env.PR_BASE_SHA;
  const head = Bun.env.PR_HEAD_SHA;
  const output = Bun.env.GITHUB_OUTPUT;
  if (base === undefined || head === undefined || output === undefined) {
    throw new Error("PR_BASE_SHA, PR_HEAD_SHA, and GITHUB_OUTPUT are required");
  }
  if (!/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{40}$/u.test(head) || output.length === 0) {
    throw new Error("PR_BASE_SHA, PR_HEAD_SHA, and GITHUB_OUTPUT are required");
  }
  // Both sides of a rename must be considered, including moves out of a code tree.
  // Full Git history avoids the changed-file API's pagination and file-count limits.
  const diff = Bun.spawnSync([
    "git",
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    `${base}...${head}`,
  ]);
  if (diff.exitCode !== 0) throw new Error("Cannot determine the PR diff");
  const paths = new TextDecoder().decode(diff.stdout).split("\0").filter(Boolean);
  const plan = selectChecks(paths);
  const lines = Object.entries(plan).map(([job, selected]) => `${job}=${selected}`);
  const file = Bun.file(output);
  await Bun.write(output, `${(await file.exists()) ? await file.text() : ""}${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
