#!/usr/bin/env bun

import { sourceScanPlan } from "./partition-source-scan";

const conditionalJobs = [
  "builds",
  "unit",
  "cloudflare-adapters",
  "cloudflare-infra",
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
  "security-sast",
];

const ownedPaths: ReadonlyArray<{
  readonly prefix: string;
  readonly jobs: ReadonlyArray<ConditionalJob>;
}> = [
  { prefix: "apps/server/", jobs: runtimeJobs },
  { prefix: "apps/cli/", jobs: runtimeJobs },
  { prefix: "infra/cloudflare/", jobs: runtimeJobs },
  {
    prefix: "apps/site/",
    jobs: ["builds", "unit", "cloudflare-infra", "security-sast"],
  },
  { prefix: "apps/web/", jobs: ["builds", "unit", "cloudflare-infra", "security-sast"] },
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
  if (isProse(path)) return [];

  if (isDependencyInput(path)) return conditionalJobs;
  const scanner = Object.entries(scannerPaths).find(([scannerPath]) => scannerPath === path);

  if (scanner !== undefined) return scanner[1];

  return ownedPaths.find(({ prefix }) => path.startsWith(prefix))?.jobs ?? conditionalJobs;
};

export const selectChecks = (paths: ReadonlyArray<string>): CheckPlan => {
  const selected: Record<ConditionalJob, boolean> = {
    builds: false,
    unit: false,
    "cloudflare-adapters": false,
    "cloudflare-infra": false,
    "security-sast": false,
    "security-sca": false,
  };

  for (const path of paths) {
    for (const job of checksForPath(path)) selected[job] = true;
  }

  return selected;
};

const deployedStacks = {
  app: ["apps/server/", "apps/web/", "infra/cloudflare/", ".github/workflows/deploy-app.yml"],
  site: ["apps/site/", "apps/server/", "infra/cloudflare/", ".github/workflows/deploy-site.yml"],
  docs: [
    "apps/docs/",
    "infra/docs/",
    "design/",
    "tools/astro/",
    ".github/workflows/docs-publication.yml",
  ],
} as const;

type DeployedStack = keyof typeof deployedStacks;

const sharesDeployInput = (path: string): boolean =>
  isDependencyInput(path) ||
  /^tsconfig[^/]*\.json$/u.test(path) ||
  ["patches/", "scripts/install-", ".github/actions/"].some((prefix) => path.startsWith(prefix));

export const selectStackPlans = (
  paths: ReadonlyArray<string>
): Readonly<Record<DeployedStack, boolean>> => {
  const touches = (stack: DeployedStack): boolean =>
    paths.some(
      (path) =>
        !isProse(path) &&
        (sharesDeployInput(path) || deployedStacks[stack].some((prefix) => path.startsWith(prefix)))
    );

  return { app: touches("app"), site: touches("site"), docs: touches("docs") };
};

export const selectNativeChecks = (paths: ReadonlyArray<string>): boolean =>
  paths.some((path) => {
    if (isProse(path)) return false;

    if (isDependencyInput(path)) return true;

    if (Object.hasOwn(scannerPaths, path)) return false;

    return !["apps/web/", "apps/site/", "apps/docs/", "infra/", ".patterns/", ".repos/"].some(
      (prefix) => path.startsWith(prefix)
    );
  });

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
  const native = selectNativeChecks(paths);
  lines.push(`cli-native=${native}`);

  const stacks = Object.entries(selectStackPlans(paths)).flatMap(([stack, planned]) =>
    planned ? [stack] : []
  );

  lines.push(`plan-stacks=${JSON.stringify(stacks)}`);
  const source = sourceScanPlan({ native, sca: plan["security-sca"] });
  lines.push(`source-partitions=${source.count}`, `source-sca-partition=${source.sca}`);
  const file = Bun.file(output);
  await Bun.write(output, `${(await file.exists()) ? await file.text() : ""}${lines.join("\n")}\n`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
