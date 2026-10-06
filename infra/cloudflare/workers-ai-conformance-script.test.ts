import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Config, Data, Effect, FileSystem, Schema } from "effect";

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
const exercise = Effect.fn(function* (scenario: Scenario) {
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
  // Only the prerequisite and launcher are fixtures. curl, jq and all production budgets stay real.
  yield* fs.writeFileString(`${directory}/bin/bun`, "#!/bin/sh\nexit 0\n");
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
          return new Response(conforming, { status: scenario === "refused" ? 503 : 200 });
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
      const child = Bun.spawn(["bash", `${directory}/check.sh`], {
        cwd: directory,
        env: {
          PATH: `${directory}/bin:${path}`,
          TMPDIR: `${directory}/tmp`,
          HOSTED_AI_MODEL: "fixture-model",
          WORKERS_AI_CONFORMANCE_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
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

  const result = yield* wait(() => child.exited).pipe(Effect.timeout("195 seconds"));
  const output = yield* wait(() => stdout);
  const diagnostic = yield* wait(() => stderr);
  expect(result).toBe(scenario === "healthy" ? 0 : 1);
  expect(gets).toBe(1);
  expect(posts).toBe(scenario === "readiness-headers" ? 0 : 1);
  expect(output.includes("Workers AI model conformance passed.")).toBe(scenario === "healthy");
  if (scenario === "readiness-headers") expect(diagnostic).toContain("readiness request timed out");
  if (scenario === "post-headers" || scenario === "post-body") {
    expect(diagnostic).toBe("Workers AI conformance request failed.\n");
  }
  expect(yield* fs.readDirectory(`${directory}/tmp`)).toEqual([]);
  expect(yield* fs.exists(`${directory}/worker.settled`)).toBe(true);
}, Effect.scoped);

layer(BunFileSystem.layer, { excludeTestServices: true })((it) => {
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
      210_000
    );
  }
});
