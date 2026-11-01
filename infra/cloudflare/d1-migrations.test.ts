import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { makeD1MigrationExecutor } from "alchemy/Cloudflare/D1";
import * as CloudflareCredentials from "@distilled.cloud/cloudflare/Credentials";
import * as CloudflareRetry from "@distilled.cloud/cloudflare/Retry";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Test from "alchemy/Test/Vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { it } from "@effect/vitest";
import { expect } from "vitest";

for (const operation of ["query", "batch", "metadata"] as const) {
  it.effect(
    `does not replay ambiguous migration SQL while retaining metadata retries: ${operation}`,
    Effect.fn(function* () {
      let attempts = 0;
      const client = HttpClient.make((request) => {
        attempts += 1;
        const successfulResults = operation === "metadata" ? [] : [{ success: true, results: [] }];
        const response =
          attempts === 1
            ? Response.json(
                { success: false, errors: [{ code: 1000, message: "Ambiguous server failure" }] },
                { status: 503 }
              )
            : Response.json({
                success: true,
                errors: [],
                messages: [],
                result: successfulResults,
              });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const outcome = yield* Effect.gen(function* () {
        if (operation === "metadata") {
          return yield* d1.listDatabases({ accountId: "0".repeat(32) });
        }
        // Capture the outer retry policy as the real provider does. The executor must
        // override it at invocation, without changing unrelated metadata calls.
        const query = yield* d1.queryDatabase;
        const executor = makeD1MigrationExecutor((sql) =>
          query({
            accountId: "0".repeat(32),
            databaseId: "11111111-1111-4111-8111-111111111111",
            ...(typeof sql === "string"
              ? { sql }
              : { batch: sql.map((statement) => ({ sql: statement })) }),
          })
        );
        return yield* operation === "batch"
          ? executor.batch(["CREATE TABLE migration_probe (value INTEGER)"])
          : executor.query("INSERT INTO migration_probe VALUES (1)");
      }).pipe(
        CloudflareRetry.policy({ while: () => true, schedule: Schedule.recurs(1) }),
        Effect.exit,
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(
          CloudflareCredentials.Credentials,
          Effect.succeed(CloudflareCredentials.apiTokenCredentials({ apiToken: "local-only" }))
        )
      );
      expect(Exit.isFailure(outcome)).toBe(operation !== "metadata");
      expect(attempts).toBe(operation === "metadata" ? 2 : 1);
    })
  );
}

const migrationsPath = new URL("../../apps/server/cloudflare/migrations/", import.meta.url)
  .pathname;
const workerPath = new URL(
  "../../apps/server/cloudflare/d1-migration-test-worker.fixture.ts",
  import.meta.url
).pathname;
const declareMigrationResources = Effect.fn(function* (migrations: string) {
  const database = yield* Cloudflare.D1.Database("MigrationValidationDatabase", { migrations });
  const worker = yield* Cloudflare.Worker("d1-migration-validation-worker", {
    main: workerPath,
    compatibility: { date: "2026-09-08" },
    env: { DB: database },
  });
  return { database, worker };
});
const { test, deploy, destroy } = Test.make({ providers: Cloudflare.providers(), dev: true });
const createMigrationStack = Effect.fn(function* (name: string, migrations: string) {
  return yield* Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    declareMigrationResources(migrations)
  );
});
const deployLocalMigrationStack = Effect.fn(function* (
  stack: ReturnType<typeof createMigrationStack>
) {
  const deployed = yield* deploy(stack);
  expect(deployed.database.databaseId).toMatch(/^dev:/u);
  return deployed;
});
const resetAndDeployLocalMigrationStack = Effect.fn(function* (
  stack: ReturnType<typeof createMigrationStack>
) {
  yield* destroy(stack);
  return yield* deployLocalMigrationStack(stack);
});

const migrationNames = (): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(migrationsPath);
    return entries.filter((entry) => entry.endsWith(".sql")).sort();
  });

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{ readonly status: number }> {}

const workerUrl = (url: Option.Option<string>): Effect.Effect<string> =>
  Option.match(url, {
    onNone: () => Effect.die(new Error("Expected a local migration-test Worker URL")),
    onSome: Effect.succeed,
  });

const getWorkerWhenReady = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(request).pipe(
    Effect.filterOrFail(
      (response) => response.status !== 404 && response.status < 500,
      (response) => new WorkerNotReady({ status: response.status })
    ),
    Effect.retry({
      while: (error) => error instanceof WorkerNotReady,
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(20)]),
    })
  );
});

const readState = Effect.fn(function* (url: string) {
  const response = yield* getWorkerWhenReady(
    HttpClientRequest.get(new URL("/state", url).toString())
  );
  expect(response.status).toBe(200);
  return yield* response.json;
});

const seedExistingTranscript = Effect.fn(function* (url: string) {
  return yield* getWorkerWhenReady(
    HttpClientRequest.post(new URL("/seed-existing-transcript", url).toString())
  );
});

test(
  "installs the schema baseline and preserves populated Transcript evidence on redeployment",
  Effect.gen(function* () {
    const names = yield* migrationNames();
    const migrationStack = createMigrationStack("D1BaselinePopulatedRedeploy", migrationsPath);

    const migrationCheck = Effect.gen(function* () {
      const before = yield* resetAndDeployLocalMigrationStack(migrationStack);
      expect(Object.keys(before.database.migrationsHashes).sort()).toEqual([...names].sort());

      const beforeUrl = yield* workerUrl(Option.fromUndefinedOr(before.worker.url));
      expect(yield* readState(beforeUrl)).toMatchObject({
        appliedMigrationNames: [...names].sort(),
        transcriptHasIteration: true,
        foreignKeyViolationCount: 0,
        whatsAppEventRecordsExists: true,
        whatsAppServiceWindowsExists: true,
        transcriptEvidence: { _tag: "Empty" },
      });

      const seedResponse = yield* seedExistingTranscript(beforeUrl);
      expect(seedResponse.status).toBe(200);
      expect(yield* seedResponse.json).toEqual({ seeded: true });

      const after = yield* deployLocalMigrationStack(migrationStack);
      expect(after.database.databaseId).toBe(before.database.databaseId);

      const state = yield* readState(yield* workerUrl(Option.fromUndefinedOr(after.worker.url)));
      expect(state).toMatchObject({
        appliedMigrationNames: [...names].sort(),
        transcriptHasIteration: true,
        whatsAppEventRecordsExists: true,
        whatsAppServiceWindowsExists: true,
        foreignKeyViolationCount: 0,
        pendingTurnUniquenessEnforced: true,
        transcriptAppendOnlyEnforced: true,
        hostedVoiceRefusalIdentityEnforced: true,
        hostedVoiceRefusalOutcomeCheckEnforced: true,
        whatsAppServiceWindowPrimaryKeyEnforced: true,
        transcriptEvidence: {
          _tag: "Preserved",
          value: {
            sequence: 1,
            entryId: "10000000-0000-4000-8000-000000000735",
            userId: "10000000-0000-4000-8000-000000000732",
            hostedSessionId: "10000000-0000-4000-8000-000000000733",
            turnId: "10000000-0000-4000-8000-000000000731",
            text: "Antes",
            toolCallId: "legacy-call",
            mutationUserId: "10000000-0000-4000-8000-000000000732",
            turnStatus: "pending",
            turnSessionId: "10000000-0000-4000-8000-000000000733",
          },
        },
      });
    });
    yield* Effect.ensuring(migrationCheck, destroy(migrationStack).pipe(Effect.ignore));
  }).pipe(Effect.orDie),
  { timeout: 120_000 }
);
