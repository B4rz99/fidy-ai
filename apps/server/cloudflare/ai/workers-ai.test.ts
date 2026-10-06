import { deepStrictEqual } from "node:assert";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { TranscriptTurnId } from "../../src/core/agent/contract";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import {
  HostedInferenceError,
  type WorkersAiBindingRun,
  approvedWorkersAiModel,
} from "../../src/shell/hosted-inference/contract";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { hostedInitialTextContext, makeAdmittedWorkersAiRun } from "./admitted-run.test-fixture";
import { makeUserCloudflareHostedInference } from "./runtime";

class TestInvocationFailure extends Data.TaggedError("TestInvocationFailure") {}
const encodeJson = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userA = "10000000-0000-4000-8000-000000000001";
const userB = "20000000-0000-4000-8000-000000000002";
const grantA = "30000000-0000-4000-8000-000000000001";
const now = 1_800_000_000_000;
const sessionA = "40000000-0000-4000-8000-000000000001";
const pairingA = "50000000-0000-4000-8000-000000000001";
const seedSession = (db: D1Database): Promise<unknown> =>
  db.batch([
    db
      .prepare(`INSERT INTO browser_login_pairings
      (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms)
      VALUES (?, 'ABC-12345', zeroblob(32), ?, 'consumed', ?, ?)`)
      .bind(pairingA, userA, now, now + 600_000),
    db
      .prepare(`INSERT INTO web_sessions
      (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
      VALUES (?, ?, ?, zeroblob(32), ?, ?, ?, ?)`)
      .bind(sessionA, pairingA, userA, now, now + 600_000, now + 600_000, now + 7_776_000_000),
  ]);
const revoke = (db: D1Database): Promise<unknown> =>
  db
    .prepare(`INSERT INTO consent_user_revocations
    (id, user_id, grant_record_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?, ?)`)
    .bind("60000000-0000-4000-8000-000000000001", userA, grantA, sessionA, now + 1)
    .run();
