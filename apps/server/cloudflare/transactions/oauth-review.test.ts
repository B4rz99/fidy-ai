import { afterAll, expect, it } from "vitest";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { CanonicalOperationId } from "../../src/core/canonical-operations/contract";
import { atomicBatchOperation } from "../../src/shell/operations/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { TransactionPairInput, UpdateTransactionInput } from "../../src/core/transactions/contract";
import { type OAuthCaller, oauthResource } from "../../src/shell/oauth-agents/contract";
import type { TransactionCaller } from "../canonical-work/contract";
import type { PreparedCanonicalMutation } from "../canonical-operations/contract";
import { installedCanonicalOperations } from "../canonical-operations/operations";
import { prepareOAuthConfirmation } from "../oauth-confirmation/operations";
import {
  canonicalAdmissionMigrationNames,
  hostedTurnTestMigrations,
  installTestSchema,
  isolatedTestDatabases,
  statementAuditTestMigrations,
} from "../d1-test-fixture";
import { prepareCorrection, prepareUnlink } from "./operations";

const databases = isolatedTestDatabases();
class TestAdapterFailure extends Data.TaggedError("TestAdapterFailure") {}
const fromTestPromise = <A>(run: () => Promise<A>): Effect.Effect<A, TestAdapterFailure> =>
  Effect.tryPromise({ try: run, catch: () => new TestAdapterFailure() });
afterAll(() => Effect.runPromise(fromTestPromise(() => databases.dispose())));
const userId = UserId.make("10000000-0000-4000-8000-000000000051");
const first = "20000000-0000-4000-8000-000000000001";
const second = "20000000-0000-4000-8000-000000000002";
const third = "20000000-0000-4000-8000-000000000003";
const category = "10000000-0000-4000-8000-000000000016";
const sessionId = "30000000-0000-4000-8000-000000000001";
const credentialDigest = new Uint8Array(32).fill(1);
const subject: OAuthCaller = {
  userId,
  oauthConnectionId: OAuthConnectionId.make("40000000-0000-4000-8000-000000000001"),
  credentialId: OAuthCredentialId.make("40000000-0000-4000-8000-000000000002"),
  clientId: OAuthClientId.make("40000000-0000-4000-8000-000000000003"),
  resource: oauthResource,
  digest: credentialDigest,
  requiredScope: Option.some("write"),
};
const pair = Schema.decodeSync(Schema.toCodecJson(TransactionPairInput))({
  firstTransactionId: first,
  secondTransactionId: second,
});
const correction = Schema.decodeSync(Schema.toCodecJson(UpdateTransactionInput))({
  expectedRevision: 0,
  changes: { notes: "Corrección aprobada" },
});

