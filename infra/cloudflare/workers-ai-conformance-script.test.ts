import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Config, Data, Effect, FileSystem, Schema, Stream } from "effect";

import { ChildProcess } from "effect/process";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const wait = <A>(run: () => Promise<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new FixtureFailure({ cause }) });
const conforming = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  modelApprovalRevision: "workers-ai-gemma-4-2026-09-22",
  outcome: "conforming",
});

const workerReady = (path: string): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      while (!(yield* wait(() => Bun.file(path).exists()))) yield* Effect.sleep("10 millis");
    }).pipe(Effect.timeout("5 seconds"))
  );

type Scenario = "readiness-headers" | "post-headers" | "post-body" | "healthy" | "refused";
const strictReport = {
  category: "InvalidOutput",
  allowQuotaDeferral: false,
  deferred: false,
  revision: "workers-ai-gemma-4-2026-09-22",
  prerequisiteFailure: false,
  trailingJson: "",
};
type Report = typeof strictReport;
type ScriptResult = {
  report: Report;
  result: number;
  output: string;
  diagnostic: string;
  gets: number;
  posts: number;
  directory: string;
};
const failureDiagnostic = (check: string, report: Report): string => {
  if (report.revision !== strictReport.revision || report.trailingJson !== "") {
    return "Workers AI conformance failed: check=internal category=UnexpectedFailure\n";
  }
  return `Workers AI conformance failed: check=${check} category=${report.category}\n`;
};
const assertDiagnostic = (scenario: Scenario, result: ScriptResult, check?: string): void => {
  const { report, diagnostic, output } = result;
  if (scenario === "readiness-headers") expect(diagnostic).toContain("readiness request timed out");
  if (scenario === "post-headers" || scenario === "post-body") {
    expect(diagnostic).toBe("Workers AI conformance request failed.\n");
  }
  if (check !== undefined) {
    expect(diagnostic).toBe(
      report.deferred
        ? `::warning::Workers AI live conformance deferred: check=${check} category=ProviderQuotaExceeded. Model behavior remains unverified; deterministic checks passed.\n`
        : failureDiagnostic(check, report)
    );
    expect(output + diagnostic).not.toContain("fixture-private-content");
  }
};
const assertOutcome = Effect.fn(function* (
  scenario: Scenario,
  result: ScriptResult,
  check?: string
) {
  const fs = yield* FileSystem.FileSystem;
  const { report, directory } = result;
  expect(yield* fs.readDirectory(`${directory}/tmp`)).toEqual([]);
  if (report.prerequisiteFailure) {
    expect(result.result).toBe(23);
    expect(result.gets).toBe(0);
    expect(result.posts).toBe(0);
    expect(result.output + result.diagnostic).toBe("");
    expect(yield* fs.exists(`${directory}/worker.settled.ready`)).toBe(false);
    return;
  }
  const passed = scenario === "healthy" && check === undefined;
  expect(result.result).toBe(passed || report.deferred ? 0 : 1);
  expect(result.gets).toBe(1);
  expect(result.posts).toBe(scenario === "readiness-headers" ? 0 : 1);
  expect(result.output.includes("Workers AI model conformance passed.")).toBe(passed);
  assertDiagnostic(scenario, result, check);
  expect(yield* fs.exists(`${directory}/worker.settled`)).toBe(true);
});
const exercise = Effect.fn(function* (
  scenario: Scenario,
  check?: string,
  report: Report = strictReport
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Config.String("PATH");
  const directory = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "fidy-curl-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)
  );
  yield* fs.makeDirectory(`${directory}/bin`);
  yield* fs.makeDirectory(`${directory}/tmp`);
  const source = yield* fs.readFileString(
    new URL("./scripts/check-workers-ai-conformance.sh", import.meta.url).pathname
  );
  yield* fs.writeFileString(`${directory}/check.sh`, source);
  // Only the prerequisite and launcher are fixtures. curl, jq and deadline enforcement stay real.
  yield* fs.writeFileString(
    `${directory}/bin/bun`,
    `#!/bin/sh\nexit ${report.prerequisiteFailure ? 23 : 0}\n`
  );
  yield* fs.writeFileString(
    `${directory}/bin/wrangler`,
    `#!/bin/sh\nexec '${process.execPath}' '${directory}/worker.js'\n`
  );
  const marker = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(
    `${directory}/worker.settled`
  );
  yield* fs.writeFileString(
    `${directory}/worker.js`,
    `
      process.on("SIGTERM", async () => {
        await Bun.write(${marker}, "settled");
        process.exit(0);
      });
      await Bun.write(${marker} + ".ready", "ready");
      setInterval(() => {}, 1000);
    `
  );
  yield* fs.chmod(`${directory}/bin/bun`, 0o700);
  yield* fs.chmod(`${directory}/bin/wrangler`, 0o700);
  let gets = 0;
  let posts = 0;
  const held = Promise.withResolvers<Response>();
  const body = new ReadableStream<Uint8Array>({
    start: (controller): void => controller.enqueue(new TextEncoder().encode(conforming)),
  });
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 0,
        fetch: (request): Response | Promise<Response> => {
          if (request.method === "GET") {
            gets += 1;
            return workerReady(`${directory}/worker.settled.ready`).then(() =>
              scenario === "readiness-headers" ? held.promise : new Response(null, { status: 404 })
            );
          }
          posts += 1;
          if (scenario === "post-headers") {
            return held.promise;
          }
          if (scenario === "post-body") {
            return new Response(body, {
              headers: {
                "content-length": String(new TextEncoder().encode(conforming).byteLength + 1),
              },
            });
          }
          return new Response(
            check === undefined
              ? conforming
              : JSON.stringify({
                  modelApprovalRevision: report.revision,
                  outcome: "non_conforming",
                  check,
                  category: report.category,
                  privateContent: "fixture-private-content",
                }) + report.trailingJson,
            { status: scenario === "refused" ? 503 : 200 }
          );
        },
      })
    ),
    (server) =>
      Effect.gen(function* () {
        held.resolve(new Response(null, { status: 503 }));
        yield* wait(() => server.stop(true));
      }).pipe(Effect.orDie)
  );
  const owned = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = Bun.spawn(
        [
          "bash",
          `${directory}/check.sh`,
          ...(report.allowQuotaDeferral ? ["--allow-quota-deferral"] : []),
        ],
        {
          cwd: directory,
          env: {
            PATH: `${directory}/bin:${path}`,
            TMPDIR: `${directory}/tmp`,
            HOSTED_AI_MODEL: "fixture-model",
            WORKERS_AI_CONFORMANCE_TIMEOUT_SECONDS: "1",
            WORKERS_AI_CONFORMANCE_PORT: String(server.port),
          },
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      return {
        child,
        stdout: new Response(child.stdout).text(),
        stderr: new Response(child.stderr).text(),
      };
    }),
    ({ child, stdout, stderr }) =>
      Effect.gen(function* () {
        child.kill();
        held.resolve(new Response(null, { status: 503 }));
        yield* wait(() => server.stop(true));
        yield* wait(() => child.exited);
        yield* wait(() => Promise.all([stdout, stderr]));
      }).pipe(Effect.orDie)
  );
  const { child, stdout, stderr } = owned;

  const result = yield* wait(() => child.exited).pipe(Effect.timeout("20 seconds"));
  const output = yield* wait(() => stdout);
  const diagnostic = yield* wait(() => stderr);
  yield* assertOutcome(
    scenario,
    {
      report,
      result,
      output,
      diagnostic,
      gets,
      posts,
      directory,
    },
    check
  );
}, Effect.scoped);

