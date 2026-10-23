import { Effect, Option, Schema } from "effect";
import { afterAll, expect } from "vitest";
import { it } from "@effect/vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { presentStatementSubmission } from "../ingestion/operations";
import { StatementSubmission } from "../../src/shell/ingestion/contract";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  PreparedCanonicalMutation,
} from "./contract";
import {
  executeMutationProgression,
  executeSingleCanonicalMutation,
} from "./internal/mutation-unit";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const userId = "10000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000002";
const digest = new Uint8Array(32).fill(1);
const submission = Schema.decodeSync(StatementSubmission)({
  id: "10000000-0000-4000-8000-000000000003",
  sourceFormat: "csv",
  parserRevision: "test",
  submittedAt: "2026-10-23T00:00:00Z",
  status: "queued",
});

const setup = Effect.gen(function* () {
  const db = yield* Effect.tryPromise(() => databases.acquire());
  yield* Effect.tryPromise(() => installTestSchema({ db }));
  yield* Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO users (id, service_market, locale, time_zone, created_at_ms) VALUES (?, 'CO', 'es-CO', 'America/Bogota', 0)"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO browser_login_pairings (id, public_code, verifier_digest, user_id, state, created_at_ms, expires_at_ms) VALUES ('10000000-0000-4000-8000-000000000004', 'ABCD-1234', ?, ?, 'consumed', 0, 600000)"
        )
        .bind(digest, userId),
      db
        .prepare(
          "INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms, fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms) VALUES (?, '10000000-0000-4000-8000-000000000004', ?, ?, 0, 600000, 3600000, 7776000000)"
        )
        .bind(sessionId, userId, digest),
      db.prepare(
        "CREATE TABLE recovery_writes (position INTEGER PRIMARY KEY, value INTEGER NOT NULL)"
      ),
    ])
  );
  return {
    db,
    subject: { id: sessionId, userId, digest },
    current: 1,
    hostedFence: Option.none(),
    oauthConfirmation: Option.none(),
  };
});

const refusal: CanonicalMutationRefusal = {
  code: "validation_failed",
  message: "Publication refused.",
  record: () => Effect.succeed("recorded" as const),
  respond: () => Effect.succeed(new Response("Publication refused.", { status: 409 })),
};

/** Exercise the canonical owner's prepared-mutation protocol against native D1 rollback. */
const publication = ({
  db,
  attempt,
  succeeds,
  lostReplay,
}: Readonly<{
  db: D1Database;
  attempt: number;
  succeeds: boolean;
  lostReplay: Effect.Effect<boolean>;
}>): PreparedCanonicalMutation => ({
  oauthReview: Option.none(),
  requiredScope: Option.none(),
  commitGuards: Option.none(),
  statements: [
    db
      .prepare("INSERT INTO recovery_writes (position, value) SELECT 0, ? WHERE ?")
      .bind(attempt, succeeds ? 1 : 0),
  ],
  outcome: {
    _tag: "StatementSubmission",
    operation: "ingestion.submitForExtraction",
    publication: { lostReplay, readCommitted: () => Effect.succeedSome(submission) },
  },
  guardRefusal: () => Effect.succeed(refusal),
});

it.effect("recovers one proven publication race and returns the committed individual result", () =>
  Effect.gen(function* () {
    const work = yield* setup;
    let attempts = 0;
    let checks = 0;
    const response = yield* executeSingleCanonicalMutation({
      ...work,
      preparation: Effect.sync((): CanonicalMutationPreparation => {
        attempts += 1;
        return {
          _tag: "Prepared",
          mutation: publication({
            db: work.db,
            attempt: attempts,
            succeeds: attempts === 2,
            lostReplay: Effect.sync(() => {
              checks += 1;
              return true;
            }),
          }),
        };
      }),
      present: presentStatementSubmission,
    });
    expect(response.status).toBe(202);
    expect(yield* Effect.tryPromise(() => response.json())).toMatchObject({
      data: { id: submission.id, status: "queued" },
    });
    expect(attempts).toBe(2);
    expect(checks).toBe(2);
    expect(
      (yield* Effect.tryPromise(() => work.db.prepare("SELECT * FROM recovery_writes").all()))
        .results
    ).toEqual([{ position: 0, value: 2 }]);
  })
);