const setup = (): Effect.Effect<D1Database, TestAdapterFailure> =>
  Effect.gen(function* () {
    const db = yield* fromTestPromise(() => databases.acquire());
    yield* fromTestPromise(() =>
      installTestSchema({
        db,
        sources: canonicalAdmissionMigrationNames([
          "0001_categories",
          "0002_resource_admission",
          "0003_pending_consent",
          "0005_verified_onboarding",
          "0006_browser_login",
          "0009_transactions",
          "0010_pat_lifecycle",
          "0011_transaction_corrections",
          "0012_statement_staging",
          "0012_transaction_search",
          "0013_category_keyword_rules",
          "0013_transaction_reconciliation",
          "0014_memory",
          "0015_statement_submission",
          "0016_statement_processing",
          "0016_budgets",
          "0016_hosted_turn",
          "0017_hosted_compaction",
          "0017_forwarded_email",
          "0017_statement_dispatch",
          "0018_batch_envelope_audit",
          "0019_canonical_child_guards",
          "0020_dashboard_projection",
          "0009_email_replacement",
          "0018_dashboard",
          "0018_insight_events",
          "0032_oauth_review",
          "0034_oauth_refresh",
          ...hostedTurnTestMigrations,
          ...statementAuditTestMigrations,
        ]).map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
      })
    );
    const now = yield* Clock.currentTimeMillis;
    yield* fromTestPromise(() =>
      db.batch([
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
          )
          .bind(userId, now),
        db
          .prepare(`INSERT INTO onboarding_consent_records
      (id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms)
      VALUES (?,?,'{}','disclosed','accepted',?,?)`)
          .bind(userId, userId, now, now),
        db
          .prepare(`INSERT INTO browser_login_pairings
      (id,public_code,verifier_digest,user_id,state,created_at_ms,expires_at_ms)
      VALUES (?,'ABCD-1234',?,?,'consumed',?,?)`)
          .bind(sessionId, credentialDigest, userId, now, now + 600000),
        db
          .prepare(`INSERT INTO web_sessions
      (id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms)
      VALUES (?,?,?,?,?,?,?,?)`)
          .bind(
            sessionId,
            sessionId,
            userId,
            credentialDigest,
            now,
            now + 600000,
            now + 3600000,
            now + 7776000000
          ),
        db
          .prepare(`INSERT INTO oauth_connections
      (id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms)
      VALUES (?,?,?,?,'Native client','http://127.0.0.1/callback',?,'["write"]',?,?)`)
          .bind(
            subject.oauthConnectionId,
            subject.oauthConnectionId,
            userId,
            subject.clientId,
            oauthResource,
            now,
            now + 86400000
          ),
        db
          .prepare(`INSERT INTO oauth_grant_consents
      (id,connection_id,user_id,session_id,disclosure_revision,disclosure_text,accepted_at_ms)
      VALUES (?,?,?,?,'test-v1','Disclosure',?)`)
          .bind(subject.oauthConnectionId, subject.oauthConnectionId, userId, sessionId, now),
        db
          .prepare(`INSERT INTO oauth_access_credentials
      (id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json)
      VALUES (?,?,?,?,?,?,'["write"]')`)
          .bind(
            subject.credentialId,
            subject.oauthConnectionId,
            userId,
            credentialDigest,
            now,
            now + 3600000
          ),
        ...[first, second, third].map((id) =>
          db
            .prepare(`INSERT INTO transactions
      (id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at,created_at)
      VALUES (?,?,'45000','COP','outflow',?,?,?,'2025-01-05T12:00:00.000Z',?)`)
            .bind(
              id,
              userId,
              id === first ? "Original" : "Institución",
              category,
              id === first ? "Primero" : "Segundo",
              id === first ? "2025-01-05T12:00:00.000Z" : "2025-01-06T12:00:00.000Z"
            )
        ),
        db
          .prepare(`INSERT INTO transaction_reconciliation_decisions
      (user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at)
      VALUES (?,?,?,'linked',?,'2025-01-07T12:00:00.000Z')`)
          .bind(userId, first, second, first),
        ...[first, second].map((id) =>
          db
            .prepare(`INSERT INTO transaction_reconciliation_members
      (user_id,transaction_id,first_transaction_id,second_transaction_id) VALUES (?,?,?,?)`)
            .bind(userId, id, first, second)
        ),
      ])
    );
    return db;
  });

type Work = "correction" | "unlink";
const prepare = (
  db: D1Database,
  work: Work,
  overrides?: Readonly<{ caller: TransactionCaller; id: string; current: number }>
): Effect.Effect<PreparedCanonicalMutation> =>
  Effect.gen(function* () {
    const { caller, id, current } = overrides ?? {
      caller: subject,
      id: first,
      current: yield* Clock.currentTimeMillis,
    };
    const preparation = yield* work === "correction"
      ? prepareCorrection({ db, subject: caller, id, input: correction, current })
      : prepareUnlink({ db, subject: caller, pair, current });
    if (preparation._tag !== "Prepared") {
      return yield* Effect.die(new Error(`Owner refused ${work}: ${preparation._tag}`));
    }
    return preparation.mutation;
  });

