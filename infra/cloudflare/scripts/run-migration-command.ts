import { spawnSync } from "node:child_process";

export class MigrationCommandError extends Error {}

type MigrationCommand = readonly [string, ...Array<string>];
type MigrationCommandOptions = Readonly<{ readonly cwd: string }>;

const failureReason = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "command_exit";
  return ["ENOBUFS", "ETIMEDOUT", "ENOENT"].includes(code) ? code : "command_exit";
};

/**
 * Runs a migration-management command in the inherited process environment and supplied working
 * directory. The command must name an executable. Returns stdout and throws when the command
 * exits unsuccessfully.
 */
export const runMigrationCommand = (
  command: MigrationCommand,
  options: MigrationCommandOptions
): string => {
  const [executable, ...arguments_] = command;
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const reason = failureReason(result.error);
    const providerCode = /\[code:\s*(\d+)\]/u.exec(result.stderr)?.[1] ?? "none";
    throw new MigrationCommandError(
      `External migration command failed (status ${result.status ?? "none"}, reason ${reason}, provider code ${providerCode})`
    );
  }
  return result.stdout;
};
