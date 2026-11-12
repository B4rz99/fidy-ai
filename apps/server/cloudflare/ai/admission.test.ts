import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { approvedOpenAiModel } from "../../src/shell/hosted-inference/contract";
import { Data, Effect, Exit, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeAdmittedOpenAiRun } from "./admitted-run.test-fixture";
import { sweepExpiredOpenAiAdmission } from "./runtime";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const prepareDatabase = (): Promise<D1Database> =>
  databases.acquire().then((db) => installTestSchema({ db }).then(() => db));

const modelUserId = "10000000-0000-4000-8000-000000000001";
const seedModelConsent = (database: D1Database): Promise<unknown> =>
  Promise.resolve().then(() =>
    database.batch([
      database
        .prepare(
          "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1000)"
        )
        .bind(modelUserId),
      database
        .prepare(
          "INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant','30000000-0000-4000-8000-000000000001', ?, ?, 'disclosed', 'accepted', 1000, 1000)"
        )
        .bind(modelUserId, JSON.stringify(currentDisclosureFor())),
    ])
  );

it("reserves a conservative cross-Turn AI cost before provider work and never refunds failures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* fromTestPromise(prepareDatabase);
      let calls = 0;
      yield* fromTestPromise(() => seedModelConsent(database));
      const run = makeAdmittedOpenAiRun({
        db: database,
        userId: modelUserId,
        admittedTurnId: Option.none,
        nowEpochMs: () => 10_000,
        run: () => {
          calls += 1;
          return Promise.reject(new Error("provider failed after accepting request"));
        },
      });
      const request = {
        messages: [{ role: "user" as const, content: "Hola" }],
        max_completion_tokens: 16_000,
        temperature: 0 as const,
        stream: false as const,
        reasoning_effort: "none" as const,
        store: false as const,
      };
      const result = yield* Effect.exit(
        Effect.tryPromise(() =>
          run(approvedOpenAiModel, request, {
            signal: new AbortController().signal,
          })
        )
      );
      expect(Exit.isFailure(result)).toBe(true);
      const charges = yield* fromTestPromise(() =>
        database
          .prepare(
            "SELECT units FROM resource_admission_events WHERE policy_key = 'openai.spend.user.v1'"
          )
          .all<{ readonly units: number }>()
      );
      expect(charges.results).toHaveLength(1);
      expect(charges.results[0]?.units).toBeGreaterThan(16_000);
      expect(charges.results[0]?.units).toBeLessThan(17_000);
      expect(calls).toBe(1);
    })
  ));

it("fails closed when AI spend authority cannot commit, without invoking the provider", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* fromTestPromise(prepareDatabase);
      let providerCalls = 0;
      const unavailableDb = new Proxy(database, {
        get: (target, key): unknown =>
          key === "batch"
            ? (): Promise<never> => Promise.reject(new Error("D1 unavailable"))
            : Reflect.get(target, key, target),
      });
      yield* fromTestPromise(() => seedModelConsent(database));
      const run = makeAdmittedOpenAiRun({
        db: unavailableDb,
        userId: modelUserId,
        admittedTurnId: Option.none,
        nowEpochMs: () => 10_000,
        run: () => {
          providerCalls++;
          return Promise.resolve(Response.json({}));
        },
      });
      const failure = yield* Effect.exit(
        Effect.tryPromise(() =>
          run(
            approvedOpenAiModel,
            {
              messages: [{ role: "user", content: "Hola" }],
              max_completion_tokens: 16_000,
              temperature: 0,
              stream: false,
              reasoning_effort: "none",
              store: false,
            },
            { signal: new AbortController().signal }
          )
        )
      );
      expect(Exit.isFailure(failure)).toBe(true);
      expect(providerCalls).toBe(0);
      const rows = yield* fromTestPromise(() =>
        database
          .prepare("SELECT count(*) AS total FROM resource_admission_events")
          .first<{ readonly total: number }>()
      );
      expect(rows?.total).toBe(0);
    })
  ));

it("retains spend until its window expires and sweeps only expired grants", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* fromTestPromise(prepareDatabase);
      yield* fromTestPromise(() => seedModelConsent(database));
      const run = makeAdmittedOpenAiRun({
        db: database,
        userId: modelUserId,
        admittedTurnId: Option.none,
        nowEpochMs: () => 100_000_000,
        run: () => Promise.resolve(Response.json({})),
      });
      yield* fromTestPromise(() =>
        run(
          approvedOpenAiModel,
          {
            messages: [{ role: "user", content: "Hola" }],
            max_completion_tokens: 16_000,
            temperature: 0,
            stream: false,
            reasoning_effort: "none",
            store: false,
          },
          { signal: new AbortController().signal }
        )
      );
      const count = (): Promise<number> =>
        database
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_grants WHERE id LIKE 'openai-%'"
          )
          .first<{ readonly total: number }>()
          .then((row) => row?.total ?? 0);
      yield* sweepExpiredOpenAiAdmission({ db: database, now: 100_000_000 + 86_399_999 });
      expect(yield* fromTestPromise(count)).toBe(2);
      yield* sweepExpiredOpenAiAdmission({ db: database, now: 100_000_000 + 86_400_000 });
      expect(yield* fromTestPromise(count)).toBe(0);
    })
  ));

it.each([
  { phase: "attempt", failedBatch: 1, retainedClaims: 2 },
  { phase: "work", failedBatch: 2, retainedClaims: 4 },
])(
  "does not call the provider or compensate when committed $phase admission loses its response",
  ({ failedBatch, retainedClaims }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* fromTestPromise(prepareDatabase);
        yield* fromTestPromise(() => seedModelConsent(database));
        let batches = 0;
        let providerCalls = 0;
        const uncertainDatabase = new Proxy(database, {
          get: (target, key): unknown =>
            key === "batch"
              ? (statements: ReadonlyArray<D1PreparedStatement>): Promise<unknown> => {
                  batches += 1;
                  return target
                    .batch([...statements])
                    .then((result) =>
                      batches === failedBatch
                        ? Promise.reject(new Error("Response lost after commit"))
                        : result
                    );
                }
              : Reflect.get(target, key, target),
        });
        const run = makeAdmittedOpenAiRun({
          db: uncertainDatabase,
          userId: modelUserId,
          admittedTurnId: Option.none,
          nowEpochMs: () => 10_000,
          run: () => {
            providerCalls += 1;
            return Promise.resolve(Response.json({}));
          },
        });
        const outcome = yield* Effect.exit(
          Effect.tryPromise(() =>
            run(
              approvedOpenAiModel,
              {
                messages: [{ role: "user", content: "Hola" }],
                max_completion_tokens: 16_000,
                temperature: 0,
                stream: false,
                reasoning_effort: "none",
                store: false,
              },
              { signal: new AbortController().signal }
            )
          )
        );
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(providerCalls).toBe(0);
        expect(batches).toBe(failedBatch);
        const retained = yield* fromTestPromise(() =>
          database
            .prepare(
              "SELECT count(*) AS total FROM resource_admission_events WHERE released_at_epoch_ms IS NULL"
            )
            .first<{ readonly total: number }>()
        );
        expect(retained?.total).toBe(retainedClaims);
      })
    )
);