const retainedState = Schema.Struct({
  id: Schema.String,
  notes: Schema.NullOr(Schema.String),
  revision: Schema.Int,
});
const decisionState = Schema.Struct({
  state: Schema.String,
  visible_transaction_id: Schema.NullOr(Schema.String),
});
const countState = Schema.Struct({ count: Schema.Int });
const PersistedState = Schema.Struct({
  transactions: Schema.Array(retainedState),
  decisions: Schema.Array(decisionState),
  counts: Schema.Array(Schema.Int),
});
const persistedState = (
  db: D1Database
): Effect.Effect<typeof PersistedState.Type, TestAdapterFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const transactions = yield* fromTestPromise(() =>
      db.prepare("SELECT id,notes,revision FROM transactions ORDER BY id").all()
    );
    const decisions = yield* fromTestPromise(() =>
      db
        .prepare("SELECT state,visible_transaction_id FROM transaction_reconciliation_decisions")
        .all()
    );
    const counts = yield* Effect.forEach(
      [
        "transaction_corrections",
        "transaction_reconciliation_members",
        "pat_audit",
        "oauth_operation_intents",
      ],
      (table) =>
        Effect.gen(function* () {
          const row = yield* fromTestPromise(() =>
            db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()
          );
          return (yield* Schema.decodeUnknownEffect(countState)(row)).count;
        }),
      { concurrency: "unbounded" }
    );
    return yield* Schema.decodeUnknownEffect(PersistedState)({
      transactions: transactions.results,
      decisions: decisions.results,
      counts,
    });
  });

// The owner seam lends its exact observed guard to the native protected commit; this test does not
// duplicate the parent canonical unit or claim transport/host interoperability coverage.
const acceptedCommit = (
  db: D1Database,
  mutations: ReadonlyArray<PreparedCanonicalMutation>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const binding = mutations.map((mutation) => {
      const review = Option.getOrThrow(mutation.oauthReview);
      return {
        operation: CanonicalOperationId.make(mutation.outcome.operation),
        scope: Option.getOrNull(mutation.requiredScope),
        effect: review.effect,
        revision: review.revision,
      };
    });
    const correctionJson = yield* Schema.encodeEffect(Schema.toCodecJson(UpdateTransactionInput))(
      correction
    );
    const pairJson = yield* Schema.encodeEffect(Schema.toCodecJson(TransactionPairInput))(pair);
    const calls: Array<Schema.Json> = [
      {
        callId: "80000000-0000-4000-8000-000000000001",
        operation: "transactions.updateTransaction",
        input: {
          params: { id: mutations.length > 1 ? third : first },
          payload: correctionJson,
        },
      },
    ];
    if (mutations.length > 1) {
      calls.push({
        callId: "80000000-0000-4000-8000-000000000002",
        operation: "transactions.unlinkTransactions",
        input: { payload: pairJson },
      });
    }
    const input: Schema.Json = { calls };
    const work = { operation: atomicBatchOperation, input };
    const issued = yield* prepareOAuthConfirmation({
      db,
      subject,
      binding,
      work: { ...work, attempt: { _tag: "Review" } },
    });
    if (issued._tag !== "Review") {
      return yield* Effect.die(new Error("Native review unavailable"));
    }
    const accepted = yield* prepareOAuthConfirmation({
      db,
      subject,
      binding,
      work: {
        ...work,
        attempt: {
          _tag: "Decision",
          reference: issued.review.reference,
          response: { action: "accept", content: { confirm: true } },
        },
      },
    });
    if (accepted._tag !== "Prepared") {
      return yield* Effect.die(new Error("Native acceptance refused"));
    }
    return [
      ...accepted.statements,
      ...mutations.flatMap((mutation) => Option.getOrThrow(mutation.oauthReview).guards),
      ...mutations.flatMap((mutation) => mutation.statements),
    ];
  });

