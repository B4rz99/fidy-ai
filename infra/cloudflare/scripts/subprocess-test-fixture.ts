import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ScriptEnvironment = Readonly<Record<string, string>>;

type ScriptResult = Readonly<{
  readonly exitCode: number;
  readonly output: string;
}>;

type ScriptInvocation = Readonly<{
  readonly scriptPath: string;
  readonly workingDirectory: string;
  readonly environment: ScriptEnvironment;
}>;

type SubprocessTestFixture = Readonly<{
  readonly temporaryDirectory: string;
  readonly fakeBin: string;
  readonly runScript: (invocation: ScriptInvocation) => ScriptResult;
}>;

/**
 * Runs a script with a temporary fake-command directory prepended to PATH.
 * Fixture files must be consumed inside the callback; its temporary directory is removed when the
 * callback settles, including when it fails.
 */
export const withSubprocessTestFixture = async <A>(
  prefix: string,
  run: (fixture: SubprocessTestFixture) => Promise<A>
): Promise<A> => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), prefix));
  const fakeBin = join(temporaryDirectory, "bin");

  try {
    await mkdir(fakeBin);
    return await run({
      temporaryDirectory,
      fakeBin,
      runScript: ({ scriptPath, workingDirectory, environment }) => {
        const result = spawnSync(process.execPath, [scriptPath], {
          cwd: workingDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            ...environment,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        });

        return {
          exitCode: result.status ?? 1,
          output: `${result.stdout}${result.stderr}`,
        };
      },
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};
