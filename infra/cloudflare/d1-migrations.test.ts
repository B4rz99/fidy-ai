import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { expect } from "vitest";

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

const migrationPrefix = (name: string): number => Number.parseInt(name.split("_")[0] ?? "", 10);
const compareMigrations = (left: string, right: string): number =>
  migrationPrefix(left) - migrationPrefix(right) || left.localeCompare(right);

const migrationNames = (): Effect.Effect<
  ReadonlyArray<string>,
  PlatformError.PlatformError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(migrationsPath);
    return entries.filter((entry) => entry.endsWith(".sql")).sort(compareMigrations);
  });

const createMigrationDirectory = (
  names: ReadonlyArray<string>
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: "fidy-d1-migrations-" });
    const copyMigrations = Effect.forEach(
      names,
      (name) => fs.copyFile(path.join(migrationsPath, name), path.join(directory, name)),
      { discard: true }
    );
    yield* copyMigrations.pipe(
      Effect.onError(() =>
        fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore)
      )
    );
    return directory;
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
  "applies the complete Production D1 migration history to a clean local database",
  Effect.gen(function* () {
    const names = yield* migrationNames();
    const migrationStack = createMigrationStack("D1MigrationCleanInstall", migrationsPath);

    const migrationCheck = Effect.gen(function* () {
      const deployed = yield* resetAndDeployLocalMigrationStack(migrationStack);

      const state = yield* readState(yield* workerUrl(Option.fromUndefinedOr(deployed.worker.url)));
      expect(state).toMatchObject({
        appliedMigrationNames: [...names].sort(),
        transcriptHasIteration: true,
        hostedWhatsAppInboundExists: true,
        hostedVoiceRefusalsExists: true,
        hostedWhatsAppWindowsExists: true,
        foreignKeyViolationCount: 0,
        transcriptEvidence: { _tag: "Empty" },
      });
    });
    yield* Effect.ensuring(migrationCheck, destroy(migrationStack).pipe(Effect.ignore));
  }).pipe(Effect.orDie),
  { timeout: 120_000 }
);

test(
  "preserves populated Transcript evidence while applying the newest migration",
  Effect.gen(function* () {
    const names = yield* migrationNames();
    const candidate = names.at(-1);
    if (candidate === undefined) return yield* Effect.die(new Error("No D1 migrations found"));
    const predecessorNames = names.slice(0, -1);
    const dir = yield* createMigrationDirectory(predecessorNames);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const migrationStack = createMigrationStack("D1MigrationPopulatedUpgrade", dir);

    const migrationCheck = Effect.gen(function* () {
      const before = yield* resetAndDeployLocalMigrationStack(migrationStack);
      expect(Object.keys(before.database.migrationsHashes).sort()).toEqual(
        [...predecessorNames].sort()
      );

      const beforeUrl = yield* workerUrl(Option.fromUndefinedOr(before.worker.url));
      expect(yield* readState(beforeUrl)).toMatchObject({
        appliedMigrationNames: [...predecessorNames].sort(),
        hostedVoiceRefusalsExists: true,
        hostedWhatsAppWindowsExists: true,
        transcriptEvidence: { _tag: "Empty" },
      });

      const seedResponse = yield* seedExistingTranscript(beforeUrl);
      expect(seedResponse.status).toBe(200);
      expect(yield* seedResponse.json).toEqual({ seeded: true });

      yield* fs.copyFile(path.join(migrationsPath, candidate), path.join(dir, candidate));
      const after = yield* deployLocalMigrationStack(migrationStack);
      expect(after.database.databaseId).toBe(before.database.databaseId);

      const state = yield* readState(yield* workerUrl(Option.fromUndefinedOr(after.worker.url)));
      expect(state).toMatchObject({
        appliedMigrationNames: [...names].sort(),
        transcriptHasIteration: true,
        hostedWhatsAppInboundExists: true,
        hostedVoiceRefusalsExists: true,
        hostedWhatsAppWindowsExists: true,
        foreignKeyViolationCount: 0,
        pendingTurnUniquenessEnforced: true,
        transcriptAppendOnlyEnforced: true,
        hostedVoiceRefusalPrimaryKeyEnforced: true,
        hostedVoiceRefusalOutcomeCheckEnforced: true,
        hostedWhatsAppWindowPrimaryKeyEnforced: true,
        hostedWhatsAppWindowBoundsCheckEnforced: true,
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
    const cleanup = Effect.ensuring(
      destroy(migrationStack).pipe(Effect.ignore),
      fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)
    );
    yield* Effect.ensuring(migrationCheck, cleanup);
  }).pipe(Effect.orDie),
  { timeout: 120_000 }
);
