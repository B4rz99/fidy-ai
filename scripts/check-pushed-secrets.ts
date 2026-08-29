#!/usr/bin/env bun

export {};

const gitObjectNameLength = 40;
const ZERO_SHA = "0".repeat(gitObjectNameLength);
const DEFAULT_BASE_REF = "origin/trunk";

const text = (command: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync([...command], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} failed${stderr.length > 0 ? `: ${stderr}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
};

const requireScanner = (name: "gitleaks" | "trufflehog"): string => {
  const executable = Bun.which(name);
  if (executable !== null) return executable;
  throw new Error(
    `${name} is required by the pre-push hook. Install it with "brew install ${name}" or your platform's package manager.`
  );
};

const pushLines = (await Bun.stdin.text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const pushedTips = pushLines.flatMap((line) => {
  const [, localSha, , remoteSha] = line.split(/\s+/);
  if (localSha === undefined || localSha === ZERO_SHA) return [];
  return [{ localSha, remoteSha }];
});

const scanTargets = (
  pushedTips.length > 0
    ? pushedTips
    : [{ localSha: text(["git", "rev-parse", "HEAD"]), remoteSha: undefined }]
).map(({ localSha, remoteSha }) => {
  const comparisonRef =
    remoteSha === undefined || remoteSha === ZERO_SHA ? DEFAULT_BASE_REF : remoteSha;
  const baseSha = text(["git", "merge-base", comparisonRef, localSha]);
  return { baseSha, localSha };
});

const gitleaks = requireScanner("gitleaks");
const trufflehog = requireScanner("trufflehog");

for (const { baseSha, localSha } of scanTargets) {
  const logRange = `${baseSha}..${localSha}`;
  const gitleaksResult = Bun.spawnSync(
    [
      gitleaks,
      "detect",
      "--redact",
      "--no-banner",
      "--source=.",
      `--log-opts=--no-merges --first-parent ${logRange}`,
    ],
    { stderr: "inherit", stdout: "inherit" }
  );
  if (gitleaksResult.exitCode !== 0) process.exit(gitleaksResult.exitCode);

  const repositoryUrl = `file://${text(["git", "rev-parse", "--show-toplevel"])}`;
  const trufflehogResult = Bun.spawnSync(
    [
      trufflehog,
      "git",
      repositoryUrl,
      `--since-commit=${baseSha}`,
      `--branch=${localSha}`,
      "--only-verified",
      "--exclude-paths=.trufflehog-exclude-paths.txt",
    ],
    { stderr: "inherit", stdout: "inherit" }
  );
  if (trufflehogResult.exitCode !== 0) process.exit(trufflehogResult.exitCode);
}
