import { spawnSync } from "node:child_process";

type MigrationCommand = readonly [string, ...Array<string>];
type MigrationCommandOptions = Readonly<{ readonly cwd: string }>;

/**
 * Runs a migration-management command in the inherited process environment and supplied working
 * directory. The command must name an executable. Returns stdout and throws when the command
 * exits unsuccessfully.
 */
export const runMigrationCommand = (
  command: MigrationCommand,
  options: MigrationCommandOptions = {}
): string => {
  const [executable, ...arguments_] = command;
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("External migration command failed");
  return result.stdout;
};