it.effect("stops after the second aborted publication without committing either attempt", () =>
  Effect.gen(function* () {
    const work = yield* setup;
    let attempts = 0;
    let checks = 0;
    const response = yield* executeSingleCanonicalMutation({
      ...work,
      preparation: Effect.sync((): CanonicalMutationPreparation => {
        attempts += 1;
        if (attempts > 2) throw new Error("Publication recovery exceeded its bound");
        return {
          _tag: "Prepared",
          mutation: publication({
            db: work.db,
            attempt: attempts,
            succeeds: false,
            lostReplay: Effect.sync(() => {
              checks += 1;
              return true;
            }),
          }),
        };
      }),
      present: presentStatementSubmission,
    });
    expect(response.status).toBe(503);
    expect(attempts).toBe(2);
    expect(checks).toBe(3);
    expect(
      (yield* Effect.tryPromise(() => work.db.prepare("SELECT * FROM recovery_writes").all()))
        .results
    ).toEqual([]);
  })
);

it.effect("keeps Audit classification and the later replay-eligibility check separate", () =>
  Effect.gen(function* () {
    const work = yield* setup;
    let attempts = 0;
    let checks = 0;
    const response = yield* executeSingleCanonicalMutation({
      ...work,
      preparation: Effect.sync((): CanonicalMutationPreparation => {
        attempts += 1;
        return {
          _tag: "Prepared",
          mutation: publication({
            db: work.db,
            attempt: attempts,
            succeeds: false,
            lostReplay: Effect.sync(() => {
              checks += 1;
              return checks === 1;
            }),
          }),
        };
      }),
      present: presentStatementSubmission,
    });
    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
    expect(checks).toBe(2);
    expect(
      (yield* Effect.tryPromise(() => work.db.prepare("SELECT * FROM recovery_writes").all()))
        .results
    ).toEqual([]);
  })
);

it.effect(
  "reprepares every mutation and presents the recovered attempt with its own response projection",
  () =>
    Effect.gen(function* () {
      const work = yield* setup;
      let attempts = 0;
      const response = yield* executeMutationProgression({
        ...work,
        prepare: Effect.sync(() => {
          const attempt = ++attempts;
          const sibling: PreparedCanonicalMutation = {
            ...publication({
              db: work.db,
              attempt,
              succeeds: true,
              lostReplay: Effect.succeed(false),
            }),
            statements: [
              work.db
                .prepare("INSERT INTO recovery_writes (position, value) VALUES (1, ?)")
                .bind(attempt),
            ],
            outcome: {
              _tag: "Owner",
              operation: "transactions.createTransaction",
              collisionKey: Option.none(),
              guardFacts: Option.none(),
              read: () =>
                Effect.succeedSome({
                  _tag: "Owner",
                  payload: attempt,
                  encode: () => Effect.succeed(attempt),
                }),
            },
          };
          return {
            _tag: "Prepared" as const,
            mutations: [
              sibling,
              publication({
                db: work.db,
                attempt,
                succeeds: attempt === 2,
                lostReplay: Effect.succeed(true),
              }),
            ],
            respond: (execution: { _tag: string }): Effect.Effect<Response> =>
              Effect.succeed(Response.json({ attempt, status: execution._tag })),
          };
        }),
      });
      expect(yield* Effect.tryPromise(() => response.json())).toEqual({
        attempt: 2,
        status: "Committed",
      });
      expect(
        (yield* Effect.tryPromise(() =>
          work.db.prepare("SELECT * FROM recovery_writes ORDER BY position").all()
        )).results
      ).toEqual([
        { position: 0, value: 2 },
        { position: 1, value: 2 },
      ]);
    })
);

it.effect(
  "returns a refusal discovered during re-preparation without attempting another commit",
  () =>
    Effect.gen(function* () {
      const work = yield* setup;
      let attempts = 0;
      const response = yield* executeSingleCanonicalMutation({
        ...work,
        preparation: Effect.sync((): CanonicalMutationPreparation => {
          attempts += 1;
          return attempts === 1
            ? {
                _tag: "Prepared",
                mutation: publication({
                  db: work.db,
                  attempt: attempts,
                  succeeds: false,
                  lostReplay: Effect.succeed(true),
                }),
              }
            : { _tag: "Refused", refusal };
        }),
        present: presentStatementSubmission,
      });
      expect(response.status).toBe(409);
      expect(yield* Effect.tryPromise(() => response.text())).toBe("Publication refused.");
      expect(attempts).toBe(2);
      expect(
        (yield* Effect.tryPromise(() => work.db.prepare("SELECT * FROM recovery_writes").all()))
          .results
      ).toEqual([]);
    })
);