layer(BunServices.layer, { excludeTestServices: true })((it) => {
  for (const scenario of [
    "readiness-headers",
    "post-headers",
    "post-body",
    "healthy",
    "refused",
  ] as const) {
    it.effect(
      `settles the native conformance script and owned resources for ${scenario}`,
      () => exercise(scenario),
      25_000
    );
  }
  for (const check of ["canonical_correction", "canonical_deletion", "canonical_date_only"]) {
    it.effect(`reports the closed ${check} failure without private content`, () =>
      exercise("refused", check)
    );
  }
  it.effect("keeps standalone live verification strict when provider quota is exhausted", () =>
    exercise("refused", "canonical_query", { ...strictReport, category: "ProviderQuotaExceeded" })
  );
  for (const check of ["canonical_query", "structured_es_co"]) {
    it.effect(`allows a release to defer quota-exhausted ${check} verification explicitly`, () =>
      exercise("refused", check, {
        ...strictReport,
        category: "ProviderQuotaExceeded",
        allowQuotaDeferral: true,
        deferred: true,
      })
    );
  }
  for (const check of ["configuration", "internal"]) {
    it.effect(`refuses a quota report from ${check}`, () =>
      exercise("refused", check, {
        ...strictReport,
        category: "ProviderQuotaExceeded",
        allowQuotaDeferral: true,
      })
    );
  }
  it.effect("refuses quota reports with an unexpected approval revision", () =>
    exercise("refused", "canonical_query", {
      ...strictReport,
      category: "ProviderQuotaExceeded",
      allowQuotaDeferral: true,
      revision: "unapproved",
    })
  );
  it.effect("refuses quota reports with an inconsistent HTTP status", () =>
    exercise("healthy", "canonical_query", {
      ...strictReport,
      category: "ProviderQuotaExceeded",
      allowQuotaDeferral: true,
    })
  );
  for (const trailingJson of ["{}", "not-json"]) {
    it.effect(`refuses a quota report followed by ${trailingJson}`, () =>
      exercise("refused", "canonical_query", {
        ...strictReport,
        category: "ProviderQuotaExceeded",
        allowQuotaDeferral: true,
        trailingJson,
      })
    );
  }
  it.effect("does not defer a failed deterministic prerequisite or start live inference", () =>
    exercise("refused", "canonical_query", {
      ...strictReport,
      category: "ProviderQuotaExceeded",
      allowQuotaDeferral: true,
      prerequisiteFailure: true,
    })
  );
  it.effect("keeps non-quota provider failures blocking releases", () =>
    exercise("refused", "canonical_query", {
      ...strictReport,
      category: "ProviderUnavailable",
      allowQuotaDeferral: true,
    })
  );
  it.effect("refuses invalid or raised client deadlines before starting conformance work", () =>
    Effect.gen(function* () {
      for (const timeout of ["0", "181", "9999", "1.5", "-1", "invalid"]) {
        const child = yield* ChildProcess.make(
          "bash",
          [new URL("./scripts/check-workers-ai-conformance.sh", import.meta.url).pathname],
          {
            env: {
              ...Bun.env,
              HOSTED_AI_MODEL: "fixture-model",
              WORKERS_AI_CONFORMANCE_TIMEOUT_SECONDS: timeout,
            },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }
        );
        const result = yield* Effect.all(
          {
            status: child.exitCode,
            stdout: Stream.mkString(Stream.decodeText(child.stdout)),
            stderr: Stream.mkString(Stream.decodeText(child.stderr)),
          },
          { concurrency: "unbounded" }
        );
        expect(result.status, timeout).toBe(1);
        expect(result.stderr).toBe(
          "Workers AI conformance timeout must be an integer from 1 to 180 seconds.\n"
        );
        expect(result.stdout).toBe("");
      }
    }).pipe(Effect.scoped, Effect.timeout("5 seconds"))
  );
});
