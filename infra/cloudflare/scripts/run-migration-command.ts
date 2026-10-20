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

/** Fixed categories only: command bodies and provider messages never enter diagnostics. */
const providerFailureCategory = (output: string): string => {
  const categories: ReadonlyArray<readonly [RegExp, string]> = [
    [/not authorized|unauthorized|permission|authentication|forbidden/iu, "authorization"],
    [/read.?only|SQLITE_READONLY/iu, "read_only"],
    [/no such column|unknown column/iu, "missing_column"],
    [/no such table/iu, "missing_table"],
    [/constraint|not null/iu, "constraint"],
    [/syntax|parse error|unterminated|unrecognized token/iu, "sql_syntax"],
    [/bind|parameter/iu, "binding"],
    [/too many|too long|limit exceeded|SQLITE_TOOBIG/iu, "query_limit"],
    [/network|fetch failed|connection|temporar|internal error/iu, "provider_unavailable"],
    [/not supported|unsupported/iu, "unsupported_operation"],
    [/database is locked|SQLITE_BUSY|SQLITE_LOCKED/iu, "database_busy"],
    [/invalid/iu, "invalid_request"],
  ];
  return categories.find(([pattern]) => pattern.test(output))?.[1] ?? "unclassified";
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
    const output = result.stderr + result.stdout;
    const providerCode = /(?:\[code:|"code"\s*:)\s*(\d+)/u.exec(output)?.[1] ?? "none";
    const category = providerFailureCategory(output);
    const sqliteCode =
      /\b(SQLITE_(?:AUTH|ERROR|CONSTRAINT|READONLY|BUSY|LOCKED|FULL|TOOBIG|IOERR|CORRUPT|NOTADB))\b/u.exec(
        output
      )?.[1] ?? "none";
    throw new MigrationCommandError(
      `External migration command failed (status ${result.status ?? "none"}, reason ${reason}, provider code ${providerCode}, category ${category}, SQLite code ${sqliteCode})`
    );
  }
  return result.stdout;
};