const hostedSessionA = "70000000-0000-4000-8000-000000000001";
const turnA = TranscriptTurnId.make("80000000-0000-4000-8000-000000000001");
const seedPendingTurn = (db: D1Database): Promise<unknown> => {
  const disclosure = currentDisclosureFor();
  return db.batch([
    db
      .prepare(`INSERT INTO hosted_agent_sessions
      (id, user_id, consent_basis_json, started_at_ms, status) VALUES (?, ?, ?, ?, 'active')`)
      .bind(
        hostedSessionA,
        userA,
        encodeJson({
          grantId: grantA,
          disclosureRevision: disclosure.revision,
          disclosureSha256: disclosure.contentSha256,
          policyRevision: disclosure.policy.revision,
          policySha256: disclosure.policy.contentSha256,
        }),
        now
      ),
    db
      .prepare(`INSERT INTO hosted_turns
      (id, user_id, hosted_session_id, started_at_ms, status) VALUES (?, ?, ?, ?, 'pending')`)
      .bind(turnA, userA, hostedSessionA, now),
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
      VALUES ('user-entry', ?, ?, ?, 'user', ?, 'Hola')`)
      .bind(userA, hostedSessionA, turnA, now),
  ]);
};
const finishTurn = (db: D1Database): Promise<unknown> =>
  db.batch([
    db
      .prepare(`INSERT INTO transcript_entries
    (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms)
    VALUES ('interrupted-entry', ?, ?, ?, 'interrupted', ?)`)
      .bind(userA, hostedSessionA, turnA, now + 2),
    db
      .prepare(
        "UPDATE hosted_turns SET status = 'interrupted', terminal_at_ms = ? WHERE id = ? AND user_id = ?"
      )
      .bind(now + 2, turnA, userA),
  ]);
const setup = (): Promise<D1Database> =>
  databases.acquire().then((db) =>
    installTestSchema({
      db,
      sources: [
        "0001_categories",
        "0002_resource_admission",
        "0003_pending_consent",
        "0004_onboarding_email",
        "0005_verified_onboarding",
        "0006_browser_login",
        "0009_transactions",
        "0010_pat_lifecycle",
        "0016_hosted_turn",
      ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
    }).then(() => db)
  );
const seedGrant = (db: D1Database): Promise<unknown> =>
  db.batch([
    db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)").bind(userA, now),
    db.prepare("INSERT INTO users VALUES (?, 'CO', 'es-CO', 'America/Bogota', ?)").bind(userB, now),
    db
      .prepare(
        "INSERT INTO onboarding_consent_records VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)"
      )
      .bind(grantA, userA, encodeJson(currentDisclosureFor()), now, now),
  ]);
const invoke = (run: WorkersAiBindingRun): ReturnType<WorkersAiBindingRun> =>
  run(
    approvedWorkersAiModel,
    {
      messages: [{ role: "user", content: "Hola" }],
      max_tokens: 128,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    },
    { returnRawResponse: true, signal: new AbortController().signal }
  );
const admissionUnavailable = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "AdmissionUnavailable" },
    retryable: false,
    retryAfter: Option.none(),
  });

effectIt.effect("samples AI spend admission from the executing owner's Clock", () =>
  Effect.gen(function* () {
    const db = yield* Effect.tryPromise(setup);
    yield* Effect.tryPromise(() => seedGrant(db));
    yield* TestClock.setTime(now);
    const inference = yield* makeUserCloudflareHostedInference({
      environment: {
        AI: { run: () => Promise.resolve(Response.json({})) },
        HOSTED_AI_MODEL: approvedWorkersAiModel,
      },
      db,
      userId: userA,
      admittedTurnId: Option.none,
    });
    const prepared = yield* inference.prepareText({
      context: hostedInitialTextContext("Hola"),
      availableOperations: [],
      toolChoice: "none",
    });
    yield* TestClock.adjust("5 seconds");
    yield* Effect.exit(prepared.execute);
    const rows = yield* Effect.tryPromise(() =>
      db.prepare("SELECT admitted_at_epoch_ms FROM resource_admission_events").all()
    );
    expect(rows.results).toHaveLength(4);
    expect(rows.results).toEqual(
      Array.from({ length: 4 }, () => ({
        admitted_at_epoch_ms: now + 5_000,
      }))
    );
  })
);

effectIt.effect(
  "settles dispatched AI admission without starting provider work after interruption",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      const dispatched = yield* Deferred.make<void>();
      const settle = yield* Deferred.make<void>();
      let calls = 0;
      const runWithServices = Effect.runPromiseWith(yield* Effect.context<never>());
      const guardedDatabase = new Proxy(db, {
        get: (target, key): unknown =>
          key === "batch"
            ? (statements: ReadonlyArray<D1PreparedStatement>): Promise<unknown> =>
                runWithServices(
                  Deferred.succeed(dispatched, undefined).pipe(
                    Effect.andThen(Deferred.await(settle)),
                    Effect.andThen(Effect.tryPromise(() => target.batch([...statements])))
                  )
                )
            : Reflect.get(target, key, target),
      });
      const inference = yield* makeUserCloudflareHostedInference({
        environment: {
          AI: {
            run: () => {
              calls += 1;
              return Promise.resolve(Response.json({}));
            },
          },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        },
        db: guardedDatabase,
        userId: userA,
        admittedTurnId: Option.none,
      });
      const prepared = yield* inference.prepareText({
        context: hostedInitialTextContext("Hola"),
        availableOperations: [],
        toolChoice: "none",
      });
      const execution = yield* Effect.forkChild(prepared.execute);
      yield* Deferred.await(dispatched);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(execution));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(settle, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(execution);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(calls).toBe(0);
      const rows = yield* Effect.tryPromise(() =>
        db.prepare("SELECT * FROM resource_admission_events").all()
      );
      expect(rows.results).toHaveLength(2);
    })
);

it("does not send another User's content to Workers AI using a different User's Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      let providerCalls = 0;
      const run = makeAdmittedWorkersAiRun({
        db,
        userId: userB,
        nowEpochMs: () => now,
        admittedTurnId: Option.none,
        run: () => {
          providerCalls += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => invoke(run),
          catch: (failure) =>
            failure instanceof HostedInferenceError ? failure : new TestInvocationFailure(),
        })
      );
      deepStrictEqual(result, Exit.fail(admissionUnavailable()));
      expect(providerCalls).toBe(0);
    })
  ));

it("rechecks Consent after spend admission before sending preflight or standalone content", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      yield* Effect.tryPromise(() => seedSession(db));
      let providerCalls = 0;
      let withdrawn = false;
      let revokeBeforeEgress = false;
      const changedBeforeEgress = new Proxy(db, {
        get: (target, key): unknown =>
          key === "batch"
            ? (statements: D1PreparedStatement[]): Promise<D1Result[]> =>
                target.batch(statements).then((result) => {
                  if (!revokeBeforeEgress || withdrawn) return result;
                  withdrawn = true;
                  return revoke(target).then(() => result);
                })
            : Reflect.get(target, key, target),
      });
      const run = makeAdmittedWorkersAiRun({
        db: changedBeforeEgress,
        userId: userA,
        nowEpochMs: () => now,
        admittedTurnId: Option.none,
        run: () => {
          providerCalls += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      yield* Effect.tryPromise(() => invoke(run));
      revokeBeforeEgress = true;
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => invoke(run),
          catch: (failure) =>
            failure instanceof HostedInferenceError ? failure : new TestInvocationFailure(),
        })
      );
      deepStrictEqual(result, Exit.fail(admissionUnavailable()));
      expect(withdrawn).toBe(true);
      expect(providerCalls).toBe(1);
    })
  ));

it("keeps an admitted Turn's Consent basis through revocation but refuses its terminal replay", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      yield* Effect.tryPromise(() => seedSession(db));
      yield* Effect.tryPromise(() => seedPendingTurn(db));
      let providerCalls = 0;
      const run = makeAdmittedWorkersAiRun({
        db,
        userId: userA,
        nowEpochMs: () => now,
        admittedTurnId: () => Option.some(turnA),
        run: () => {
          providerCalls += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      yield* Effect.tryPromise(() => invoke(run));
      yield* Effect.tryPromise(() => revoke(db));
      yield* Effect.tryPromise(() => invoke(run));
      expect(providerCalls).toBe(2);
      yield* Effect.tryPromise(() => finishTurn(db));
      const replay = yield* Effect.exit(
        Effect.tryPromise({
          try: () => invoke(run),
          catch: (failure) =>
            failure instanceof HostedInferenceError ? failure : new TestInvocationFailure(),
        })
      );
      deepStrictEqual(replay, Exit.fail(admissionUnavailable()));
      expect(providerCalls).toBe(2);
    })
  ));

it("cannot use another User's Pending Turn to authorize model egress", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      yield* Effect.tryPromise(() => seedPendingTurn(db));
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "INSERT INTO onboarding_consent_records VALUES (?, ?, ?, 'disclosed', 'accepted', ?, ?)"
          )
          .bind(
            "30000000-0000-4000-8000-000000000002",
            userB,
            encodeJson(currentDisclosureFor()),
            now,
            now
          )
          .run()
      );
      let providerCalls = 0;
      const run = makeAdmittedWorkersAiRun({
        db,
        userId: userB,
        nowEpochMs: () => now,
        admittedTurnId: () => Option.some(turnA),
        run: () => {
          providerCalls += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => invoke(run),
          catch: (failure) =>
            failure instanceof HostedInferenceError ? failure : new TestInvocationFailure(),
        })
      );
      deepStrictEqual(result, Exit.fail(admissionUnavailable()));
      expect(providerCalls).toBe(0);
    })
  ));

it("fails closed when live Consent authority is unavailable after spend commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      yield* Effect.tryPromise(() => db.prepare("DROP TABLE consent_user_revocations").run());
      let providerCalls = 0;
      const run = makeAdmittedWorkersAiRun({
        db,
        userId: userA,
        nowEpochMs: () => now,
        admittedTurnId: Option.none,
        run: () => {
          providerCalls += 1;
          return Promise.resolve(Response.json({}));
        },
      });
      const result = yield* Effect.exit(
        Effect.tryPromise({
          try: () => invoke(run),
          catch: (failure) =>
            failure instanceof HostedInferenceError ? failure : new TestInvocationFailure(),
        })
      );
      deepStrictEqual(result, Exit.fail(admissionUnavailable()));
      expect(providerCalls).toBe(0);
    })
  ));

it("preserves the provider failure after Consent authorizes the action", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(setup);
      yield* Effect.tryPromise(() => seedGrant(db));
      const providerFailure = new Error("provider failed after accepting request");
      const run = makeAdmittedWorkersAiRun({
        db,
        userId: userA,
        nowEpochMs: () => now,
        admittedTurnId: Option.none,
        run: () => Promise.reject(providerFailure),
      });
      yield* Effect.tryPromise(() => expect(invoke(run)).rejects.toBe(providerFailure));
    })
  ));
