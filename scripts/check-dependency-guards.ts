#!/usr/bin/env bun

const repoRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const runGraph = () => {
  const process = Bun.spawnSync(["bun", "tools/depcruise/run.mjs"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: process.exitCode,
    report: `${decode(process.stdout)}\n${decode(process.stderr)}`,
  };
};

const suffix = process.pid;
const positiveProbe = `src/core/audit/dependency-positive-probe-${suffix}.ts`;
const negativeProbe = `src/core/audit/dependency-negative-probe-${suffix}.ts`;

try {
  await Bun.write(
    `${repoRoot}${positiveProbe}`,
    `import { UserId } from "~/core/identity/reference";\nimport { AgentTokenId } from "~/core/tokens/reference";\n\nexport const dependencyPositiveProbe = [UserId, AgentTokenId];\n`
  );

  const positive = runGraph();
  if (positive.exitCode !== 0) {
    throw new Error(
      `A core sibling reference import must be allowed by the module graph.\n${positive.report}`
    );
  }

  await Bun.write(
    `${repoRoot}${negativeProbe}`,
    `import { CategoryId } from "~/core/categories/reference";\nimport { Category } from "~/core/categories/model";\nimport { CategoryNotFound } from "~/core/categories/errors";\nimport { findKnownCaptureCategory } from "~/core/categories/rules";\nimport { categoryIds } from "~/core/categories/taxonomy";\n\nexport const dependencyNegativeProbe = [\n  CategoryId,\n  Category,\n  CategoryNotFound,\n  findKnownCaptureCategory,\n  categoryIds,\n];\n`
  );

  const negative = runGraph();
  const forbiddenTargets = [
    "src/core/categories/model.ts",
    "src/core/categories/rules.ts",
    "src/core/categories/errors.ts",
    "src/core/categories/taxonomy.ts",
  ];
  const missingTargets = forbiddenTargets.filter(
    (target) => !negative.report.includes(`${negativeProbe} → ${target}`)
  );

  if (negative.exitCode === 0 || missingTargets.length > 0) {
    throw new Error(
      "Sibling core implementation imports must be rejected by the module graph.\n" +
        `Missing violations: ${missingTargets.join(", ") || "none; the command unexpectedly passed"}.\n` +
        negative.report
    );
  }
} finally {
  for (const path of [positiveProbe, negativeProbe]) {
    const file = Bun.file(`${repoRoot}${path}`);
    if (await file.exists()) await file.delete();
  }
}

process.stdout.write(
  "dependency guard probes passed: sibling reference allowed; sibling implementation rejected\n"
);
