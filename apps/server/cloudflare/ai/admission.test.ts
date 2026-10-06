import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { Data, Effect, Exit, Option } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { makeAdmittedWorkersAiRun } from "./admitted-run.test-fixture";
import { sweepExpiredWorkersAiAdmission } from "./runtime";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}
const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const prepareDatabase = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: [new URL("../migrations/0002_resource_admission.sql", import.meta.url)],
    }).then(() => db)
  );

const modelUserId = "10000000-0000-4000-8000-000000000001";
const seedModelConsent = (database: D1Database): Promise<unknown> =>
  installTestSchema({
    db: database,
    sources: [
      "0001_categories",
      "0003_pending_consent",
      "0004_onboarding_email",
      "0005_verified_onboarding",
      "0006_browser_login",
      "0009_transactions",
      "0010_pat_lifecycle",
    ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
  }).then(() =>
    database.batch([
      database
        .prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', 1000)")
        .bind(modelUserId),
      database
        .prepare(
          "INSERT INTO onboarding_consent_records VALUES ('30000000-0000-4000-8000-000000000001', ?, ?, 'disclosed', 'accepted', 1000, 1000)"
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
      const run = makeAdmittedWorkersAiRun({
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
        max_tokens: 16_000,
        temperature: 0 as const,
        stream: false as const,
        chat_template_kwargs: { enable_thinking: false as const },
      };
      const result = yield* Effect.exit(
        Effect.tryPromise(() =>
          run(approvedWorkersAiModel, request, {
            returnRawResponse: true,
            signal: new AbortController().signal,
          })
        )
      );
      expect(Exit.isFailure(result)).toBe(true);
      const charges = yield* fromTestPromise(() =>
        database
          .prepare(
            "SELECT units FROM resource_admission_events WHERE policy_key = 'workers-ai.spend.user.v1'"
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
      const run = makeAdmittedWorkersAiRun({
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
            approvedWorkersAiModel,
            {
              messages: [{ role: "user", content: "Hola" }],
              max_tokens: 16_000,
              temperature: 0,
              stream: false,
              chat_template_kwargs: { enable_thinking: false },
            },
            { returnRawResponse: true, signal: new AbortController().signal }
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
      const run = makeAdmittedWorkersAiRun({
        db: database,
        userId: modelUserId,
        admittedTurnId: Option.none,
        nowEpochMs: () => 100_000_000,
        run: () => Promise.resolve(Response.json({})),
      });
      yield* fromTestPromise(() =>
        run(
          approvedWorkersAiModel,
          {
            messages: [{ role: "user", content: "Hola" }],
            max_tokens: 16_000,
            temperature: 0,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          },
          { returnRawResponse: true, signal: new AbortController().signal }
        )
      );
      const count = (): Promise<number> =>
        database
          .prepare(
            "SELECT count(*) AS total FROM resource_admission_grants WHERE id LIKE 'workers-ai-%'"
          )
          .first<{ readonly total: number }>()
          .then((row) => row?.total ?? 0);
      yield* sweepExpiredWorkersAiAdmission({ db: database, now: 100_000_000 + 86_399_999 });
      expect(yield* fromTestPromise(count)).toBe(2);
      yield* sweepExpiredWorkersAiAdmission({ db: database, now: 100_000_000 + 86_400_000 });
      expect(yield* fromTestPromise(count)).toBe(0);
    })
  ));
