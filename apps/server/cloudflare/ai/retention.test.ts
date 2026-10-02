import { deepStrictEqual } from "node:assert";
import { it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";
import { afterAll } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { WorkersAiAdmissionUnavailable } from "./contract";
import { sweepExpiredWorkersAiAdmission } from "./runtime";

class TestDatabaseUnavailable extends Data.TaggedError("TestDatabaseUnavailable") {}
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it.effect("closes unavailable retention storage without exposing database failures", () =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise({
      try: () => databases.acquire(),
      catch: () => new TestDatabaseUnavailable(),
    });
    const result = yield* Effect.exit(
      sweepExpiredWorkersAiAdmission({ db, now: 1_800_000_000_000 })
    );
    deepStrictEqual(result, Exit.fail(new WorkersAiAdmissionUnavailable()));
  })
);
