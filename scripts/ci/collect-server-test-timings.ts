#!/usr/bin/env bun

// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, readFile, writeFile } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname } from "node:path";
import { Effect, Option, Schema } from "effect";

const serverTestFile = /^src\/shell\/.*\.test\.ts$/u;
const testSuiteTag = /<testsuite\b[^>]*>/gu;
const attribute = (name: string): RegExp => new RegExp(`\\b${name}="([^"]*)"`, "u");
const Timings = Schema.Record(Schema.String, Schema.Finite);
const encodeTimings = Schema.encodeSync(Schema.fromJsonString(Timings));

type Timing = readonly [path: string, seconds: number];

const timingFromTag = (tag: string): Option.Option<Timing> => {
  const name = attribute("name").exec(tag)?.[1];
  const secondsText = attribute("time").exec(tag)?.[1];
  if (name === undefined || secondsText === undefined || !serverTestFile.test(name)) {
    return Option.none();
  }
  const seconds = Number(secondsText);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid JUnit duration for ${name}: ${secondsText}`);
  }
  return Option.some([name, seconds]);
};

/** Extracts one duration per server test file from Vitest JUnit reports. */
export const collectServerTestTimings = (
  reports: ReadonlyArray<string>
): Readonly<Record<string, number>> => {
  const timings = new Map<string, number>();
  for (const report of reports) {
    for (const match of report.matchAll(testSuiteTag)) {
      const timing = timingFromTag(match[0]);
      if (Option.isNone(timing)) continue;
      const [name, seconds] = timing.value;
      timings.set(name, Math.max(timings.get(name) ?? 0, seconds));
    }
  }
  return Object.fromEntries([...timings].sort(([left], [right]) => left.localeCompare(right)));
};

const parseArguments = (): { readonly input: string; readonly output: string } => {
  const args = Bun.argv.slice(2);
  const valueAfter = (flag: string): string => {
    const index = args.indexOf(flag);
    const value = index < 0 ? undefined : args[index + 1];
    if (value === undefined) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };
  return { input: valueAfter("--input"), output: valueAfter("--output") };
};

const main = Effect.gen(function* () {
  const { input, output } = parseArguments();
  const glob = new Bun.Glob("**/server-tests.xml");
  const files = [...glob.scanSync({ cwd: input, absolute: true })].sort();
  if (files.length === 0) {
    throw new Error(`No server JUnit reports found under ${input}`);
  }
  const reports = yield* Effect.tryPromise(() =>
    Promise.all(files.map((file) => readFile(file, "utf8")))
  );
  const timings = collectServerTestTimings(reports);
  if (Object.keys(timings).length === 0) {
    throw new Error("Server JUnit reports contained no test files");
  }
  yield* Effect.tryPromise(() => mkdir(dirname(output), { recursive: true }));
  const source = `/** Generated from successful CI JUnit reports. */\nexport const cachedServerTestTimings: Readonly<Record<string, number>> = ${encodeTimings(timings)};\n`;
  yield* Effect.tryPromise(() => writeFile(output, source));
  yield* Effect.sync(() =>
    process.stdout.write(
      `Collected timings for ${Object.keys(timings).length} server test files.\n`
    )
  );
});

if (import.meta.main) {
  Effect.runPromise(main).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