const correctionRank = (db: D1Database, id = second): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO transaction_corrections
  (id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at)
  VALUES ('50000000-0000-4000-8000-000000000001',?,?,0,'["notes"]','{}','{}','2025-01-08T12:00:00.000Z')`)
    .bind(userId, id);
const changedPremises: ReadonlyArray<
  Readonly<{ name: string; change: (db: D1Database) => Promise<unknown> }>
> = [
  {
    name: "effective Counterparty facts",
    change: (db) =>
      db
        .prepare("UPDATE transactions SET counterparty = 'Actualizada' WHERE id = ?")
        .bind(first)
        .run(),
  },
  {
    name: "the original correction revision",
    change: (db) =>
      db.batch([
        correctionRank(db, first),
        db.prepare("UPDATE transactions SET revision = 1 WHERE id = ?").bind(first),
      ]),
  },
  {
    name: "the Reconciliation visible identity",
    change: (db) =>
      db
        .prepare("UPDATE transaction_reconciliation_decisions SET visible_transaction_id = ?")
        .bind(second)
        .run(),
  },
  {
    name: "Reconciliation membership",
    change: (db) =>
      db
        .prepare("DELETE FROM transaction_reconciliation_members WHERE transaction_id = ?")
        .bind(second)
        .run(),
  },
  {
    name: "explicit User decision policy inputs",
    change: (db) =>
      db
        .prepare(`UPDATE transactions SET user_decisions = '{"counterparty":true}' WHERE id = ?`)
        .bind(second)
        .run(),
  },
  {
    name: "correction precedence without a new movement revision",
    change: (db) => correctionRank(db).run(),
  },
  {
    name: "statement-source precedence",
    change: (db) =>
      db.batch([
        db
          .prepare(`INSERT INTO statement_staging_objects
      (id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,source_format)
      VALUES ('60000000-0000-4000-8000-000000000002',?,'private-statement',1,?,'available',0,86400000,'csv')`)
          .bind(userId, "a".repeat(64)),
        db
          .prepare(`INSERT INTO statement_submissions
      (id,user_id,idempotency_key,staging_id,submitted_at_ms,source_format,parser_revision,service_market,locale,time_zone,status,retention_expires_at_ms)
      VALUES ('60000000-0000-4000-8000-000000000003',?,'60000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000002',0,'csv','statement-v1','CO','es-CO','America/Bogota','queued',86400000)`)
          .bind(userId),
        db
          .prepare(`INSERT INTO source_attestations
      (id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at,statement_submission_id,statement_record_number,statement_content_hash,source_format)
      VALUES ('60000000-0000-4000-8000-000000000001',?,?,'statement-line','CO','es-CO','America/Bogota','statement-v1','2025-01-08T12:00:00.000Z','60000000-0000-4000-8000-000000000003',1,?,'csv')`)
          .bind(userId, second, "a".repeat(64)),
      ]),
  },
  {
    name: "retained creation-order policy inputs",
    change: (db) =>
      db
        .prepare("UPDATE transactions SET created_at = '2025-01-04T12:00:00.000Z' WHERE id = ?")
        .bind(second)
        .run(),
  },
];

for (const work of ["correction", "unlink"] as const) {
  for (const premise of changedPremises) {
    it(`rolls back native protected ${work} and acceptance after changes to ${premise.name}`, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db = yield* setup();
          const current = yield* Clock.currentTimeMillis;
          const correctionMutation = yield* prepare(db, "correction", {
            id: work === "unlink" ? third : first,
            caller: subject,
            current,
          });
          const mutations =
            work === "correction"
              ? [correctionMutation]
              : [correctionMutation, yield* prepare(db, "unlink")];
          const statements = yield* acceptedCommit(db, mutations);
          yield* fromTestPromise(() => premise.change(db));
          const before = yield* persistedState(db);
          const rejected = yield* fromTestPromise(() => db.batch([...statements])).pipe(
            Effect.flip
          );
          expect(rejected).toBeInstanceOf(TestAdapterFailure);
          expect(yield* persistedState(db)).toEqual(before);
          expect(before.counts[3]).toBe(1);
        })
      ));
  }

  it(`keeps ${work} review stable across resume despite newly generated commit identities`, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* setup();
        const initial = Option.getOrThrow((yield* prepare(db, work)).oauthReview);
        const current = yield* Clock.currentTimeMillis;
        const resumed = Option.getOrThrow(
          (yield* prepare(db, work, {
            caller: subject,
            id: first,
            current: current + 60000,
          })).oauthReview
        );
        expect({ effect: resumed.effect, revision: resumed.revision }).toEqual({
          effect: initial.effect,
          revision: initial.revision,
        });
        expect(initial.effect).toContain(
          work === "correction"
            ? "Corregir la Transacción original"
            : "Desvincular la Reconciliación"
        );
        expect(initial.effect).toContain("45000");
        expect(initial.effect).toContain("COP");
        expect(initial.effect).toContain("Institución");
      })
    ));
}

it("commits unchanged correction and ordinary unlink together with one native acceptance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const current = yield* Clock.currentTimeMillis;
      const mutations = [
        yield* prepare(db, "correction", { id: third, caller: subject, current }),
        yield* prepare(db, "unlink"),
      ];
      const statements = yield* acceptedCommit(db, mutations);
      yield* fromTestPromise(() => db.batch([...statements]));
      expect(yield* persistedState(db)).toEqual({
        transactions: [
          { id: first, notes: "Primero", revision: 0 },
          { id: second, notes: "Segundo", revision: 0 },
          { id: third, notes: "Corrección aprobada", revision: 1 },
        ],
        decisions: [{ state: "keep-separate", visible_transaction_id: null }],
        counts: [1, 0, 2, 0],
      });
    })
  ));

it("executes ordinary OAuth unlink without native confirmation while retaining review for a sensitive batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const installed = installedCanonicalOperations();
      expect(
        installed.find(({ id }) => id === "transactions.updateTransaction")?.policy
          .agentConfirmation
      ).toBe("required");
      expect(
        installed.find(({ id }) => id === "transactions.unlinkTransactions")?.policy
          .agentConfirmation
      ).toBe("not-required");
      expect(installed.find(({ id }) => id === "transactions.deleteTransaction")).toBeUndefined();
      const mutation = yield* prepare(db, "unlink");
      expect(Option.isSome(mutation.oauthReview)).toBe(true);
      yield* fromTestPromise(() => db.batch([...mutation.statements]));
      expect((yield* persistedState(db)).counts).toEqual([0, 0, 1, 0]);
    })
  ));

it("does not introduce OAuth review or snapshot reads for PAT or browser Transaction preparation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* setup();
      const now = yield* Clock.currentTimeMillis;
      const patId = "70000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        db
          .prepare(`INSERT INTO pats
    (id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id)
    VALUES (?,?,'abcdefgh',?,'User agent','["write"]',7,?,?,?,?)`)
          .bind(patId, userId, credentialDigest, now, now, now + 86400000, patId)
          .run()
      );
      const callers: ReadonlyArray<TransactionCaller> = [
        { patId, userId, digest: credentialDigest, requiredScope: Option.some("write") },
        { id: sessionId, userId, digest: credentialDigest },
      ];
      const noOAuthSnapshot = new Proxy(db, {
        get(target, property): unknown {
          if (property === "prepare") {
            return (sql: string): D1PreparedStatement => {
              if (sql.includes("WITH roots(id)")) {
                throw new Error("Unexpected OAuth snapshot for non-OAuth caller");
              }
              return target.prepare(sql);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const checks: Array<Effect.Effect<void>> = [];
      for (const caller of callers) {
        for (const work of ["correction", "unlink"] as const) {
          checks.push(
            Effect.gen(function* () {
              const current = yield* Clock.currentTimeMillis;
              const mutation = yield* prepare(noOAuthSnapshot, work, {
                caller,
                id: first,
                current,
              });
              expect(Option.isNone(mutation.oauthReview)).toBe(true);
            })
          );
        }
      }
      yield* Effect.all(checks, { concurrency: "unbounded" });
    })
  ));
