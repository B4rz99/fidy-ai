#!/usr/bin/env bun

import { loadCommitConvention } from "./check-commit-message";

const ZERO_SHA = "0".repeat(40);

const text = (command: string[]): string => {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} failed${stderr.length > 0 ? `: ${stderr}` : ""}`);
  }

  return new TextDecoder().decode(result.stdout).trim();
};

const pushLines = (await Bun.stdin.text())
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const pushedCommits = pushLines.flatMap((line) => {
  const [, localSha, , remoteSha] = line.split(/\s+/);

  if (localSha === undefined || localSha === ZERO_SHA) return [];

  const args =
    remoteSha !== undefined && remoteSha !== ZERO_SHA
      ? ["rev-list", `${remoteSha}..${localSha}`]
      : ["rev-list", localSha, "--not", "--remotes"];

  return text(["git", ...args])
    .split("\n")
    .filter(Boolean);
});

const commits = [
  ...new Set(pushLines.length > 0 ? pushedCommits : [text(["git", "rev-parse", "HEAD"])]),
];

// The same allowlist the commit-msg hook enforces: README.md's commit
// convention section.
const convention = await loadCommitConvention();

const failures = commits.flatMap((commit) => {
  const message = text(["git", "show", "-s", "--format=%B", commit]);
  const errors = convention.validateMessage(message);
  const subject = text(["git", "show", "-s", "--format=%s", commit]);

  return errors.map(
    (error) => `${commit.slice(0, 12)} ${subject}\n${convention.formatErrors([error])}`
  );
});

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n\n")}\n`);
  process.exit(1);
}
