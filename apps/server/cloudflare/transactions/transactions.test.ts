import { NodeFileSystem } from "@effect/platform-node";
import { nativeClockPlatform, nativeTransactionReadPlatform } from "../user-store.test-fixture";
import {
  alice,
  makeNativeTransactionJourney,
  nativeBrowserWrite,
  nativeTransactionJourney,
  seedNativePAT,
} from "../financial-user-store.test-fixture";
import { TransactionInspection } from "../../src/shell/transactions/contract";
import {
  type AtomicBatchCall,
  AtomicBatchCallId,
  AtomicBatchRejected,
} from "../../src/shell/operations/contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Clock, Data, DateTime, Effect, Option, Schema } from "effect";
import {
  RestoredTransactionPair,
  Transaction,
  TransactionPresentation,
} from "../../src/core/transactions/contract";
import { encodeMoneyAmount } from "../../src/core/_shared/money";
import { ErrorCode, ScopeMissing } from "../../src/shell/public-http/contract";
import { transactionNow } from "../canonical-work/operations";

class TestPromiseFailure extends Data.TaggedError("TestPromiseFailure") {}

const fromTestPromise = <A>(promise: () => PromiseLike<A>): Effect.Effect<A> =>
  Effect.tryPromise({
    try: () => Promise.resolve(promise()),
    catch: () => new TestPromiseFailure(),
  }).pipe(Effect.orDie);

const users = ["10000000-0000-4000-8000-000000000051", "10000000-0000-4000-8000-000000000052"];

const sessions = ["10000000-0000-4000-8000-000000000061", "10000000-0000-4000-8000-000000000062"];

const category = "10000000-0000-4000-8000-000000000016";

const bearer = (index: number): string =>
  index < 2 ? String(index + 1).repeat(43) : String(index + 1).padStart(43, "0");

const request = (index: number, path = "/transactions", body?: object): Request =>
  new Request(`https://core.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Fidy-Session-Binding": sessions[index] ?? "invalid",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      ...Option.match(Option.fromUndefinedOr(body), {
        onNone: () => ({}),
        onSome: () => ({ "content-type": "application/json" }),
      }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const TestTransactionPayload = Schema.Struct({
  money: Schema.Struct({ amount: Schema.String, currency: Schema.String }),
  direction: Schema.String,
  categoryId: Schema.String,
  occurredAt: Schema.String,
  counterparty: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.String),
});

type TestTransactionPayload = typeof TestTransactionPayload.Type;

const input = (changes: Partial<TestTransactionPayload> = {}): TestTransactionPayload => ({
  money: { amount: "9007199254740993.15", currency: "USD" },
  direction: "outflow",
  categoryId: category,
  occurredAt: "2025-01-10T12:00:00.000Z",
  ...changes,
});

const Created = Schema.Struct({
  data: Schema.toCodecJson(Transaction),
  next: Schema.Array(Schema.Unknown),
});

const BatchResult = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Struct({
          data: Schema.toCodecJson(Transaction),
          next: Schema.Array(Schema.Unknown),
        }),
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});

const BatchEnvelope = Schema.Struct({
  data: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        callId: Schema.String,
        operation: Schema.String,
        output: Schema.Unknown,
      })
    ),
  }),
  next: Schema.Array(Schema.Unknown),
});

const CallerFailure = Schema.Struct({ error: Schema.Struct({ code: ErrorCode }) });

const BatchRejection = AtomicBatchRejected;

const batchCallId = (suffix: number): AtomicBatchCallId =>
  Schema.decodeSync(AtomicBatchCallId)(
    `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`
  );

const TestCorrectionPayload = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  changes: Schema.Struct({
    notes: Schema.optionalKey(Schema.String),
    categoryId: Schema.optionalKey(Schema.String),
    counterparty: Schema.optionalKey(Schema.String),
    money: Schema.optionalKey(Schema.Struct({ amount: Schema.String, currency: Schema.String })),
    direction: Schema.optionalKey(Schema.String),
    occurredAt: Schema.optionalKey(Schema.String),
  }),
});

type TestCorrectionPayload = typeof TestCorrectionPayload.Type;

const transactionCall = (suffix: number, payload: TestTransactionPayload): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.createTransaction",
  input: { payload },
});

const correctionCall = (
  suffix: number,
  id: string,
  payload: TestCorrectionPayload
): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.updateTransaction",
  input: { params: { id }, payload },
});

const linkCall = (suffix: number, first: string, second: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.linkTransactions",
  input: { payload: { firstTransactionId: first, secondTransactionId: second } },
});

const unlinkCall = (suffix: number, first: string, second: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "transactions.unlinkTransactions",
  input: { payload: { firstTransactionId: first, secondTransactionId: second } },
});

const memoryCall = (suffix: number, text: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.remember",
  input: { payload: { text } },
});

const reviseMemoryCall = (suffix: number, id: string, text: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.revise",
  input: { params: { id }, payload: { text } },
});

const keywordRuleCall = (suffix: number, keyword: string, categoryId: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.createKeywordRule",
  input: { payload: { keyword, categoryId } },
});

const updateKeywordRuleCall = (
  suffix: number,
  id: string,
  payload: Readonly<{ keyword: string; categoryId: string }>
): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.updateKeywordRule",
  input: { params: { id }, payload },
});

const deleteKeywordRuleCall = (suffix: number, id: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "categories.deleteKeywordRule",
  input: { params: { id } },
});

const forgetMemoryCall = (suffix: number, id: string): AtomicBatchCall => ({
  callId: batchCallId(suffix),
  operation: "memory.forget",
  input: { params: { id } },
});

const batchRequest = (index: number, calls: ReadonlyArray<AtomicBatchCall>): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      "Fidy-Session-Binding": sessions[index] ?? "invalid",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });

const bearerRequest = (
  index: number,
  token: string,
  calls: ReadonlyArray<AtomicBatchCall>
): Request =>
  new Request("https://api.fidyapp.com/operations/atomic-batch", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      authorization: `Bearer ${token}`,
      "x-provider-id": users[index] ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ calls }),
  });

type RetainedTransactionFacts = Readonly<{
  userId: string;
  id: string;
  categoryId: string;
}> &
  Partial<{
    amount: string;
    currency: string;
    direction: "inflow" | "outflow";
    counterparty: string;
    notes: string;
    occurredAt: string;
    createdAt: string;
    userDecisions: string;
  }>;

const retainedTransactionDefaults = {
  amount: "45000",
  currency: "COP",
  direction: "outflow",
  occurredAt: "2025-01-05T12:00:00.000Z",
  createdAt: "2025-01-05T12:00:00.000Z",
  userDecisions: "{}",
} as const;

const DecisionStateRow = Schema.Struct({
  first: Schema.String,
  second: Schema.String,
  state: Schema.String,
  visible: Schema.OptionFromNullOr(Schema.String),
});

const MemberRow = Schema.Struct({ id: Schema.String });

type ReconciliationState = Readonly<{
  decisions: ReadonlyArray<{
    first: string;
    second: string;
    state: string;
    visible: Option.Option<string>;
  }>;
  members: ReadonlyArray<{ transaction: string }>;
}>;

type NativeJourney = Effect.Success<typeof nativeTransactionJourney>;

const seedNativeTransaction = ({
  db,
  userId,
  id,
  categoryId,
  counterparty,
  notes,
  ...overrides
}: RetainedTransactionFacts & { db: NativeJourney }): ReturnType<NativeJourney["exec"]> => {
  const facts = { ...retainedTransactionDefaults, ...overrides };

  return db
    .owner(userId)
    .exec(
      "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,notes,occurred_at_ms,created_at_ms,user_decisions) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      userId,
      facts.amount,
      facts.currency,
      facts.direction,
      counterparty ?? null,
      categoryId,
      notes ?? null,
      DateTime.toEpochMillis(DateTime.makeUnsafe(facts.occurredAt)),
      DateTime.toEpochMillis(DateTime.makeUnsafe(facts.createdAt)),
      facts.userDecisions
    );
};

const seedNativeSource = ({
  db,
  userId,
  id,
  transactionId,
}: {
  db: NativeJourney;
  userId: string;
  id: string;
  transactionId: string;
}): ReturnType<NativeJourney["exec"]> =>
  db
    .owner(userId)
    .exec(
      "INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms) VALUES (?,?,?,'manual','CO','es-CO','America/Bogota','manual-v1',0)",
      id,
      userId,
      transactionId
    );

const nativeCountRows = (
  db: NativeJourney,
  sql: string,
  ...bindings: [] | [string]
): Promise<unknown> =>
  db
    .owner(bindings[0] ?? users[0] ?? "")
    .exec(sql, ...bindings)
    .then(([row]) => row?.count);

const AuditedOperations = Schema.Array(
  Schema.Struct({ operation: Schema.String, outcome: Schema.String })
);

const nativeAuditedOperations = (
  db: NativeJourney,
  user: string
): Promise<typeof AuditedOperations.Type> =>
  db
    .owner(user)
    .exec(
      "SELECT operation,outcome FROM audit_entries WHERE user_id=? AND record_type='session_call' ORDER BY occurred_at_ms,rowid",
      user
    )
    .then(Schema.decodeUnknownSync(AuditedOperations));

const nativeRefusedChildren = (
  db: NativeJourney,
  user: string
): ReturnType<NativeJourney["exec"]> =>
  db
    .owner(user)
    .exec(
      "SELECT operation,outcome FROM audit_entries WHERE user_id=? AND record_type='session_call' AND outcome='validation_failed' AND operation<>'operations.executeAtomicBatch' ORDER BY rowid",
      user
    );

const nativeReconciliationState = (db: NativeJourney, user: string): Promise<ReconciliationState> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const local = db.owner(user);

      const decisions = yield* fromTestPromise(() =>
        local.exec(
          "SELECT first_transaction_id AS first,second_transaction_id AS second,state,visible_transaction_id AS visible FROM transaction_reconciliation_decisions WHERE user_id=? ORDER BY first_transaction_id",
          user
        )
      );

      const members = yield* fromTestPromise(() =>
        local.exec(
          "SELECT transaction_id AS id FROM reconciled_transactions WHERE user_id=? ORDER BY transaction_id",
          user
        )
      );

      return {
        decisions: yield* Schema.decodeUnknownEffect(Schema.Array(DecisionStateRow))(decisions),
        members: (yield* Schema.decodeUnknownEffect(Schema.Array(MemberRow))(members)).map(
          ({ id }) => ({
            transaction: id,
          })
        ),
      };
    })
  );

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));

afterEach(() => vi.useRealTimers());

const groupCorrectionRequest = (index: number, payload: object): Request => {
  const original = request(index, "/transactions/corrections", payload);
  const headers = new Headers(original.headers);
  headers.set("origin", "https://app.fidyapp.com");

  return new Request(original, { headers });
};

it("corrects a selected group of 500 Transactions in one atomic save with retained correction evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const prefix = "52000000-0000-4000-8000-";
      yield* fromTestPromise(() =>
        db.exec(
          "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?) INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT printf(?||'%012d',i),?,'10','COP','outflow',?,1736078400000,1736078400000 FROM seq",
          500,
          prefix,
          owner,
          category
        )
      );

      const transactions = Array.from({ length: 500 }, (_, index) => ({
        id: `${prefix}${String(index + 1).padStart(12, "0")}`,
        expectedRevision: 0,
      }));

      const result = yield* fromTestPromise(() =>
        db.send(
          groupCorrectionRequest(0, {
            transactions,
            changes: { notes: "Corregidas juntas" },
          })
        )
      );

      expect(result.status).toBe(200);
      expect(yield* fromTestPromise(() => result.json())).toEqual({
        data: { updated: 500 },
        next: [],
      });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT count(*) AS count FROM transactions WHERE user_id = ? AND revision = 1 AND notes = 'Corregidas juntas'",
            owner
          )
        )
      ).toBe(500);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT count(*) AS count FROM transaction_corrections WHERE user_id = ?",
            owner
          )
        )
      ).toBe(500);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, owner))).toContainEqual({
        operation: "transactions.updateTransactions",
        outcome: "success",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("composes a group correction larger than 4 KiB with another atomic mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const prefix = "53000000-0000-4000-8000-";
      const count = 64;
      yield* fromTestPromise(() =>
        db.exec(
          "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<?) INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms) SELECT printf(?||'%012d',i),?,'10','COP','outflow',?,1736078400000,1736078400000 FROM seq",
          count,
          prefix,
          owner,
          category
        )
      );

      const group: AtomicBatchCall = {
        callId: batchCallId(1),
        operation: "transactions.updateTransactions",
        input: {
          payload: {
            transactions: Array.from({ length: count }, (_, index) => ({
              id: `${prefix}${String(index + 1).padStart(12, "0")}`,
              expectedRevision: 0,
            })),
            changes: { notes: "Corregidas juntas" },
          },
        },
      };

      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        group.input
      ).pipe(Effect.orDie);

      expect(new TextEncoder().encode(encoded).length).toBeGreaterThan(4096);

      const result = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [group, keywordRuleCall(2, "preferencia confirmada", category)]))
      );

      expect(result.status).toBe(200);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT count(*) AS count FROM transactions WHERE user_id = ? AND revision = 1 AND notes = 'Corregidas juntas'",
            owner
          )
        )
      ).toBe(count);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, owner))).toEqual([
        { operation: "transactions.updateTransactions", outcome: "success" },
        { operation: "categories.createKeywordRule", outcome: "success" },
        { operation: "operations.executeAtomicBatch", outcome: "success" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ? AND keyword = 'preferencia confirmada'",
            owner
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects foreign, missing, duplicate, deleted and stale group members without partial corrections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const own = "52000000-0000-4000-8000-000000000001";
      const foreign = "52000000-0000-4000-8000-000000000002";
      const deleted = "52000000-0000-4000-8000-000000000003";
      const missing = "52000000-0000-4000-8000-000000000004";
      const stale = "52000000-0000-4000-8000-000000000005";
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, notes: "seed", userId: owner, id: own, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[1] ?? "",
          id: foreign,
          categoryId: category,
        })
      );
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, notes: "seed", userId: owner, id: stale, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: owner,
          id: deleted,
          categoryId: category,
        })
      );
      yield* fromTestPromise(() =>
        db.exec(
          "UPDATE transactions SET deleted_at_ms = ? WHERE user_id = ? AND id = ?",
          transactionNow(),
          owner,
          deleted
        )
      );

      yield* Effect.forEach(
        [
          { id: foreign, expectedRevision: 0 },
          { id: missing, expectedRevision: 0 },
          { id: own, expectedRevision: 0 },
          { id: deleted, expectedRevision: 0 },
          { id: stale, expectedRevision: 1 },
        ],
        Effect.fnUntraced(function* (invalid) {
          const result = yield* fromTestPromise(() =>
            db.send(
              groupCorrectionRequest(0, {
                transactions: [{ id: own, expectedRevision: 0 }, invalid],
                changes: { notes: "Sin guardar" },
              })
            )
          );

          expect(result.status).toBe(
            invalid.id === foreign || invalid.id === missing || invalid.id === deleted ? 404 : 400
          );
          expect(
            yield* fromTestPromise(() =>
              nativeCountRows(db, "SELECT count(*) AS count FROM transaction_corrections")
            )
          ).toBe(0);
          expect(
            yield* fromTestPromise(() =>
              nativeCountRows(db, "SELECT count(*) AS count FROM transactions WHERE revision != 0")
            )
          ).toBe(0);
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back every group correction and its evidence when final Audit is refused", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const ids = ["52000000-0000-4000-8000-000000000001", "52000000-0000-4000-8000-000000000002"];

      yield* Effect.forEach(
        ids,
        Effect.fnUntraced(function* (id) {
          yield* fromTestPromise(() =>
            seedNativeTransaction({ db, notes: "seed", userId: owner, id, categoryId: category })
          );
        }),
        { discard: true }
      );

      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER refuse_group_audit BEFORE INSERT ON audit_entries
    WHEN NEW.operation = 'transactions.updateTransactions' AND NEW.outcome = 'success'
    BEGIN SELECT RAISE(IGNORE); END`)
      );

      const result = yield* fromTestPromise(() =>
        db.send(
          groupCorrectionRequest(0, {
            transactions: ids.map((id) => ({ id, expectedRevision: 0 })),
            changes: { notes: "Sin guardar" },
          })
        )
      );

      expect(result.status).not.toBe(200);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transactions WHERE revision != 0")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses under-scoped and oversized group corrections before changing any selected Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const userId = users[0] ?? "";
      const id = "52000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, notes: "seed", userId, id, categoryId: category })
      );
      const token = `fin_${"r".repeat(8)}_${"r".repeat(43)}`;
      const current = yield* Clock.currentTimeMillis;
      yield* seedNativePAT({ db, userId, token, scopes: ["read"], current });

      const payload = {
        transactions: [{ id, expectedRevision: 0 }],
        changes: { notes: "Sin guardar" },
      };

      const denied = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/transactions/corrections", {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        )
      );

      expect(denied.status).toBe(403);

      const oversized = yield* fromTestPromise(() =>
        db.send(
          groupCorrectionRequest(0, {
            transactions: Array.from({ length: 4097 }, (_, index) => ({
              id: `52000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              expectedRevision: 0,
            })),
            changes: payload.changes,
          })
        )
      );

      expect(oversized.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transactions WHERE revision != 0")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back the whole group when one selected row stops accepting its correction at commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const userId = users[0] ?? "";
      const ids = ["52000000-0000-4000-8000-000000000001", "52000000-0000-4000-8000-000000000002"];

      yield* Effect.forEach(
        ids,
        Effect.fnUntraced(function* (id) {
          yield* fromTestPromise(() =>
            seedNativeTransaction({ db, notes: "seed", userId, id, categoryId: category })
          );
        }),
        { discard: true }
      );

      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER refuse_one_group_row BEFORE UPDATE ON transactions
      WHEN OLD.id = '52000000-0000-4000-8000-000000000002' BEGIN SELECT RAISE(IGNORE); END`)
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          groupCorrectionRequest(0, {
            transactions: ids.map((id) => ({ id, expectedRevision: 0 })),
            changes: { notes: "Sin guardar" },
          })
        )
      );

      expect(response.status).not.toBe(200);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transactions WHERE revision != 0")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

const postTransaction = (index: number, body: object): Request =>
  new Request("https://api.fidyapp.com/transactions", {
    method: "POST",
    headers: {
      origin: "https://app.fidyapp.com",
      "Fidy-Session-Binding": sessions[index] ?? "invalid",
      cookie: `__Host-fidy_session=${bearer(index)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const Listed = Schema.Struct({
  data: Schema.Array(Schema.toCodecJson(Transaction)),
  next: Schema.Array(Schema.Unknown),
});

const EffectiveTransaction = Schema.Struct({
  data: Schema.toCodecJson(TransactionPresentation),
  next: Schema.Array(Schema.Unknown),
});

const RestoredPair = Schema.Struct({
  data: Schema.toCodecJson(RestoredTransactionPair),
  next: Schema.Array(Schema.Unknown),
});

const ListedMemories = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  next: Schema.Array(Schema.Unknown),
});

const ListedKeywordRules = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, keyword: Schema.String, categoryId: Schema.String })
  ),
  next: Schema.Array(Schema.Unknown),
});

it("searches only the caller's FinancialRecord with bounded literal terms", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const send = (index: number, path: string, body?: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[index] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...Option.match(Option.fromUndefinedOr(body), {
                onNone: () => ({}),
                onSome: () => ({ "content-type": "application/json" }),
              }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );

      const own = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Café 100%", notes: "Almuerzo" }))
      );

      const foreign = yield* fromTestPromise(() =>
        send(1, "/transactions", input({ counterparty: "Café 100%" }))
      );

      expect(own.status).toBe(201);
      expect(foreign.status).toBe(201);

      const ownId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => own.json())
      )).data.id;

      const foreignId = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => foreign.json())
      )).data.id;

      const found = yield* fromTestPromise(() =>
        send(0, "/transactions/search?q=%20%20Caf%C3%A9%20100%25%20")
      );

      expect(found.status).toBe(200);

      const result = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => found.json())
      );

      expect(result.data.map((item) => item.id)).toEqual([ownId]);
      expect(result.next).toEqual([]);

      yield* Effect.forEach(
        [
          [1, ownId],
          [0, foreignId],
          [0, "100_"],
        ] as const,
        Effect.fnUntraced(function* ([index, term]) {
          const response = yield* fromTestPromise(() =>
            send(index, `/transactions/search?q=${encodeURIComponent(term)}`)
          );

          expect(
            (yield* Schema.decodeUnknownEffect(Listed)(
              yield* fromTestPromise(() => response.json())
            )).data
          ).toEqual([]);
        }),
        { discard: true }
      );

      const unicodeTerm = encodeURIComponent("é".repeat(80));
      expect(
        (yield* fromTestPromise(() => send(0, `/transactions/search?q=${unicodeTerm}`))).status
      ).toBe(200);

      yield* Effect.forEach(
        [
          `/transactions/search?q=${"a".repeat(3000)}`,
          "/transactions/search?q=%25",
          "/transactions/search?q=a",
          `/transactions/search?q=${"x".repeat(100)}`,
          "/transactions/search?q=valid&q=valid",
          "/transactions/search?q=valid&cursor=bad",
          "/transactions/search?q=%ZZ",
          "/transactions/search?q=%FF%FF",
        ],
        Effect.fnUntraced(function* (path) {
          yield* Effect.sleep("100 millis");
          const rejected = yield* fromTestPromise(() => send(0, path));
          expect(rejected.status).toBe(400);
          expect(rejected.headers.get("cache-control")).toBe("no-store");
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("links one exact pair into one effective Transaction while retaining both originals and provenance", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000102";
      const suppressed = "30000000-0000-4000-8000-000000000101";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            counterparty: "Cafe Uno",
            notes: "notificacion",
            amount: "9007199254740993.01",
            occurredAt: "2025-01-05T12:00:00.003Z",
            createdAt: "2025-01-05T12:00:00.001Z",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            counterparty: "Cafe Dos",
            notes: "extracto",
            amount: "9007199254740993.01",
            occurredAt: "2025-01-05T12:00:00.004Z",
            createdAt: "2025-01-05T12:00:00.002Z",
          }),
        ]).then(() =>
          Promise.all([
            seedNativeSource({
              db,
              userId: owner,
              transactionId: visible,
              id: "30000000-0000-4000-8000-000000000201",
            }),
            seedNativeSource({
              db,
              userId: owner,
              transactionId: suppressed,
              id: "30000000-0000-4000-8000-000000000202",
            }),
          ])
        )
      );

      const send = (path: string, body?: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              ...Option.match(Option.fromUndefinedOr(body), {
                onNone: () => ({}),
                onSome: () => ({ "content-type": "application/json" }),
              }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );

      const linked = yield* fromTestPromise(() =>
        send("/transactions/link", {
          firstTransactionId: suppressed,
          secondTransactionId: visible,
        })
      );

      expect(linked.status).toBe(200);

      const effectiveTransaction = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => linked.json())
      ).pipe(Effect.orDie)).data;

      expect(effectiveTransaction.id).toBe(visible);
      expect(encodeMoneyAmount(effectiveTransaction.money.amount)).toBe("9007199254740993.01");
      expect(DateTime.formatIso(effectiveTransaction.createdAt)).toBe("2025-01-05T12:00:00.001Z");
      expect(DateTime.formatIso(effectiveTransaction.occurredAt)).toBe("2025-01-05T12:00:00.003Z");
      expect(effectiveTransaction.revision).toBe(0);
      expect(effectiveTransaction.presentation).toEqual({ kind: "visible-member" });
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "success" },
      ]);

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send("/transactions").then((response) => response.json()))
      ).pipe(Effect.orDie)).data;

      expect(listed.map((transaction) => transaction.id)).toEqual([visible]);

      const requestedSuppressed = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(requestedSuppressed.id).toBe(visible);
      expect(requestedSuppressed.presentation).toEqual({
        kind: "suppressed-member",
        requestedId: suppressed,
      });

      const requestedVisible = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() =>
          send(`/transactions/${visible}`).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(requestedVisible.presentation).toEqual({ kind: "visible-member" });

      const inspection = (yield* Schema.decodeUnknownEffect(
        Schema.Struct({ data: TransactionInspection })
      )(
        yield* fromTestPromise(() =>
          send(`/transactions/${visible}`).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(inspection.reconciliation.kind).toBe("linked");

      const provenance = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({
            sources: Schema.Array(
              Schema.Struct({ transactionId: Schema.String, kinds: Schema.Array(Schema.String) })
            ),
          }),
        })
      )(
        yield* fromTestPromise(() =>
          send(`/transactions/${visible}`).then((response) => response.json())
        )
      );

      expect(provenance.data.sources).toEqual([
        { transactionId: suppressed, kinds: ["manual"] },
        { transactionId: visible, kinds: ["manual"] },
      ]);

      if (inspection.reconciliation.kind !== "linked") throw new Error("Missing linked originals");
      expect(inspection.reconciliation.firstTransaction.id).toBe(suppressed);
      expect(inspection.reconciliation.secondTransaction.id).toBe(visible);
      expect(inspection.reconciliation.firstTransaction.counterparty).toEqual(
        Option.some("Cafe Dos")
      );
      expect(inspection.reconciliation.secondTransaction.counterparty).toEqual(
        Option.some("Cafe Uno")
      );
      expect(encodeMoneyAmount(inspection.reconciliation.firstTransaction.money.amount)).toBe(
        "9007199254740993.01"
      );

      const foreignInspection = yield* fromTestPromise(() =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions/${visible}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[1] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(1)}`,
            },
          })
        )
      );

      expect(foreignInspection.status).toBe(404);

      const searched = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(`/transactions/search?q=${encodeURIComponent("Cafe Uno")}`).then((response) =>
            response.json()
          )
        )
      ).pipe(Effect.orDie)).data;

      expect(searched.map((transaction) => transaction.id)).toEqual([visible]);

      const retained = yield* fromTestPromise(() =>
        db.exec(
          "SELECT id, counterparty, notes FROM transactions WHERE user_id = ? ORDER BY id",
          owner
        )
      );

      expect(retained).toEqual([
        { id: suppressed, counterparty: "Cafe Dos", notes: "extracto" },
        { id: visible, counterparty: "Cafe Uno", notes: "notificacion" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(2);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          { first: suppressed, second: visible, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: suppressed }, { transaction: visible }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses ineligible pairs without writing any relation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const base = "30000000-0000-4000-8000-00000000015";

      const pairs = [
        {
          first: `${base}1`,
          second: `${base}2`,
          secondFacts: { currency: "USD", amount: "9007199254740993.01" },
        },
        { first: `${base}3`, second: `${base}4`, secondFacts: { amount: "9007199254740993.02" } },
        {
          first: `${base}5`,
          second: `${base}6`,
          secondFacts: { direction: "inflow" as const, amount: "9007199254740993.01" },
        },
      ];

      yield* fromTestPromise(() =>
        Promise.all(
          pairs.flatMap((pair) => [
            seedNativeTransaction({
              db,
              userId: owner,
              id: pair.first,
              categoryId: category,
              amount: "9007199254740993.01",
            }),
            seedNativeTransaction({
              db,
              userId: owner,
              id: pair.second,
              categoryId: category,
              ...pair.secondFacts,
            }),
          ])
        )
      );

      const send = (body: object): Promise<Response> =>
        db.send(
          new Request("https://api.fidyapp.com/transactions/link", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );

      yield* Effect.forEach(
        pairs,
        Effect.fnUntraced(function* (pair) {
          const refused = yield* fromTestPromise(() =>
            send({ firstTransactionId: pair.first, secondTransactionId: pair.second })
          );

          expect(refused.status).toBe(400);
          expect(refused.headers.get("cache-control")).toBe("no-store");
        }),
        { discard: true }
      );

      const repeated = yield* fromTestPromise(() =>
        send({ firstTransactionId: `${base}1`, secondTransactionId: `${base}1` })
      );

      expect(repeated.status).toBe(400);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          db
            .send(
              new Request("https://api.fidyapp.com/transactions", {
                headers: {
                  origin: "https://app.fidyapp.com",
                  "Fidy-Session-Binding": sessions[0] ?? "invalid",
                  cookie: `__Host-fidy_session=${bearer(0)}`,
                },
              })
            )
            .then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(listed.map((transaction) => transaction.id).sort()).toEqual(
        pairs.flatMap((pair) => [pair.first, pair.second]).sort()
      );
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND operation = 'transactions.linkTransactions' AND outcome = 'validation_failed'",
            owner
          )
        )
      ).toBe(4);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("unlinks the exact pair, restores both originals, and remembers keep-separate", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000301";
      const suppressed = "30000000-0000-4000-8000-000000000302";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            occurredAt: "2025-01-05T12:00:00.001Z",
            createdAt: "2025-01-05T12:00:00.002Z",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.003Z",
            createdAt: "2025-01-06T12:00:00.004Z",
          }),
        ]).then(() =>
          seedNativeSource({
            db,
            userId: owner,
            transactionId: suppressed,
            id: "30000000-0000-4000-8000-000000000402",
          })
        )
      );

      const send = (path: string, body: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );

      const link = (): Promise<Response> =>
        send("/transactions/link", {
          firstTransactionId: visible,
          secondTransactionId: suppressed,
        });

      expect((yield* fromTestPromise(link)).status).toBe(200);

      const unlinked = yield* fromTestPromise(() =>
        send("/transactions/unlink", {
          firstTransactionId: suppressed,
          secondTransactionId: visible,
        })
      );

      expect(unlinked.status).toBe(200);

      const restored = (yield* Schema.decodeUnknownEffect(RestoredPair)(
        yield* fromTestPromise(() => unlinked.json())
      ).pipe(Effect.orDie)).data;

      expect(restored.firstTransaction.id).toBe(visible);
      expect(restored.secondTransaction.id).toBe(suppressed);
      expect(restored.firstTransaction.revision).toBe(0);
      expect(restored.secondTransaction.revision).toBe(0);
      expect(DateTime.formatIso(restored.firstTransaction.occurredAt)).toBe(
        "2025-01-05T12:00:00.001Z"
      );
      expect(DateTime.formatIso(restored.firstTransaction.createdAt)).toBe(
        "2025-01-05T12:00:00.002Z"
      );
      expect(DateTime.formatIso(restored.secondTransaction.occurredAt)).toBe(
        "2025-01-06T12:00:00.003Z"
      );
      expect(DateTime.formatIso(restored.secondTransaction.createdAt)).toBe(
        "2025-01-06T12:00:00.004Z"
      );
      expect(restored.firstTransaction.presentation).toEqual({ kind: "independent" });
      expect(restored.secondTransaction.presentation).toEqual({ kind: "independent" });
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: visible,
            second: suppressed,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(1);

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          db
            .send(
              new Request("https://api.fidyapp.com/transactions", {
                headers: {
                  origin: "https://app.fidyapp.com",
                  "Fidy-Session-Binding": sessions[0] ?? "invalid",
                  cookie: `__Host-fidy_session=${bearer(0)}`,
                },
              })
            )
            .then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(listed.map((transaction) => transaction.id)).toEqual([suppressed, visible]);
      expect(
        (yield* fromTestPromise(() =>
          send("/transactions/unlink", {
            firstTransactionId: visible,
            secondTransactionId: suppressed,
          })
        )).status
      ).toBe(400);
      expect((yield* fromTestPromise(link)).status).toBe(200);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          { first: visible, second: suppressed, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: visible }, { transaction: suppressed }],
      });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions') AND outcome = 'success'",
            owner
          )
        )
      ).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it.each([
  { command: "link", facts: { currency: "unknown" } },
  { command: "unlink", facts: { amount: "45000.001" } },
])("withholds $command when retained pair facts are unreadable", ({ command, facts }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000591";
      const second = "30000000-0000-4000-8000-000000000592";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: first, categoryId: category, ...facts }),
          seedNativeTransaction({ db, userId: owner, id: second, categoryId: category }),
        ])
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          new Request(
            request(0, `/transactions/${command}`, {
              firstTransactionId: first,
              secondTransactionId: second,
            }),
            {
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": sessions[0] ?? "invalid",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
            }
          )
        )
      );

      expect(response.status).toBe(503);
      expect(yield* fromTestPromise(() => response.json())).toMatchObject({
        error: { code: "unavailable" },
        next: [],
      });
      expect(
        yield* fromTestPromise(() =>
          db.exec("SELECT count(*) AS count FROM canonical_request_buckets")
        )
      ).toEqual([{ count: 0 }]);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, owner))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  )
);

it("refuses duplicate, chained, and cross-User links without partial relation state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const neighbor = users[1] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000501";
      const secondId = "30000000-0000-4000-8000-000000000502";
      const thirdId = "30000000-0000-4000-8000-000000000503";
      const foreign = "30000000-0000-4000-8000-000000000504";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({
            db,
            userId: owner,
            id: firstId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: secondId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: thirdId,
            categoryId: category,
            counterparty: "Cafe Central",
          }),
          seedNativeTransaction({ db, userId: neighbor, id: foreign, categoryId: category }),
        ])
      );

      const send = (index: number, path: string, body?: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[index] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...Option.match(Option.fromUndefinedOr(body), {
                onNone: () => ({}),
                onSome: () => ({ "content-type": "application/json" }),
              }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );

      expect(
        (yield* fromTestPromise(() =>
          send(0, "/transactions/link", {
            firstTransactionId: firstId,
            secondTransactionId: secondId,
          })
        )).status
      ).toBe(200);

      yield* Effect.forEach(
        [
          { firstTransactionId: firstId, secondTransactionId: secondId },
          { firstTransactionId: firstId, secondTransactionId: thirdId },
          { firstTransactionId: secondId, secondTransactionId: thirdId },
        ],
        Effect.fnUntraced(function* (pair) {
          expect((yield* fromTestPromise(() => send(0, "/transactions/link", pair))).status).toBe(
            400
          );
        }),
        { discard: true }
      );

      expect(
        (yield* fromTestPromise(() =>
          send(0, "/transactions/link", {
            firstTransactionId: firstId,
            secondTransactionId: foreign,
          })
        )).status
      ).toBe(404);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          { first: firstId, second: secondId, state: "linked", visible: Option.some(firstId) },
        ],
        members: [{ transaction: firstId }, { transaction: secondId }],
      });

      const neighborList = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(1, "/transactions").then((response) => response.json()))
      ).pipe(Effect.orDie)).data;

      expect(neighborList.map((transaction) => transaction.id)).toEqual([foreign]);
      expect((yield* fromTestPromise(() => send(1, `/transactions/${firstId}`))).status).toBe(404);
      expect((yield* fromTestPromise(() => send(1, `/transactions/${secondId}`))).status).toBe(404);

      const neighborSearch = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(1, "/transactions/search?q=Cafe").then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(neighborSearch).toEqual([]);

      const ownerSearch = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          send(0, "/transactions/search?q=Cafe").then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(ownerSearch.map((transaction) => transaction.id).sort()).toEqual(
        [firstId, thirdId].sort()
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("serializes concurrent links through the User coordinator so only one pair commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000601";
      const secondId = "30000000-0000-4000-8000-000000000602";
      const thirdId = "30000000-0000-4000-8000-000000000603";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: firstId, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: secondId, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: thirdId, categoryId: category }),
        ])
      );

      const link = (firstId: string, secondId: string): Promise<Response> =>
        db.send(
          new Request("https://api.fidyapp.com/transactions/link", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ firstTransactionId: firstId, secondTransactionId: secondId }),
          })
        );

      const results = yield* fromTestPromise(() =>
        Promise.all([link(firstId, secondId), link(secondId, thirdId), link(firstId, secondId)])
      );

      expect(results.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 400, 400,
      ]);
      const state = yield* fromTestPromise(() => nativeReconciliationState(db, owner));
      expect(state.decisions).toHaveLength(1);
      expect(state.decisions[0]?.state).toBe("linked");
      expect(state.members).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("keeps the effective Transaction consistent after corrections to either member", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const correctedCategory = "10000000-0000-4000-8000-000000000012";
      const visible = "30000000-0000-4000-8000-000000000701";
      const suppressed = "30000000-0000-4000-8000-000000000702";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({
            db,
            userId: owner,
            id: visible,
            categoryId: category,
            counterparty: "Original",
            occurredAt: "2025-01-05T12:00:00.000Z",
            createdAt: "2025-01-05T12:00:00.000Z",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            counterparty: "Extracto",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
        ]).then(() =>
          seedNativeSource({
            db,
            userId: owner,
            transactionId: visible,
            id: "30000000-0000-4000-8000-000000000801",
          })
        )
      );

      const send = (path: string, method: string, body: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        );

      expect(
        (yield* fromTestPromise(() =>
          send("/transactions/link", "POST", {
            firstTransactionId: visible,
            secondTransactionId: suppressed,
          })
        )).status
      ).toBe(200);

      const read = (id: string): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions/${id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        );

      const beforeSuppressed = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(suppressed).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;

      expect(beforeSuppressed.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`, "PUT", {
            expectedRevision: beforeSuppressed.revision,
            changes: { categoryId: correctedCategory, counterparty: "Corregido" },
          })
        )).status
      ).toBe(200);

      const corrected = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(suppressed).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;

      expect(corrected.id).toBe(visible);
      expect(corrected.revision).toBe(1);
      expect(corrected.categoryId).toBe(correctedCategory);
      expect(Option.getOrNull(corrected.counterparty)).toBe("Corregido");
      expect(DateTime.formatIso(corrected.occurredAt)).toBe("2025-01-06T12:00:00.000Z");

      const visiblePresentation = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        yield* fromTestPromise(() => read(visible).then((response) => response.json()))
      ).pipe(Effect.orDie)).data;

      expect(visiblePresentation.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${suppressed}`, "PUT", {
            expectedRevision: 0,
            changes: { notes: "late" },
          })
        )).status
      ).toBe(400);
      expect(
        (yield* fromTestPromise(() =>
          send(`/transactions/${visible}`, "PUT", {
            expectedRevision: visiblePresentation.revision,
            changes: { notes: "Nota visible" },
          })
        )).status
      ).toBe(200);

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          db
            .send(
              new Request("https://api.fidyapp.com/transactions", {
                headers: {
                  origin: "https://app.fidyapp.com",
                  "Fidy-Session-Binding": sessions[0] ?? "invalid",
                  cookie: `__Host-fidy_session=${bearer(0)}`,
                },
              })
            )
            .then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(visible);
      expect(listed[0]?.categoryId).toBe(correctedCategory);
      expect(Option.getOrNull(listed[0]?.counterparty ?? Option.none())).toBe("Corregido");
      expect(Option.getOrNull(listed[0]?.notes ?? Option.none())).toBe("Nota visible");

      const RetainedFacts = Schema.Struct({
        id: Schema.String,
        counterparty: Schema.OptionFromNullOr(Schema.String),
        notes: Schema.OptionFromNullOr(Schema.String),
      });

      const retained = yield* fromTestPromise(() =>
        db
          .exec(
            "SELECT id, counterparty, notes FROM transactions WHERE user_id = ? ORDER BY id",
            owner
          )
          .then((rows) => Schema.decodeUnknownSync(Schema.Array(RetainedFacts))(rows))
      );

      expect(retained).toEqual([
        { id: visible, counterparty: Option.some("Original"), notes: Option.some("Nota visible") },
        { id: suppressed, counterparty: Option.some("Corregido"), notes: Option.none() },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_corrections WHERE user_id = ?",
            owner
          )
        )
      ).toBe(2);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            owner
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it.each(["same-instant", "one-millisecond-newer"] as const)(
  "derives each effective fact group with %s correction ordering",
  (ordering) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeNativeTransactionJourney(undefined, nativeClockPlatform);
        const owner = users[0] ?? "";
        const visible = "30000000-0000-4000-8000-000000000a01";
        const suppressed = "30000000-0000-4000-8000-000000000a02";
        const suppressedCategory = "10000000-0000-4000-8000-000000000012";
        yield* fromTestPromise(() =>
          Promise.all([
            seedNativeTransaction({
              db,
              userId: owner,
              id: visible,
              categoryId: category,
              counterparty: "Uno",
              notes: "visible",
            }),
            seedNativeTransaction({
              db,
              userId: owner,
              id: suppressed,
              categoryId: suppressedCategory,
              counterparty: "Dos",
              notes: "suppressed",
              occurredAt: "2025-01-06T12:00:00.000Z",
              createdAt: "2025-01-06T12:00:00.000Z",
              userDecisions: JSON.stringify({ categoryId: true, counterparty: true }),
            }),
          ])
        );
        expect(
          (yield* fromTestPromise(() =>
            db.send(
              new Request("https://api.fidyapp.com/transactions/link", {
                method: "POST",
                headers: {
                  origin: "https://app.fidyapp.com",
                  "Fidy-Session-Binding": sessions[0] ?? "invalid",
                  cookie: `__Host-fidy_session=${bearer(0)}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  firstTransactionId: visible,
                  secondTransactionId: suppressed,
                }),
              })
            )
          )).status
        ).toBe(200);

        const listed = (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() =>
            db
              .send(
                new Request("https://api.fidyapp.com/transactions", {
                  headers: {
                    origin: "https://app.fidyapp.com",
                    "Fidy-Session-Binding": sessions[0] ?? "invalid",
                    cookie: `__Host-fidy_session=${bearer(0)}`,
                  },
                })
              )
              .then((response) => response.json())
          )
        ).pipe(Effect.orDie)).data;

        const effective = listed[0];

        if (effective === undefined) throw new Error("Missing effective Transaction");
        expect(listed).toHaveLength(1);
        expect(effective.categoryId).toBe(suppressedCategory);
        expect(Option.getOrNull(effective.counterparty)).toBe("Dos");
        expect(Option.getOrNull(effective.notes)).toBe("visible");
        expect(DateTime.formatIso(effective.occurredAt)).toBe("2025-01-05T12:00:00.000Z");
        const instant = vi.getRealSystemTime() + 1000;
        yield* fromTestPromise(() =>
          db.exec("CREATE TABLE fixture_clock(instant INTEGER NOT NULL)")
        );
        yield* fromTestPromise(() => db.exec("INSERT INTO fixture_clock VALUES (?)", instant));
        const firstDate = "2025-01-07T12:00:00.000Z";
        const secondDate = "2025-01-08T12:00:00.000Z";

        yield* Effect.forEach(
          [
            [visible, firstDate],
            [suppressed, secondDate],
          ] as const,
          Effect.fnUntraced(function* ([id, occurredAt]) {
            const offset = ordering === "one-millisecond-newer" && id === visible ? 1 : 0;
            yield* fromTestPromise(() =>
              db.exec("UPDATE fixture_clock SET instant=?", instant + offset)
            );

            const correctedMember = yield* nativeBrowserWrite(db)(alice, {
              method: "PUT",
              path: "/transactions/" + id,
              body: { expectedRevision: 0, changes: { occurredAt } },
            });

            expect(correctedMember.status).toBe(200);
            yield* fromTestPromise(() => correctedMember.arrayBuffer());
          }),
          { discard: true }
        );

        yield* fromTestPromise(() => db.exec("UPDATE fixture_clock SET instant=?", instant + 1000));
        const expectedDate = ordering === "same-instant" ? secondDate : firstDate;
        const expectedSource = [{ occurred_at_ms: Date.parse(expectedDate) }];
        expect(
          yield* fromTestPromise(() =>
            db.exec("SELECT occurred_at_ms FROM transaction_effective_source WHERE id=?", visible)
          )
        ).toEqual(expectedSource);
        expect(
          yield* fromTestPromise(() =>
            db.exec("SELECT occurred_at_ms FROM transaction_projection_leaf WHERE id=?", visible)
          )
        ).toEqual(expectedSource);

        const corrected = (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() =>
            db
              .send(
                new Request("https://api.fidyapp.com/transactions", {
                  headers: {
                    origin: "https://app.fidyapp.com",
                    "Fidy-Session-Binding": sessions[0] ?? "invalid",
                    cookie: `__Host-fidy_session=${bearer(0)}`,
                  },
                })
              )
              .then((response) => response.json())
          )
        ).pipe(Effect.orDie)).data;

        const correctedTransaction = corrected[0];

        if (correctedTransaction === undefined) throw new Error("Missing effective Transaction");
        expect(DateTime.formatIso(correctedTransaction.occurredAt)).toBe(expectedDate);
        expect(correctedTransaction.categoryId).toBe(suppressedCategory);
        expect(Option.getOrNull(correctedTransaction.counterparty)).toBe("Dos");
        expect(Option.getOrNull(correctedTransaction.notes)).toBe("visible");
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
    )
);

it("links and unlinks under the caller's live credential scope and records only metadata for an agent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const firstId = "30000000-0000-4000-8000-000000000901";
      const secondId = "30000000-0000-4000-8000-000000000902";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({
            db,
            userId: owner,
            id: firstId,
            categoryId: category,
            counterparty: "Agente",
          }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: secondId,
            categoryId: category,
            counterparty: "Agente",
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
        ])
      );
      const current = yield* Clock.currentTimeMillis;
      const readToken = `fin_${"r".repeat(8)}_${"r".repeat(43)}`;
      const writeToken = `fin_${"w".repeat(8)}_${"d".repeat(43)}`;
      yield* seedNativePAT({ db, userId: owner, token: readToken, scopes: ["read"], current });
      yield* seedNativePAT({ db, userId: owner, token: writeToken, scopes: ["write"], current });

      const bearerRequest = (token: string, path: string, body?: object): Request =>
        new Request(`https://api.fidyapp.com${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            authorization: `Bearer ${token}`,
            "x-provider-id": owner,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      const pair = { firstTransactionId: firstId, secondTransactionId: secondId };
      expect(
        (yield* fromTestPromise(() =>
          db.send(bearerRequest(readToken, "/transactions/link", pair))
        )).status
      ).toBe(403);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });

      const linked = yield* fromTestPromise(() =>
        db.send(bearerRequest(writeToken, "/transactions/link", pair))
      );

      expect(linked.status).toBe(200);

      const listed = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          db.send(bearerRequest(readToken, "/transactions")).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(listed.map((transaction) => transaction.id)).toEqual([firstId]);

      const searched = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() =>
          db
            .send(
              bearerRequest(readToken, `/transactions/search?q=${encodeURIComponent("Agente")}`)
            )
            .then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      expect(searched.map((transaction) => transaction.id)).toEqual([firstId]);
      expect(
        (yield* fromTestPromise(() =>
          db.send(bearerRequest(writeToken, "/transactions/unlink", pair))
        )).status
      ).toBe(200);

      const audits = yield* fromTestPromise(() =>
        db.exec(
          `SELECT operation,outcome FROM audit_entries WHERE record_type='credential_call' AND user_id=?
              AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions')
              ORDER BY operation,rowid`,
          owner
        )
      );

      expect(audits).toEqual([
        { operation: "transactions.linkTransactions", outcome: "rejected" },
        { operation: "transactions.linkTransactions", outcome: "accepted" },
        { operation: "transactions.unlinkTransactions", outcome: "accepted" },
      ]);
      yield* fromTestPromise(() =>
        db.exec(
          "UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?",
          current,
          writeToken.slice(4, 12)
        )
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(bearerRequest(writeToken, "/transactions/link", pair))
        )).status
      ).toBe(401);
      const expiredToken = `fin_${"x".repeat(8)}_${"g".repeat(43)}`;
      yield* seedNativePAT({ db, userId: owner, token: expiredToken, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db.exec(
          "UPDATE pats SET created_at_ms = ?, issued_at_ms = ?, expires_at_ms = ? WHERE short_id = ?",
          current - 2000,
          current - 2000,
          current - 1,
          expiredToken.slice(4, 12)
        )
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(bearerRequest(expiredToken, "/transactions/link", pair))
        )).status
      ).toBe(401);
      const withdrawnGrant = "50000000-0000-4000-8000-000000000011";
      const consentToken = `fin_${"c".repeat(8)}_${"e".repeat(43)}`;
      yield* seedNativePAT({ db, userId: owner, token: consentToken, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db.exec(
          `INSERT INTO consent_history (record_type,id,user_id,occurred_at_ms) VALUES ('processing_grant',?,?,?)`,
          withdrawnGrant,
          owner,
          current
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          `INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,?)`,
          "50000000-0000-4000-8000-000000000012",
          owner,
          withdrawnGrant,
          sessions[0] ?? "",
          current
        )
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(bearerRequest(consentToken, "/transactions/link", pair))
        )).status
      ).toBe(403);
      yield* fromTestPromise(() =>
        db.exec("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?", current, sessions[0])
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request("https://api.fidyapp.com/transactions/unlink", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": sessions[0] ?? "invalid",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(pair),
            })
          )
        )).status
      ).toBe(401);
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: firstId,
            second: secondId,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            `SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE user_id = ?
              AND operation IN ('transactions.linkTransactions', 'transactions.unlinkTransactions')
              AND outcome = 'accepted'`,
            owner
          )
        )
      ).toBe(2);
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request("https://api.fidyapp.com/transactions/link", {
              method: "POST",
              headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
              body: JSON.stringify(pair),
            })
          )
        )).status
      ).toBe(401);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("corrects selected facts once, retains decisions and evidence, and rejects stale or foreign corrections", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const methodFor = (path: string, body?: object): string => {
        if (body === undefined) return "GET";

        return path === "/transactions" ? "POST" : "PUT";
      };

      const send = (index: number, path: string, body?: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method: methodFor(path, body),
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[index] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              ...Option.match(Option.fromUndefinedOr(body), {
                onNone: () => ({}),
                onSome: () => ({ "content-type": "application/json" }),
              }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );

      const createdResponse = yield* fromTestPromise(() =>
        send(0, "/transactions", input({ counterparty: "Acme" }))
      );

      expect(createdResponse.status).toBe(201);

      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => createdResponse.json())
      ).pipe(Effect.orDie)).data;

      const path = `/transactions/${created.id}`;

      const correction = {
        expectedRevision: 0,
        changes: { categoryId: "10000000-0000-4000-8000-000000000001", counterparty: null },
      };

      expect((yield* fromTestPromise(() => send(1, path, correction))).status).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request(`https://api.fidyapp.com${path}`, {
              method: "PUT",
              headers: {
                origin: "https://app.fidyapp.com",
                authorization: `Bearer ${bearer(0)}`,
                "x-provider-id": users[0] ?? "",
                "content-type": "application/json",
              },
              body: JSON.stringify(correction),
            })
          )
        )).status
      ).toBe(401);
      expect(
        (yield* fromTestPromise(() => send(0, path, { expectedRevision: 0, changes: {} }))).status
      ).toBe(400);
      expect(
        (yield* fromTestPromise(() => send(0, "/transactions/not-a-transaction-id", correction)))
          .status
      ).toBe(404);
      expect(
        (yield* fromTestPromise(() =>
          db
            .exec(
              "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND operation = 'transactions.updateTransaction' AND outcome = 'not_found'",
              users[0] ?? ""
            )
            .then((rows) => rows[0])
        ))?.count
      ).toBe(1);
      const changed = yield* fromTestPromise(() => send(0, path, correction));
      expect(changed.status).toBe(200);

      const result = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => changed.json())
      ).pipe(Effect.orDie)).data;

      expect(result.id).toBe(created.id);
      expect(result.revision).toBe(1);
      expect(result.money).toEqual(created.money);
      expect(Option.isNone(result.counterparty)).toBe(true);
      expect(result.categoryId).toBe(correction.changes.categoryId);
      expect((yield* fromTestPromise(() => send(0, path, correction))).status).toBe(400);
      const fetched = yield* fromTestPromise(() => send(0, path));
      expect(fetched.status).toBe(200);

      const stored = yield* fromTestPromise(() =>
        db
          .exec("SELECT revision, user_decisions FROM transactions WHERE id = ?", created.id)
          .then((rows) => rows[0])
      );

      expect(stored?.revision).toBe(1);
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
        )(stored?.user_decisions).pipe(Effect.orDie)
      ).toEqual({
        money: true,
        direction: true,
        occurredAt: true,
        categoryId: true,
        counterparty: true,
      });

      const evidence = yield* fromTestPromise(() =>
        db
          .exec(
            "SELECT before_facts, after_facts FROM transaction_corrections WHERE transaction_id = ?",
            created.id
          )
          .then((rows) => rows[0])
      );

      expect(evidence?.before_facts).toContain("Acme");
      expect(evidence?.after_facts).not.toContain("Acme");
      expect(
        (yield* fromTestPromise(() =>
          db
            .exec(
              "SELECT COUNT(*) AS count FROM source_attestations WHERE transaction_id = ?",
              created.id
            )
            .then((rows) => rows[0])
        ))?.count
      ).toBe(1);
      yield* fromTestPromise(() =>
        expect(
          db.exec("UPDATE transaction_corrections SET changed_fields = '[]'")
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db.exec("UPDATE transactions SET user_decisions = '{}' WHERE id = ?", created.id)
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db.exec("UPDATE transactions SET category_id = ? WHERE id = ?", category, created.id)
        ).rejects.toThrow()
      );
      yield* fromTestPromise(() =>
        expect(
          db.exec(
            "UPDATE transactions SET category_id = ?, revision = revision + 1 WHERE id = ?",
            category,
            created.id
          )
        ).rejects.toThrow()
      );
      expect(
        (yield* fromTestPromise(() =>
          db
            .exec("SELECT revision FROM transactions WHERE id = ?", created.id)
            .then((rows) => rows[0])
        ))?.revision
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("serializes competing corrections and rolls back evidence when the correction audit refuses a write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const send = (path: string, method: string, body?: object): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            method,
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
        );

      const created = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() =>
          send("/transactions", "POST", input()).then((response) => response.json())
        )
      ).pipe(Effect.orDie)).data;

      const path = `/transactions/${created.id}`;
      const first = { expectedRevision: 0, changes: { notes: "first" } };
      yield* fromTestPromise(() =>
        db.exec(
          `CREATE TRIGGER refuse_correction_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'transactions.updateTransaction' BEGIN SELECT RAISE(IGNORE); END`
        )
      );
      expect((yield* fromTestPromise(() => send(path, "PUT", first))).status).not.toBe(200);

      const empty = yield* fromTestPromise(() =>
        db
          .exec("SELECT revision FROM transactions WHERE id = ?", created.id)
          .then((rows) => rows[0])
      );

      expect(empty?.revision).toBe(0);
      expect(
        (yield* fromTestPromise(() =>
          db.exec("SELECT COUNT(*) AS count FROM transaction_corrections").then((rows) => rows[0])
        ))?.count
      ).toBe(0);
      yield* fromTestPromise(() => db.exec("DROP TRIGGER refuse_correction_audit"));

      const results = yield* fromTestPromise(() =>
        Promise.all([
          send(path, "PUT", first),
          send(path, "PUT", { expectedRevision: 0, changes: { notes: "second" } }),
        ])
      );

      expect(results.map(({ status }) => status).sort((left, right) => left - right)).toEqual([
        200, 400,
      ]);
      expect(
        (yield* fromTestPromise(() =>
          db.exec("SELECT COUNT(*) AS count FROM transaction_corrections").then((rows) => rows[0])
        ))?.count
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back public Transaction capture when its audit silently refuses a write, then permits retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const post = (): Promise<Response> =>
        db.send(
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input()),
          })
        );

      yield* Effect.tryPromise({
        try: () =>
          db.exec(
            `CREATE TRIGGER refuse_capture_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'transactions.createTransaction' BEGIN SELECT RAISE(IGNORE); END`
          ),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).not.toBe(
        201
      );

      yield* Effect.forEach(
        ["transactions", "source_attestations"],
        Effect.fnUntraced(function* (table) {
          expect(
            yield* fromTestPromise(() =>
              db.exec(`SELECT count(*) AS total FROM ${table} WHERE user_id=?`, users[0] ?? "")
            )
          ).toEqual([{ total: 0 }]);
        }),
        { discard: true }
      );

      yield* Effect.tryPromise({
        try: () => db.exec("DROP TRIGGER refuse_capture_audit"),
        catch: () => undefined,
      });
      expect((yield* Effect.tryPromise({ try: post, catch: () => undefined })).status).toBe(201);
      expect(
        yield* fromTestPromise(() => db.exec("SELECT count(*) AS total FROM transactions"))
      ).toEqual([{ total: 1 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("coordinates concurrent public mutations through a real per-User Durable Object binding", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const post = (index: number): Promise<Response> => db.send(postTransaction(index, input()));
      const results = yield* fromTestPromise(() => Promise.all([post(0), post(0), post(1)]));
      expect(results.map(({ status }) => status)).toEqual([201, 201, 201]);
      const transactions = results.map((response) => response.json());
      const [first, second, other] = yield* fromTestPromise(() => Promise.all(transactions));

      const created = [first, second, other].map(
        (value) => Schema.decodeUnknownSync(Created)(value).data
      );

      expect(new Set(created.map(({ id }) => id)).size).toBe(3);
      const browse = db.browser;
      const ownerListResponse = yield* fromTestPromise(() => browse(0));

      const owner = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerListResponse.json())
      ).pipe(Effect.orDie)).data;

      const neighborListResponse = yield* fromTestPromise(() => browse(1));

      const neighbor = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborListResponse.json())
      ).pipe(Effect.orDie)).data;

      expect(new Set(owner.map(({ id }) => id))).toEqual(
        new Set(created.slice(0, 2).map(({ id }) => id))
      );
      expect(neighbor).toEqual([created[2]]);
      const protectedTransaction = created[0];

      if (protectedTransaction === undefined) throw new Error("Missing owner capture");
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${protectedTransaction.id}`))).status
      ).toBe(404);

      const attemptedDeletion = db.send(
        new Request(`https://api.fidyapp.com/transactions/${protectedTransaction.id}`, {
          method: "DELETE",
          headers: {
            origin: "https://app.fidyapp.com",
            "Fidy-Session-Binding": sessions[1] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(1)}`,
            authorization: `Bearer ${bearer(1)}`,
            "x-provider-id": users[0] ?? "",
          },
        })
      );

      const [createdAgain, deleted] = yield* fromTestPromise(() =>
        Promise.all([post(0), attemptedDeletion])
      );

      expect(createdAgain.status).toBe(201);
      expect(deleted.status).not.toBe(200);
      const preservedListResponse = yield* fromTestPromise(() => browse(0));

      const preserved = (yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => preservedListResponse.json())
      ).pipe(Effect.orDie)).data;

      expect(preserved).toContainEqual(protectedTransaction);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT count(*) AS count FROM source_attestations WHERE transaction_id=?",
            protectedTransaction.id
          )
        )
      ).toEqual([{ count: 1 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects forged browser origins and malformed Money before any public mutation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const post = (origin: string, data: object): Request =>
        new Request("https://api.fidyapp.com/transactions", {
          method: "POST",
          headers: {
            origin,
            "Fidy-Session-Binding": sessions[0] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(0)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(data),
        });

      expect(
        (yield* fromTestPromise(() => db.send(post("https://attacker.test", input())))).status
      ).toBe(403);
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            post("https://app.fidyapp.com", input({ money: { amount: "1e4", currency: "COP" } }))
          )
        )).status
      ).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT (SELECT count(*) FROM transactions) AS movements,(SELECT count(*) FROM source_attestations) AS sources,(SELECT count(*) FROM audit_entries WHERE record_type='session_call') AS audits"
          )
        )
      ).toEqual([{ movements: 0, sources: 0, audits: 1 }]);

      const created = yield* fromTestPromise(() =>
        db.send(post("https://app.fidyapp.com", input()))
      );

      expect(created.status).toBe(201);

      const transaction = (yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => created.json())
      ).pipe(Effect.orDie)).data;

      const browse = (index: number, path = "/transactions"): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com${path}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[index] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(index)}`,
            },
          })
        );

      const ownerBrowseResponse = yield* fromTestPromise(() => browse(0));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => ownerBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([transaction]);
      const neighborBrowseResponse = yield* fromTestPromise(() => browse(1));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => neighborBrowseResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() => browse(1, `/transactions/${transaction.id}`))).status
      ).toBe(404);

      const tokenOnly = yield* fromTestPromise(() =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );

      expect(tokenOnly.status).toBe(401);

      const foreignWithBearer = yield* fromTestPromise(() =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions/${transaction.id}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[1] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(1)}`,
              authorization: `Bearer ${bearer(0)}`,
              "x-provider-id": users[0] ?? "",
            },
          })
        )
      );

      expect(foreignWithBearer.status).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          browse(1, "/transactions/00000000-0000-4000-8000-000000000099")
        )).status
      ).toBe(404);
      expect((yield* fromTestPromise(() => browse(1, "/transactions/not-an-id"))).status).toBe(404);
      expect((yield* fromTestPromise(() => browse(0, "/transactions?unknown=1"))).status).toBe(400);

      const outcomes = yield* fromTestPromise(() =>
        db
          .owner(users[1] ?? "")
          .exec(
            "SELECT outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND operation = 'transactions.getTransaction'",
            users[1]
          )
      );

      expect(outcomes.map(({ outcome }) => outcome)).toEqual([
        "not_found",
        "not_found",
        "not_found",
      ]);

      const invalidAudit = yield* fromTestPromise(() =>
        db
          .exec(
            "SELECT outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND outcome = 'validation_failed'",
            users[0] ?? ""
          )
          .then((rows) => rows[0])
      );

      expect(invalidAudit?.outcome).toBe("validation_failed");
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("bounds requested history pages and keeps variable-size continuations User-owned", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      yield* Effect.forEach(
        [
          [users[0] ?? "", 1, 7],
          [users[1] ?? "", 8, 8],
        ] as const,
        Effect.fnUntraced(function* ([owner, start, end]) {
          yield* fromTestPromise(() =>
            db.owner(owner).exec(
              `WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n+1 FROM seq WHERE n<?)
          INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,occurred_at_ms,created_at_ms)
          SELECT printf('00000000-0000-4000-8100-%012d',n),?,'1','COP','outflow',?,1736424000000,1736424000000 FROM seq`,
              start,
              end,
              owner,
              category
            )
          );
        }),
        { discard: true }
      );

      const read = (query: string): Promise<Response> =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions?${query}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        );

      const Page = Schema.Struct({
        data: Schema.Array(Schema.Struct({ id: Transaction.fields.id })),
        next: Schema.Array(
          Schema.Struct({
            args: Schema.Struct({ query: Schema.Struct({ cursor: Schema.String }) }),
          })
        ),
      });

      const first = yield* fromTestPromise(() => read("limit=2"));
      expect(first.status).toBe(200);

      const page = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => first.json())
      ).pipe(Effect.orDie);

      expect(page.data).toHaveLength(2);
      const cursor = Option.getOrThrow(Option.fromUndefinedOr(page.next[0])).args.query.cursor;
      const second = yield* fromTestPromise(() => read(`cursor=${encodeURIComponent(cursor)}`));
      expect(second.status).toBe(200);

      const remainder = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      ).pipe(Effect.orDie);

      expect(remainder.data).toHaveLength(5);
      expect(remainder.next).toEqual([]);
      const ids = [...page.data, ...remainder.data].map((row) => row.id);
      expect(new Set(ids).size).toBe(7);
      expect(ids).not.toContain("00000000-0000-4000-8100-000000000008");

      yield* Effect.forEach(
        ["0", "101", "1.5", "invalid"],
        Effect.fnUntraced(function* (limit) {
          expect((yield* fromTestPromise(() => read(`limit=${limit}`))).status).toBe(400);
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("continues the canonical history beyond its first bounded page without losing tied movements", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const createdAt = DateTime.formatIso(DateTime.nowUnsafe());
      const previous = "2025-01-09T12:00:00.000Z";
      const period = "from=2025-01-01T00%3A00%3A00.000Z&to=2025-02-01T00%3A00%3A00.000Z";
      yield* fromTestPromise(() =>
        db.exec(
          `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 101)
    INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, notes, occurred_at_ms, created_at_ms)
    SELECT printf('00000000-0000-4000-8000-%012d', n), ?, '1', 'COP', 'outflow', ?, 'Pago literal',CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER),CAST(round(unixepoch(CASE WHEN n = 101 THEN ? ELSE ? END,'subsec')*1000) AS INTEGER) FROM seq`,
          users[0] ?? "",
          category,
          previous,
          previous,
          createdAt
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          `INSERT INTO transactions (id, user_id, amount, currency, direction, category_id, occurred_at_ms, created_at_ms)
    VALUES (?, ?, '1', 'COP', 'inflow', ?, 1704801600000,CAST(round(unixepoch(?,'subsec')*1000) AS INTEGER))`,
          "00000000-0000-4000-8000-000000000999",
          users[0] ?? "",
          category,
          previous
        )
      );

      const first = yield* fromTestPromise(() =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions?direction=outflow&${period}`, {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        )
      );

      expect(first.status).toBe(200);

      const Page = Schema.Struct({
        data: Schema.Array(Schema.toCodecJson(Transaction)),
        next: Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            hint: Schema.String,
            args: Schema.Struct({
              query: Schema.Struct({
                cursor: Schema.String,
                direction: Schema.String,
                from: Schema.String,
                to: Schema.String,
              }),
            }),
          })
        ),
      });

      const page = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => first.json())
      ).pipe(Effect.orDie);

      expect(page.data).toHaveLength(100);
      expect(page.next).toHaveLength(1);
      const continuation = Option.getOrThrow(Option.fromUndefinedOr(page.next[0]));
      expect(continuation.tool).toBe("transactions.listTransactions");
      const cursor = continuation.args.query.cursor;
      expect(continuation.args.query.direction).toBe("outflow");
      expect(continuation.args.query.from).toBe("2025-01-01T00:00:00.000Z");
      expect(continuation.args.query.to).toBe("2025-02-01T00:00:00.000Z");

      const second = yield* fromTestPromise(() =>
        db.send(
          new Request(
            `https://api.fidyapp.com/transactions?direction=outflow&${period}&cursor=${encodeURIComponent(cursor)}`,
            {
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": sessions[0] ?? "invalid",
                cookie: `__Host-fidy_session=${bearer(0)}`,
              },
            }
          )
        )
      );

      expect(second.status).toBe(200);

      const remainder = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      ).pipe(Effect.orDie);

      expect(remainder.data).toHaveLength(1);
      expect(remainder.next).toEqual([]);
      expect(new Set([...page.data, ...remainder.data].map(({ id }) => id)).size).toBe(101);

      const search = yield* fromTestPromise(() =>
        db.browser(0, "/transactions/search?q=Pago%20literal")
      );

      expect(search.status).toBe(200);

      const SearchPage = Schema.Struct({
        data: Schema.Array(Schema.toCodecJson(Transaction)),
        next: Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            args: Schema.Struct({
              query: Schema.Struct({ cursor: Schema.String, q: Schema.String }),
            }),
          })
        ),
      });

      const matches = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => search.json())
      );

      expect(matches.data).toHaveLength(100);
      expect(matches.next[0]?.tool).toBe("transactions.searchTransactions");
      expect(matches.next[0]?.args.query.q).toBe("Pago literal");

      const searchCursor = Option.getOrThrow(
        Option.fromUndefinedOr(matches.next[0]?.args.query.cursor)
      );

      const nextSearch = yield* fromTestPromise(() =>
        db.browser(
          0,
          `/transactions/search?q=Pago%20literal&cursor=${encodeURIComponent(searchCursor)}`
        )
      );

      const lastPage = yield* Schema.decodeUnknownEffect(SearchPage)(
        yield* fromTestPromise(() => nextSearch.json())
      );

      expect(lastPage.data).toHaveLength(1);
      expect(lastPage.next).toEqual([]);
      expect(new Set([...matches.data, ...lastPage.data].map(({ id }) => id)).size).toBe(101);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("commits exact manual Money, immutable capture context, and audit before canonical browsing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(postTransaction(0, input({ counterparty: "Acme" })))
      );

      expect(response.status).toBe(201);

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(encodeMoneyAmount(created.data.money.amount)).toBe("9007199254740993.15");
      expect(Option.getOrNull(created.data.counterparty)).toBe("Acme");
      const listed = yield* fromTestPromise(() => db.browser(0));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => listed.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([created.data]);

      const evidence = yield* fromTestPromise(() =>
        db.exec(
          "SELECT kind, service_market, locale, time_zone, interpretation_revision FROM source_attestations WHERE user_id = ?",
          users[0] ?? ""
        )
      );

      expect(evidence).toEqual([
        {
          kind: "manual",
          service_market: "CO",
          locale: "es-CO",
          time_zone: "America/Bogota",
          interpretation_revision: "manual-v1",
        },
      ]);

      const audit = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? ORDER BY operation",
          users[0] ?? ""
        )
      );

      expect(audit.map((row) => row.operation)).toEqual([
        "transactions.createTransaction",
        "transactions.listTransactions",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("neither a foreign opaque id nor another session can observe a Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request("https://api.fidyapp.com/transactions", {
              headers: { authorization: `Bearer ${bearer(0)}`, "x-provider-id": users[0] ?? "" },
            })
          )
        )).status
      ).toBe(401);

      const ownerLookupResponse = yield* fromTestPromise(() =>
        db.send(postTransaction(0, input()))
      );

      const created = yield* Schema.decodeUnknownEffect(Created)(
        yield* fromTestPromise(() => ownerLookupResponse.json())
      ).pipe(Effect.orDie);

      const foreignLookupResponse = yield* fromTestPromise(() => db.browser(1));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => foreignLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() => db.browser(1, `/transactions/${created.data.id}`))).status
      ).toBe(404);
      yield* fromTestPromise(() =>
        db.exec("UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?", 1, sessions[0] ?? "")
      );
      expect((yield* fromTestPromise(() => db.send(postTransaction(0, input())))).status).toBe(401);
      expect((yield* fromTestPromise(() => db.browser(0))).status).toBe(401);
      const otherSessionLookupResponse = yield* fromTestPromise(() => db.browser(1));
      expect(
        (yield* Schema.decodeUnknownEffect(Listed)(
          yield* fromTestPromise(() => otherSessionLookupResponse.json())
        ).pipe(Effect.orDie)).data
      ).toEqual([]);
      expect(
        (yield* fromTestPromise(() =>
          db.exec("SELECT COUNT(*) AS count FROM transactions").then((rows) => rows[0])
        ))?.count
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects an unknown Category without retaining partial Transaction, attestation, or audit state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      expect(
        (yield* fromTestPromise(() =>
          db.send(postTransaction(0, input({ categoryId: "10000000-0000-4000-8000-000000009999" })))
        )).status
      ).not.toBe(201);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT (SELECT count(*) FROM transactions) AS movements,(SELECT count(*) FROM source_attestations) AS sources,(SELECT count(*) FROM audit_entries WHERE record_type='session_call') AS audits"
          )
        )
      ).toEqual([{ movements: 0, sources: 0, audits: 1 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("commits an ordered two-child batch in one User transaction and agrees with immediate canonical reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Acme" })),
            transactionCall(
              2,
              input({
                counterparty: "Bravo",
                categoryId: "10000000-0000-4000-8000-000000000001",
              })
            ),
          ])
        )
      );

      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(body.data.results.map(({ callId }) => callId)).toEqual([
        batchCallId(1),
        batchCallId(2),
      ]);
      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "transactions.createTransaction",
      ]);
      const [first, second] = body.data.results.map(({ output }) => output.data);

      if (first === undefined || second === undefined) throw new Error("Missing results");
      expect(Option.getOrNull(first.counterparty)).toBe("Acme");
      expect(Option.getOrNull(second.counterparty)).toBe("Bravo");
      expect([first.revision, second.revision]).toEqual([0, 0]);
      const listed = yield* fromTestPromise(() => db.browser(0));

      const page = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => listed.json())
      ).pipe(Effect.orDie);

      expect(new Set(page.data.map(({ id }) => id))).toEqual(new Set([first.id, second.id]));
      expect(page.data.find(({ id }) => id === first.id)).toEqual(first);
      expect(page.data.find(({ id }) => id === second.id)).toEqual(second);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ? AND outcome = 'success' AND operation = 'transactions.createTransaction'",
            users[0] ?? ""
          )
        )
      ).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back an earlier child when a later child's revision is stale", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 1,
              changes: { notes: "late" },
            }),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transaction_corrections")
        )
      ).toBe(0);
      const audits = yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects a stale batch correction after a committed competing correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000002";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            batchRequest(0, [
              correctionCall(9, seededId, {
                expectedRevision: 0,
                changes: { notes: "concurrent" },
              }),
            ])
          )
        )).status
      ).toBe(200);

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "batch" },
            }),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM source_attestations")
        )
      ).toBe(0);

      const evidence = yield* fromTestPromise(() =>
        db.exec("SELECT corrected_at_ms FROM transaction_corrections")
      );

      expect(evidence).toHaveLength(1);
      const audits = yield* fromTestPromise(() => nativeRefusedChildren(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes a silently skipped child Audit without exposing database details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000003";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );
      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER refuse_batch_correction_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'transactions.updateTransaction' AND NEW.outcome = 'success'
            BEGIN SELECT RAISE(IGNORE); END`)
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, seededId, {
              expectedRevision: 0,
              changes: { notes: "refused audit" },
            }),
          ])
        )
      );

      expect(response.status).toBe(503);
      const body = yield* fromTestPromise(() => response.text());
      expect(body).not.toMatch(/SQL|INSERT|canonical_child_guard/iu);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT (SELECT count(*) FROM source_attestations) AS captured,(SELECT count(*) FROM transaction_corrections) AS corrected,(SELECT count(*) FROM keyword_rules) AS rules,(SELECT count(*) FROM audit_entries WHERE record_type='session_call') AS audits"
          )
        )
      ).toEqual([{ captured: 0, corrected: 0, rules: 0, audits: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("names the capture child when its success Audit is skipped and rolls back the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER skip_capture_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'transactions.createTransaction' AND NEW.outcome = 'success'
          BEGIN SELECT RAISE(IGNORE); END`)
      );

      const response = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [transactionCall(1, input())]))
      );

      expect(response.status).toBe(503);
      const body = yield* fromTestPromise(() => response.text());
      expect(body).not.toMatch(/SQL|INSERT|canonical_child_guard/iu);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT (SELECT count(*) FROM source_attestations) AS captured,(SELECT count(*) FROM transaction_corrections) AS corrected,(SELECT count(*) FROM keyword_rules) AS rules,(SELECT count(*) FROM audit_entries WHERE record_type='session_call') AS audits"
          )
        )
      ).toEqual([{ captured: 0, corrected: 0, rules: 0, audits: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("records a skipped keyword-rule guard as that child's refusal without committing earlier work", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER skip_rule_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'categories.createKeywordRule' AND NEW.outcome = 'success'
          BEGIN SELECT RAISE(IGNORE); END`)
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [transactionCall(1, input()), keywordRuleCall(2, "Panadería", category)])
        )
      );

      expect(response.status).toBe(503);
      const body = yield* fromTestPromise(() => response.text());
      expect(body).not.toMatch(/SQL|INSERT|canonical_child_guard/iu);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT (SELECT count(*) FROM source_attestations) AS captured,(SELECT count(*) FROM transaction_corrections) AS corrected,(SELECT count(*) FROM keyword_rules) AS rules,(SELECT count(*) FROM audit_entries WHERE record_type='session_call') AS audits"
          )
        )
      ).toEqual([{ captured: 0, corrected: 0, rules: 0, audits: 0 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("decides a normalized keyword duplicate from the snapshot before its sibling deletes the rule", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const initial = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [keywordRuleCall(1, "Panadería", category)]))
      );

      expect(initial.status).toBe(200);

      const original = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          data: Schema.Struct({
            results: Schema.Tuple([
              Schema.Struct({
                output: Schema.Struct({ data: Schema.Struct({ id: Schema.String }) }),
              }),
            ]),
          }),
        })
      )(yield* fromTestPromise(() => initial.json()));

      const id = original.data.results[0].output.data.id;

      const refused = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [deleteKeywordRuleCall(1, id), keywordRuleCall(2, "PANADERIA", category)])
        )
      );

      expect(refused.status).toBe(400);
      expect(yield* fromTestPromise(() => refused.json())).toMatchObject({
        error: { code: "validation_failed", failedCallIndex: 1 },
      });
      const rules = yield* fromTestPromise(() => db.browser(0, "/category-keyword-rules"));
      expect(yield* fromTestPromise(() => rules.json())).toMatchObject({
        data: [{ id, keyword: "panaderia" }],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("does not assign a child to a forged guard marker from an unrelated write", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      yield* fromTestPromise(() =>
        db.exec(`CREATE TRIGGER fake_guard BEFORE INSERT ON transactions
          BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: canonical_child_guard_0: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)'); END`)
      );

      const response = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [transactionCall(1, input())]))
      );

      expect(response.status).toBe(503);
      const body = yield* fromTestPromise(() => response.text());
      expect(body).not.toMatch(/failedCallIndex|canonical_child_guard|INSERT|transactions/iu);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back a batch containing deletion of an absent Transaction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            {
              callId: batchCallId(2),
              operation: "transactions.deleteTransaction",
              input: { params: { id: "30000000-0000-4000-8000-000000000009" } },
            },
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.deleteTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("links and unlinks pair children inside one atomic batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const visible = "30000000-0000-4000-8000-000000000901";
      const suppressed = "30000000-0000-4000-8000-000000000902";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: visible, categoryId: category }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: suppressed,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
        ]).then(() =>
          seedNativeSource({
            db,
            userId: owner,
            transactionId: suppressed,
            id: "30000000-0000-4000-8000-000000000903",
          })
        )
      );

      const linked = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [transactionCall(1, input()), linkCall(2, suppressed, visible)]))
      );

      expect(linked.status).toBe(200);

      const linkBody = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => linked.json())
      ).pipe(Effect.orDie);

      expect(linkBody.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "transactions.linkTransactions",
      ]);

      const effectiveTransaction = (yield* Schema.decodeUnknownEffect(EffectiveTransaction)(
        linkBody.data.results[1]?.output
      ).pipe(Effect.orDie)).data;

      expect(effectiveTransaction.id).toBe(visible);
      expect(effectiveTransaction.presentation).toEqual({ kind: "visible-member" });
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          { first: visible, second: suppressed, state: "linked", visible: Option.some(visible) },
        ],
        members: [{ transaction: visible }, { transaction: suppressed }],
      });

      const unlinked = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [unlinkCall(3, suppressed, visible)]))
      );

      expect(unlinked.status).toBe(200);

      const unlinkBody = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => unlinked.json())
      ).pipe(Effect.orDie);

      expect(unlinkBody.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.unlinkTransactions",
      ]);

      const restored = (yield* Schema.decodeUnknownEffect(RestoredPair)(
        unlinkBody.data.results[0]?.output
      ).pipe(Effect.orDie)).data;

      expect(restored.firstTransaction.id).toBe(visible);
      expect(restored.secondTransaction.id).toBe(suppressed);
      expect(restored.firstTransaction.presentation).toEqual({ kind: "independent" });
      expect(restored.secondTransaction.presentation).toEqual({ kind: "independent" });
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [
          {
            first: visible,
            second: suppressed,
            state: "keep-separate",
            visible: Option.none(),
          },
        ],
        members: [],
      });
      expect(
        (yield* fromTestPromise(() => nativeAuditedOperations(db, owner)))
          .map(({ operation, outcome }) => `${operation}:${outcome}`)
          .sort()
      ).toEqual([
        "operations.executeAtomicBatch:success",
        "operations.executeAtomicBatch:success",
        "transactions.createTransaction:success",
        "transactions.linkTransactions:success",
        "transactions.unlinkTransactions:success",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("aborts a batch link when a competing link commits before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000911";
      const second = "30000000-0000-4000-8000-000000000912";
      const third = "30000000-0000-4000-8000-000000000913";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: second, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: third, categoryId: category }),
        ])
      );
      expect(
        (yield* fromTestPromise(() => db.send(batchRequest(0, [linkCall(9, first, third)])))).status
      ).toBe(200);

      const response = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [linkCall(1, first, second)]))
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [{ first, second: third, state: "linked", visible: Option.some(first) }],
        members: [{ transaction: first }, { transaction: third }],
      });
      expect(yield* fromTestPromise(() => nativeRefusedChildren(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("aborts a batch link when a correction changes a member's Money before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000914";
      const second = "30000000-0000-4000-8000-000000000915";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: second, categoryId: category }),
        ])
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            batchRequest(0, [
              correctionCall(9, second, {
                expectedRevision: 0,
                changes: { money: { amount: "45000.01", currency: "COP" } },
              }),
            ])
          )
        )).status
      ).toBe(200);

      const response = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [linkCall(1, first, second)]))
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      expect(yield* fromTestPromise(() => nativeRefusedChildren(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes the earliest provable child when a pair premise and a revision both move", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000931";
      const second = "30000000-0000-4000-8000-000000000932";
      const third = "30000000-0000-4000-8000-000000000933";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: second, categoryId: category }),
          seedNativeTransaction({ db, userId: owner, id: third, categoryId: category }),
        ])
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            batchRequest(0, [
              linkCall(8, first, second),
              correctionCall(9, third, { expectedRevision: 0, changes: { notes: "concurrent" } }),
            ])
          )
        )).status
      ).toBe(200);

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            linkCall(1, first, second),
            correctionCall(2, third, { expectedRevision: 0, changes: { notes: "late" } }),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.linkTransactions");
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [{ first, second, state: "linked", visible: Option.some(first) }],
        members: [{ transaction: first }, { transaction: second }],
      });
      expect(yield* fromTestPromise(() => nativeRefusedChildren(db, owner))).toEqual([
        { operation: "transactions.linkTransactions", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("aborts a batch unlink when a competing unlink commits before the unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000921";
      const second = "30000000-0000-4000-8000-000000000922";
      yield* fromTestPromise(() =>
        Promise.all([
          seedNativeTransaction({ db, userId: owner, id: first, categoryId: category }),
          seedNativeTransaction({
            db,
            userId: owner,
            id: second,
            categoryId: category,
            occurredAt: "2025-01-06T12:00:00.000Z",
            createdAt: "2025-01-06T12:00:00.000Z",
          }),
        ])
      );
      expect(
        (yield* fromTestPromise(() => db.send(batchRequest(0, [linkCall(8, first, second)]))))
          .status
      ).toBe(200);
      expect(
        (yield* fromTestPromise(() => db.send(batchRequest(0, [unlinkCall(9, first, second)]))))
          .status
      ).toBe(200);

      const response = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [unlinkCall(1, second, first)]))
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(0);
      expect(rejection.error.operation).toBe("transactions.unlinkTransactions");
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [{ first, second, state: "keep-separate", visible: Option.none() }],
        members: [],
      });
      expect(yield* fromTestPromise(() => nativeRefusedChildren(db, owner))).toEqual([
        { operation: "transactions.unlinkTransactions", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("gives a stale correction the same refusal Audit alone and inside a batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const firstId = "30000000-0000-4000-8000-000000000004";
      const secondId = "30000000-0000-4000-8000-000000000005";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: firstId,
          categoryId: category,
        })
      );
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: secondId,
          categoryId: category,
        })
      );

      const individual = yield* fromTestPromise(() =>
        db.send(
          new Request(`https://api.fidyapp.com/transactions/${firstId}`, {
            method: "PUT",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ expectedRevision: 1, changes: { notes: "alone" } }),
          })
        )
      );

      expect(individual.status).toBe(400);

      const batch = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, secondId, { expectedRevision: 1, changes: { notes: "batched" } }),
          ])
        )
      );

      expect(batch.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(2);
      const audits = yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""));
      expect(audits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("raw PAT batches cannot turn query, recursive, browser-only or under-scoped children into authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"a".repeat(8)}_${"b".repeat(43)}`;
      yield* seedNativePAT({ db, userId: users[0] ?? "", token, scopes: ["write"], current });

      const children = [
        { operation: "categories.listCategories", input: {} },
        {
          operation: "operations.executeAtomicBatch",
          input: { payload: { calls: [transactionCall(3, input())] } },
        },
        { operation: "pats.inspectPATPairing", input: { payload: { publicCode: "ABCD-1234" } } },
        { operation: "dashboard.initializeDashboard", input: {} },
      ];

      yield* Effect.forEach(
        children,
        Effect.fnUntraced(function* (child) {
          const response = yield* fromTestPromise(() =>
            db.send(
              bearerRequest(0, token, [
                transactionCall(1, input()),
                { callId: batchCallId(2), ...child },
              ])
            )
          );

          expect(response.status).toBe(
            child.operation === "dashboard.initializeDashboard" ? 403 : 400
          );

          const pairingRefusal = fromTestPromise(() => response.clone().json());
          yield* Effect.gen(function* () {
            expect(yield* pairingRefusal).toMatchObject({
              error: {
                code: "scope_missing",
                failedCallIndex: 1,
                operation: "pats.inspectPATPairing",
              },
            });
          }).pipe(Effect.when(Effect.succeed(child.operation === "pats.inspectPATPairing")));

          const body = yield* fromTestPromise(() => response.text());
          expect(body).not.toContain("fin_");
          expect(
            yield* fromTestPromise(() =>
              nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
            )
          ).toBe(0);
          expect(
            yield* fromTestPromise(() =>
              nativeCountRows(
                db,
                "SELECT COUNT(*) AS count FROM (SELECT user_id,document_json,revision FROM user_documents WHERE kind='dashboard') AS dashboard_documents"
              )
            )
          ).toBe(0);
          expect(
            yield* fromTestPromise(() =>
              nativeCountRows(
                db,
                "SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='credential_call' AND outcome = 'accepted'"
              )
            )
          ).toBe(0);
          expect(
            yield* fromTestPromise(() => nativeCountRows(db, "SELECT COUNT(*) AS count FROM pats"))
          ).toBe(1);
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("enforces each child's live PAT scope and commits a mixed two-child batch under one PAT unit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000006";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"w".repeat(8)}_${"a".repeat(43)}`;
      const readToken = `fin_${"r".repeat(8)}_${"b".repeat(43)}`;
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token: writeToken,
        scopes: ["write"],
        current,
      });
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token: readToken,
        scopes: ["read"],
        current,
      });

      const refused = yield* fromTestPromise(() =>
        db.send(bearerRequest(0, readToken, [transactionCall(1, input())]))
      );

      expect(refused.status).toBe(403);

      const rejection = yield* Schema.decodeUnknownEffect(ScopeMissing)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("scope_missing");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='credential_call' AND outcome = 'accepted'"
          )
        )
      ).toBe(0);

      const committed = yield* fromTestPromise(() =>
        db.send(
          bearerRequest(0, writeToken, [
            transactionCall(1, input({ counterparty: "Agent capture" })),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "agent" } }),
          ])
        )
      );

      expect(committed.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(BatchResult)(
        yield* fromTestPromise(() => committed.json())
      ).pipe(Effect.orDie);

      expect(body.data.results).toHaveLength(2);

      const audits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation, outcome FROM audit_entries WHERE record_type='credential_call' AND operation LIKE 'transactions.%' ORDER BY operation,rowid"
        )
      );

      expect(audits).toEqual([
        { operation: "transactions.createTransaction", outcome: "rejected" },
        { operation: "transactions.createTransaction", outcome: "accepted" },
        { operation: "transactions.updateTransaction", outcome: "accepted" },
      ]);

      const activity = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ last_used_at_ms: Schema.Int })
      )(
        yield* fromTestPromise(() =>
          db
            .exec("SELECT last_used_at_ms FROM pats WHERE short_id = ?", writeToken.slice(4, 12))
            .then((rows) => rows[0])
        )
      ).pipe(Effect.orDie);

      expect(activity.last_used_at_ms).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("commits a mixed-owner canonical batch once with ordered correlated results and immediate reads", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Mixed owner" })),
            memoryCall(2, "Prefiere pagar en efectivo"),
            keywordRuleCall(3, "Panadería", category),
          ])
        )
      );

      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(body.data.results.map(({ callId, operation }) => [callId, operation])).toEqual([
        [batchCallId(1), "transactions.createTransaction"],
        [batchCallId(2), "memory.remember"],
        [batchCallId(3), "categories.createKeywordRule"],
      ]);
      const send = db.browser;

      const transactions = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(0, "/transactions").then((value) => value.json()))
      ).pipe(Effect.orDie);

      expect(transactions.data).toHaveLength(1);
      expect(Option.getOrNull(transactions.data[0]?.counterparty ?? Option.none())).toBe(
        "Mixed owner"
      );

      const memories = yield* Schema.decodeUnknownEffect(ListedMemories)(
        yield* fromTestPromise(() => send(0, "/memories").then((value) => value.json()))
      ).pipe(Effect.orDie);

      expect(memories.data.map(({ text }) => text)).toEqual(["Prefiere pagar en efectivo"]);

      const rules = yield* Schema.decodeUnknownEffect(ListedKeywordRules)(
        yield* fromTestPromise(() =>
          send(0, "/category-keyword-rules").then((value) => value.json())
        )
      ).pipe(Effect.orDie);

      expect(rules.data.map(({ keyword }) => keyword)).toEqual(["panaderia"]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*') AND user_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'memory.*' AND user_id = ? AND operation = 'memory.remember' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*' AND user_id = ? AND operation = 'categories.createKeywordRule'",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const neighborTransactions = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => send(1, "/transactions").then((value) => value.json()))
      ).pipe(Effect.orDie);

      expect(neighborTransactions.data).toEqual([]);

      const neighborMemories = yield* Schema.decodeUnknownEffect(ListedMemories)(
        yield* fromTestPromise(() => send(1, "/memories").then((value) => value.json()))
      ).pipe(Effect.orDie);

      expect(neighborMemories.data).toEqual([]);

      const neighborRules = yield* Schema.decodeUnknownEffect(ListedKeywordRules)(
        yield* fromTestPromise(() =>
          send(1, "/category-keyword-rules").then((value) => value.json())
        )
      ).pipe(Effect.orDie);

      expect(neighborRules.data).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes a duplicate keyword in one batch with the owner's declared conflict and refusal Audit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            keywordRuleCall(2, "Panadería", category),
            keywordRuleCall(3, "panaderia", category),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.failedCallIndex).toBe(2);
      expect(rejection.error.operation).toBe("categories.createKeywordRule");
      expect(rejection.error.code).toBe("validation_failed");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM keyword_rules")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT operation,outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*' AND user_id = ?",
            users[0] ?? ""
          )
        )
      ).toEqual([{ operation: "categories.createKeywordRule", outcome: "validation_failed" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rolls back every owner when a later mixed-owner keyword-rule child exceeds capacity", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        db.exec(
          `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 99)
            INSERT INTO keyword_rules (id, user_id, keyword,category_id,category_revision,created_at_ms,updated_at_ms)
            SELECT printf('90000000-0000-4000-8000-%012d', n), ?, 'seed ' || n, ?, 'co-1', ?, ? FROM seq`,
          users[0] ?? "",
          category,
          DateTime.toEpochMillis(DateTime.makeUnsafe(current)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(current))
        )
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            memoryCall(2, "Sobrevive al rollback"),
            keywordRuleCall(3, "Panadería", category),
            keywordRuleCall(4, "Cafetería", category),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(3);
      expect(rejection.error.operation).toBe("categories.createKeywordRule");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*')"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'memory.*'"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*'"
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes a cross-owner Memory conflict at commit time and keeps no earlier child state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const memoryId = "50000000-0000-4000-8000-000000000001";
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      yield* fromTestPromise(() =>
        db.exec(
          "INSERT INTO memories (id, user_id, text, created_at_ms, updated_at_ms) VALUES (?, ?, 'Original', ?, ?)",
          memoryId,
          users[0] ?? "",
          DateTime.makeUnsafe(current).epochMilliseconds,
          DateTime.makeUnsafe(current).epochMilliseconds
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          "CREATE TRIGGER drop_memory BEFORE INSERT ON transactions BEGIN DELETE FROM memories; END"
        )
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [transactionCall(1, input()), reviseMemoryCall(2, memoryId, "Revisado")])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("memory.revise");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*')"
          )
        )
      ).toBe(0);

      const audits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation, outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'memory.*' AND user_id = ? ORDER BY operation",
          users[0] ?? ""
        )
      );

      expect(audits).toEqual([{ operation: "memory.revise", outcome: "not_found" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("executes a mixed-owner batch under one write PAT and refuses a read PAT without writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"m".repeat(8)}_${"c".repeat(43)}`;
      const readToken = `fin_${"n".repeat(8)}_${"d".repeat(43)}`;
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token: writeToken,
        scopes: ["write"],
        current,
      });
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token: readToken,
        scopes: ["read"],
        current,
      });

      const refused = yield* fromTestPromise(() =>
        db.send(
          bearerRequest(0, readToken, [
            memoryCall(1, "Memoria"),
            keywordRuleCall(2, "Panadería", category),
          ])
        )
      );

      expect(refused.status).toBe(403);

      const rejection = yield* Schema.decodeUnknownEffect(ScopeMissing)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("scope_missing");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted'"
          )
        )
      ).toBe(0);

      const committed = yield* fromTestPromise(() =>
        db.send(
          bearerRequest(0, writeToken, [
            transactionCall(1, input({ counterparty: "Mixed agent" })),
            memoryCall(2, "Prefiere pagar en efectivo"),
            keywordRuleCall(3, "Panadería", category),
          ])
        )
      );

      expect(committed.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => committed.json())
      ).pipe(Effect.orDie);

      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "transactions.createTransaction",
        "memory.remember",
        "categories.createKeywordRule",
      ]);

      const audits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation, outcome FROM (SELECT id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='credential_call') AS pat_audit WHERE outcome = 'accepted' ORDER BY operation"
        )
      );

      expect(audits).toEqual([
        { operation: "categories.createKeywordRule", outcome: "accepted" },
        { operation: "memory.remember", outcome: "accepted" },
        { operation: "operations.executeAtomicBatch", outcome: "accepted" },
        { operation: "transactions.createTransaction", outcome: "accepted" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("rejects a duplicate call identity named across owners before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(6, input()),
            keywordRuleCall(6, "identidad repetida", category),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("categories.createKeywordRule");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*')"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses two children addressing one retained rule or Memory before any child commits", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      const ruleId = "70000000-0000-4000-8000-000000000001";
      const memoryId = "70000000-0000-4000-8000-000000000002";
      yield* fromTestPromise(() =>
        db.exec(
          `INSERT INTO keyword_rules (id, user_id, keyword,category_id,category_revision,created_at_ms,updated_at_ms)
            VALUES (?, ?, 'original', ?, 'co-1', ?, ?)`,
          ruleId,
          users[0] ?? "",
          category,
          DateTime.toEpochMillis(DateTime.makeUnsafe(current)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(current))
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          "INSERT INTO memories (id, user_id, text, created_at_ms, updated_at_ms) VALUES (?, ?, 'Repetida', ?, ?)",
          memoryId,
          users[0] ?? "",
          DateTime.makeUnsafe(current).epochMilliseconds,
          DateTime.makeUnsafe(current).epochMilliseconds
        )
      );

      const repeatedRule = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            updateKeywordRuleCall(1, ruleId, { keyword: "Una", categoryId: category }),
            deleteKeywordRuleCall(2, ruleId),
          ])
        )
      );

      expect(repeatedRule.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => repeatedRule.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("categories.deleteKeywordRule");

      const repeatedMemory = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            reviseMemoryCall(1, memoryId, "Corregida"),
            forgetMemoryCall(2, memoryId),
          ])
        )
      );

      expect(repeatedMemory.status).toBe(400);

      const rule = yield* fromTestPromise(() =>
        db.exec("SELECT keyword FROM keyword_rules WHERE id = ?", ruleId).then((rows) => rows[0])
      );

      expect(rule).toEqual({ keyword: "original" });

      const memory = yield* fromTestPromise(() =>
        db.exec("SELECT text FROM memories WHERE id = ?", memoryId).then((rows) => rows[0])
      );

      expect(memory).toEqual({ text: "Repetida" });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE outcome='success' AND operation GLOB 'categories.*'"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE outcome='success' AND operation GLOB 'memory.*'"
          )
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("commits retained keyword-rule updates and deletes and Memory forgets in one mixed-owner batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = DateTime.formatIso(DateTime.nowUnsafe());
      const updatedRuleId = "60000000-0000-4000-8000-000000000001";
      const deletedRuleId = "60000000-0000-4000-8000-000000000002";
      const forgottenMemoryId = "60000000-0000-4000-8000-000000000003";
      yield* fromTestPromise(() =>
        db.exec(
          `INSERT INTO keyword_rules (id, user_id, keyword,category_id,category_revision,created_at_ms,updated_at_ms)
            VALUES (?, ?, 'antes', ?, 'co-1', ?, ?), (?, ?, 'borrar', ?, 'co-1', ?, ?)`,
          updatedRuleId,
          users[0] ?? "",
          category,
          DateTime.toEpochMillis(DateTime.makeUnsafe(current)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(current)),
          deletedRuleId,
          users[0] ?? "",
          category,
          DateTime.toEpochMillis(DateTime.makeUnsafe(current)),
          DateTime.toEpochMillis(DateTime.makeUnsafe(current))
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          "INSERT INTO memories (id, user_id, text, created_at_ms, updated_at_ms) VALUES (?, ?, 'Olvidar', ?, ?)",
          forgottenMemoryId,
          users[0] ?? "",
          DateTime.makeUnsafe(current).epochMilliseconds,
          DateTime.makeUnsafe(current).epochMilliseconds
        )
      );

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            updateKeywordRuleCall(1, updatedRuleId, { keyword: "Después", categoryId: category }),
            deleteKeywordRuleCall(2, deletedRuleId),
            forgetMemoryCall(3, forgottenMemoryId),
            transactionCall(4, input({ counterparty: "Mixed retained" })),
          ])
        )
      );

      expect(response.status).toBe(200);

      const body = yield* Schema.decodeUnknownEffect(BatchEnvelope)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(body.data.results.map(({ operation }) => operation)).toEqual([
        "categories.updateKeywordRule",
        "categories.deleteKeywordRule",
        "memory.forget",
        "transactions.createTransaction",
      ]);

      const rules = yield* fromTestPromise(() =>
        db.exec(
          "SELECT id, keyword FROM keyword_rules WHERE user_id = ? ORDER BY id",
          users[0] ?? ""
        )
      );

      expect(rules).toEqual([{ id: updatedRuleId, keyword: "despues" }]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM memories WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);

      const categoryAudits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*' AND user_id = ? ORDER BY operation",
          users[0] ?? ""
        )
      );

      expect(categoryAudits).toEqual([
        { operation: "categories.deleteKeywordRule" },
        { operation: "categories.updateKeywordRule" },
      ]);

      const memoryAudits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation, outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'memory.*' AND user_id = ? ORDER BY operation",
          users[0] ?? ""
        )
      );

      expect(memoryAudits).toEqual([{ operation: "memory.forget", outcome: "success" }]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*') AND user_id = ? AND operation = 'transactions.createTransaction' AND outcome = 'success'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("serializes concurrent batches and individual mutations through one User coordination turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const individual = (index: number): Promise<Response> =>
        db.send(
          new Request("https://api.fidyapp.com/transactions", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[index] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(index)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input({ counterparty: "Single" })),
          })
        );

      const batch = (index: number, suffix: number): Promise<Response> =>
        db.send(
          batchRequest(index, [
            transactionCall(suffix, input({ counterparty: `Batch ${suffix}` })),
            transactionCall(suffix + 1, input({ counterparty: `Batch ${suffix + 1}` })),
          ])
        );

      const responses = yield* Effect.all(
        [
          fromTestPromise(() => individual(0)),
          fromTestPromise(() => batch(0, 10)),
          fromTestPromise(() => batch(0, 20)),
          fromTestPromise(() => individual(1)),
        ],
        { concurrency: 2 }
      );

      expect(responses.map(({ status }) => status)).toEqual([201, 200, 200, 201]);

      const ownerList = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
            },
          })
        )
      );

      const owner = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => ownerList.json())
      ).pipe(Effect.orDie);

      expect(owner.data).toHaveLength(5);
      expect(new Set(owner.data.map(({ id }) => id)).size).toBe(5);

      const neighborList = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/transactions", {
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[1] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(1)}`,
            },
          })
        )
      );

      const neighbor = yield* Schema.decodeUnknownEffect(Listed)(
        yield* fromTestPromise(() => neighborList.json())
      ).pipe(Effect.orDie);

      expect(neighbor.data).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes keyword capacity after a deletion and earlier creates without recount guessing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      yield* fromTestPromise(() =>
        db.exec(
          `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n < 98)
      INSERT INTO keyword_rules (id, user_id, keyword,category_id,category_revision,created_at_ms,updated_at_ms)
      SELECT printf('40000000-0000-4000-8000-%012d', n), ?, 'seed ' || n, ?, 'co-1',
      1788220800000, 1788220800000 FROM seq`,
          users[0] ?? "",
          category
        )
      );

      const refused = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            deleteKeywordRuleCall(1, "40000000-0000-4000-8000-000000000000"),
            keywordRuleCall(2, "one new", category),
            keywordRuleCall(3, "two new", category),
            keywordRuleCall(4, "three new", category),
          ])
        )
      );

      expect(refused.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.failedCallIndex).toBe(3);
      expect(rejection.error.operation).toBe("categories.createKeywordRule");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM keyword_rules WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(99);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'categories.*' AND user_id = ? AND outcome = 'validation_failed'",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("a PAT cannot read or correct another User's Transaction individually or after an earlier batch child", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"a".repeat(8)}_${"b".repeat(43)}`;
      const neighborId = "30000000-0000-4000-8000-000000000007";
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token,
        scopes: ["read", "write"],
        current,
      });
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[1] ?? "",
          id: neighborId,
          categoryId: category,
        })
      );

      yield* Effect.forEach(
        ["GET", "PUT"] as const,
        Effect.fnUntraced(function* (method) {
          const response = yield* fromTestPromise(() =>
            db.send(
              new Request(`https://api.fidyapp.com/transactions/${neighborId}`, {
                method,
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body:
                  method === "GET"
                    ? undefined
                    : JSON.stringify({
                        expectedRevision: 0,
                        changes: { notes: "foreign correction" },
                      }),
              })
            )
          );

          expect(response.status).toBe(404);
          expect(yield* fromTestPromise(() => response.text())).not.toContain("seed");
        }),
        { discard: true }
      );

      const batch = yield* fromTestPromise(() =>
        db.send(
          bearerRequest(0, token, [
            transactionCall(1, input()),
            correctionCall(2, neighborId, {
              expectedRevision: 0,
              changes: { notes: "foreign correction" },
            }),
          ])
        )
      );

      expect(batch.status).toBe(400);
      expect(
        (yield* Schema.decodeUnknownEffect(BatchRejection)(
          yield* fromTestPromise(() => batch.json())
        )).error
      ).toMatchObject({ code: "not_found", failedCallIndex: 1 });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          db
            .owner(users[1] ?? "")
            .exec("SELECT notes, revision FROM transactions WHERE user_id=?", users[1] ?? "")
        )
      ).toEqual([{ notes: "seed", revision: 0 }]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM audit_entries WHERE record_type='credential_call' AND outcome = 'accepted' AND operation != 'transactions.getTransaction'"
          )
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("fails closed on a foreign Transaction or an unknown Category without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const neighborId = "30000000-0000-4000-8000-000000000007";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[1] ?? "",
          id: neighborId,
          categoryId: category,
        })
      );

      const foreign = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            correctionCall(2, neighborId, { expectedRevision: 0, changes: { notes: "foreign" } }),
          ])
        )
      );

      expect(foreign.status).toBe(400);

      const foreignRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => foreign.json())
      ).pipe(Effect.orDie);

      expect(foreignRejection.error.code).toBe("not_found");
      expect(foreignRejection.error.failedCallIndex).toBe(1);
      expect(foreignRejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);

      const neighborRows = yield* fromTestPromise(() =>
        db
          .owner(users[1] ?? "")
          .exec("SELECT notes, revision FROM transactions WHERE user_id = ?", users[1] ?? "")
      );

      expect(neighborRows).toEqual([{ notes: "seed", revision: 0 }]);

      const unrecognized = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input()),
            transactionCall(2, input({ categoryId: "10000000-0000-4000-8000-000000009999" })),
          ])
        )
      );

      expect(unrecognized.status).toBe(400);

      const unrecognizedRejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => unrecognized.json())
      ).pipe(Effect.orDie);

      expect(unrecognizedRejection.error.code).toBe("not_found");
      expect(unrecognizedRejection.error.failedCallIndex).toBe(1);
      expect(unrecognizedRejection.error.operation).toBe("transactions.createTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);
      const refusals = yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""));
      expect(refusals).toEqual([
        { operation: "transactions.updateTransaction", outcome: "not_found" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
        { operation: "transactions.createTransaction", outcome: "not_found" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("records a PAT refusal Audit for a refused batch child without partial writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000008";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );
      const current = yield* Clock.currentTimeMillis;
      const writeToken = `fin_${"t".repeat(8)}_${"c".repeat(43)}`;
      yield* seedNativePAT({
        db,
        userId: users[0] ?? "",
        token: writeToken,
        scopes: ["write"],
        current,
      });

      const refused = yield* fromTestPromise(() =>
        db.send(
          bearerRequest(0, writeToken, [
            transactionCall(1, input()),
            correctionCall(2, seededId, { expectedRevision: 9, changes: { notes: "stale" } }),
          ])
        )
      );

      expect(refused.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => refused.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");

      const refusals = yield* fromTestPromise(() =>
        db.exec(
          "SELECT operation,outcome FROM audit_entries WHERE record_type='credential_call' ORDER BY rowid"
        )
      );

      expect(refusals).toEqual([
        { operation: "transactions.updateTransaction", outcome: "rejected" },
        { operation: "operations.executeAtomicBatch", outcome: "rejected" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses a batch under a revoked session, revoked PAT, or withdrawn Consent without writes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"v".repeat(8)}_${"e".repeat(43)}`;
      yield* seedNativePAT({ db, userId: users[0] ?? "", token, scopes: ["write"], current });
      yield* fromTestPromise(() =>
        db.exec(
          "UPDATE web_sessions SET revoked_at_ms = ? WHERE id = ?",
          current,
          sessions[0] ?? ""
        )
      );

      const revokedSession = yield* fromTestPromise(() =>
        db.send(batchRequest(0, [transactionCall(1, input())]))
      );

      expect(revokedSession.status).toBe(401);
      yield* fromTestPromise(() =>
        db.exec("UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?", current, token.slice(4, 12))
      );

      const revokedPAT = yield* fromTestPromise(() =>
        db.send(bearerRequest(0, token, [transactionCall(1, input())]))
      );

      expect(revokedPAT.status).toBe(401);

      const neighborToken = `fin_${"w".repeat(8)}_${"f".repeat(43)}`;
      yield* seedNativePAT({
        db,
        userId: users[1] ?? "",
        token: neighborToken,
        scopes: ["write"],
        current,
      });
      const grantId = "50000000-0000-4000-8000-000000000001";
      yield* fromTestPromise(() =>
        db
          .owner(users[1] ?? "")
          .exec(
            `INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,'{}','disclosure','decision',?,?)`,
            grantId,
            users[1] ?? "",
            current,
            current
          )
      );
      yield* fromTestPromise(() =>
        db
          .owner(users[1] ?? "")
          .exec(
            `INSERT INTO consent_history(record_type,id,user_id,grant_record_id,session_id,occurred_at_ms) VALUES ('processing_withdrawal',?,?,?,?,?)`,
            "50000000-0000-4000-8000-000000000002",
            users[1] ?? "",
            grantId,
            sessions[1] ?? "",
            current
          )
      );

      const withdrawn = yield* fromTestPromise(() =>
        db.send(bearerRequest(1, neighborToken, [transactionCall(1, input())]))
      );

      expect(withdrawn.status).toBe(403);

      const withdrawal = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => withdrawn.json())
      ).pipe(Effect.orDie);

      expect(withdrawal.error.code).toBe("user_action_required");

      const neighborSession = yield* fromTestPromise(() =>
        db.send(batchRequest(1, [transactionCall(1, input())]))
      );

      expect(neighborSession.status).toBe(401);

      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes a malformed child to its index and Audit while an unshaped body stays unattributed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const malformed = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                {
                  callId: "not-a-uuid",
                  operation: "transactions.createTransaction",
                  input: { payload: {} },
                },
              ],
            }),
          })
        )
      );

      expect(malformed.status).toBe(400);

      const childFailure = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => malformed.json())
      ).pipe(Effect.orDie);

      expect(childFailure.error.code).toBe("validation_failed");
      expect(childFailure.error.failedCallIndex).toBe(0);
      expect(childFailure.error.operation).toBe("transactions.createTransaction");
      const refusals = yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""));
      expect(refusals).toEqual([
        { operation: "transactions.createTransaction", outcome: "validation_failed" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);

      const unformatted = yield* fromTestPromise(() => db.send(batchRequest(0, [])));
      expect(unformatted.status).toBe(400);

      const unformattedFailure = yield* Schema.decodeUnknownEffect(CallerFailure)(
        yield* fromTestPromise(() => unformatted.json())
      ).pipe(Effect.orDie);

      expect(unformattedFailure.error.code).toBe("validation_failed");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(2);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""))).toEqual([
        { operation: "transactions.createTransaction", outcome: "validation_failed" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("records one metadata-only refusal for each malformed batch envelope", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const rawBatch = (body: object): Request =>
        new Request("https://api.fidyapp.com/operations/atomic-batch", {
          method: "POST",
          headers: {
            origin: "https://app.fidyapp.com",
            "Fidy-Session-Binding": sessions[0] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(0)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const bodies = [
        {},
        { calls: [] },
        { calls: Array.from({ length: 13 }, (_, index) => transactionCall(index + 1, input())) },
        {
          calls: [
            {
              callId: batchCallId(1),
              operation: "not.canonical",
              input: { secret: "never-persist" },
            },
          ],
        },
      ];

      yield* Effect.forEach(
        bodies,
        Effect.fnUntraced(function* (body) {
          yield* Effect.sleep("100 millis");
          const response = yield* fromTestPromise(() => db.send(rawBatch(body)));
          expect(response.status, `envelope ${bodies.indexOf(body)}`).toBe(400);

          const failure = yield* Schema.decodeUnknownEffect(CallerFailure)(
            yield* fromTestPromise(() => response.json())
          ).pipe(Effect.orDie);

          expect(failure.error.code).toBe("validation_failed");
        }),
        { discard: true }
      );

      const audits = yield* fromTestPromise(() =>
        db.exec(
          "SELECT user_id, session_id, operation, outcome FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch') AND user_id = ?",
          users[0] ?? ""
        )
      );

      expect(audits).toHaveLength(bodies.length);
      expect(
        audits.map((row) => ({
          user_id: row.user_id,
          session_id: row.session_id,
          operation: row.operation,
          outcome: row.outcome,
        }))
      ).toEqual(
        Array.from({ length: bodies.length }, () => ({
          user_id: users[0],
          session_id: sessions[0],
          operation: "operations.executeAtomicBatch",
          outcome: "validation_failed",
        }))
      );
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'transactions.*'"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("does not misattribute a repeated callId with a malformed later operation to the envelope", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const first = transactionCall(1, input());

      const response = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [first, { callId: first.callId, operation: "not.canonical", input: {} }],
            }),
          })
        )
      );

      expect(response.status).toBe(400);

      const later = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [first, { callId: batchCallId(2), operation: "not.canonical", input: {} }],
            }),
          })
        )
      );

      expect(later.status).toBe(400);

      const unsupportedFirst = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                { callId: batchCallId(3), operation: "transactions.listTransactions", input: {} },
                { callId: batchCallId(4), operation: "not.canonical", input: {} },
              ],
            }),
          })
        )
      );

      expect(unsupportedFirst.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call' AND outcome='success') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("records an envelope when a non-canonical first child prevents a later child from being admitted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              origin: "https://app.fidyapp.com",
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              calls: [
                { callId: batchCallId(1), operation: "not.canonical", input: {} },
                transactionCall(2, input()),
              ],
            }),
          })
        )
      );

      expect(response.status).toBe(400);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""))).toEqual([
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("records a batch envelope for a PAT without the child's scope, but never for dead credentials", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const current = yield* Clock.currentTimeMillis;
      const token = `fin_${"q".repeat(8)}_${"z".repeat(43)}`;
      yield* seedNativePAT({ db, userId: users[0] ?? "", token, scopes: ["read"], current });
      const envelope = yield* fromTestPromise(() => db.send(bearerRequest(0, token, [])));
      expect(envelope.status).toBe(400);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT operation,outcome FROM audit_entries WHERE record_type='credential_call' ORDER BY rowid"
          )
        )
      ).toEqual([{ operation: "operations.executeAtomicBatch", outcome: "rejected" }]);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT count(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE operation GLOB 'transactions.*'"
          )
        )
      ).toBe(0);

      const child = yield* fromTestPromise(() =>
        db.send(bearerRequest(0, token, [transactionCall(1, input())]))
      );

      expect(child.status).toBe(403);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT operation,outcome FROM audit_entries WHERE record_type='credential_call' ORDER BY rowid"
          )
        )
      ).toHaveLength(3);
      yield* fromTestPromise(() =>
        db.exec("UPDATE pats SET revoked_at_ms = ? WHERE short_id = ?", current, token.slice(4, 12))
      );
      expect((yield* fromTestPromise(() => db.send(bearerRequest(0, token, [])))).status).toBe(401);
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request("https://api.fidyapp.com/operations/atomic-batch", {
              method: "POST",
              headers: { origin: "https://app.fidyapp.com", "content-type": "application/json" },
              body: JSON.stringify({ calls: [] }),
            })
          )
        )).status
      ).toBe(401);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT operation,outcome FROM audit_entries WHERE record_type='credential_call' ORDER BY rowid"
          )
        )
      ).toHaveLength(3);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM (SELECT id,user_id,session_id,operation,outcome,occurred_at_ms FROM audit_entries WHERE record_type='session_call') AS session_audit WHERE (operation GLOB 'transactions.*' OR operation = 'operations.executeAtomicBatch')"
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT COUNT(*) AS count FROM transactions")
        )
      ).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it.each([
  {
    name: "malformed Transaction identity",
    path: "/transactions/not-a-transaction-id",
    payload: { expectedRevision: 0, changes: { notes: "correction" } },
    call: correctionCall(1, "not-a-transaction-id", {
      expectedRevision: 0,
      changes: { notes: "correction" },
    }),
  },
  {
    name: "missing Transaction identity",
    path: "/transactions/30000000-0000-4000-8000-000000000099",
    payload: { expectedRevision: 0, changes: { notes: "correction" } },
    call: correctionCall(1, "30000000-0000-4000-8000-000000000099", {
      expectedRevision: 0,
      changes: { notes: "correction" },
    }),
  },
])(
  "answers a $name with the same refusal and Audit in both public forms",
  ({ path, payload, call }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;

        const individual = yield* fromTestPromise(() =>
          db.send(
            new Request(`https://api.fidyapp.com${path}`, {
              method: "PUT",
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": sessions[0] ?? "invalid",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(payload),
            })
          )
        );

        expect(individual.status).toBe(404);

        const individualFailure = yield* Schema.decodeUnknownEffect(CallerFailure)(
          yield* fromTestPromise(() => individual.json())
        ).pipe(Effect.orDie);

        expect(individualFailure.error.code).toBe("not_found");

        const individualAudit = yield* fromTestPromise(() =>
          nativeAuditedOperations(db, users[0] ?? "")
        );

        expect(individualAudit).toEqual([{ operation: call.operation, outcome: "not_found" }]);

        const batch = yield* fromTestPromise(() => db.send(batchRequest(0, [call])));
        expect(batch.status).toBe(400);

        const refusal = yield* Schema.decodeUnknownEffect(BatchRejection)(
          yield* fromTestPromise(() => batch.json())
        ).pipe(Effect.orDie);

        expect(refusal.error.code).toBe(individualFailure.error.code);
        expect(refusal.error.failedCallIndex).toBe(0);
        expect(refusal.error.operation).toBe(call.operation);
        expect(yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""))).toEqual(
          [
            ...individualAudit,
            { operation: call.operation, outcome: individualFailure.error.code },
          ].concat(
            path.includes("not-a-")
              ? []
              : [{ operation: "operations.executeAtomicBatch", outcome: "validation_failed" }]
          )
        );
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
    )
);

it("answers an unstable retained id the same in a batch child as on its individual route", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const response = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            transactionCall(1, input({ counterparty: "Acme" })),
            correctionCall(2, "not-a-transaction-id", {
              expectedRevision: 0,
              changes: { notes: "batch" },
            }),
          ])
        )
      );

      expect(response.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("not_found");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
            users[0] ?? ""
          )
        )
      ).toBe(0);

      const refusedAudits = yield* fromTestPromise(() =>
        nativeAuditedOperations(db, users[0] ?? "")
      );

      expect(refusedAudits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "not_found" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("attributes a repeated observed revision to the later correction without partial state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000009";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          db,
          notes: "seed",
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );

      const repeated = yield* fromTestPromise(() =>
        db.send(
          batchRequest(0, [
            correctionCall(1, seededId, { expectedRevision: 0, changes: { notes: "first" } }),
            correctionCall(2, seededId, { expectedRevision: 0, changes: { notes: "second" } }),
          ])
        )
      );

      expect(repeated.status).toBe(400);

      const rejection = yield* Schema.decodeUnknownEffect(BatchRejection)(
        yield* fromTestPromise(() => repeated.json())
      ).pipe(Effect.orDie);

      expect(rejection.error.code).toBe("validation_failed");
      expect(rejection.error.failedCallIndex).toBe(1);
      expect(rejection.error.operation).toBe("transactions.updateTransaction");

      const retained = yield* fromTestPromise(() =>
        db.exec(
          "SELECT notes, revision FROM transactions WHERE user_id = ? AND id = ?",
          users[0] ?? "",
          seededId
        )
      );

      expect(retained).toEqual([{ notes: "seed", revision: 0 }]);

      const refusedAudits = yield* fromTestPromise(() =>
        nativeAuditedOperations(db, users[0] ?? "")
      );

      expect(refusedAudits).toEqual([
        { operation: "transactions.updateTransaction", outcome: "validation_failed" },
        { operation: "operations.executeAtomicBatch", outcome: "validation_failed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("does not misattribute an unrelated earlier abort to a repeated-revision correction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const seededId = "30000000-0000-4000-8000-000000000009";
      yield* fromTestPromise(() =>
        seedNativeTransaction({
          notes: "seed",
          db,
          userId: users[0] ?? "",
          id: seededId,
          categoryId: category,
        })
      );

      const first = correctionCall(1, seededId, {
        expectedRevision: 0,
        changes: { notes: "first" },
      });

      const repeated = correctionCall(2, seededId, {
        expectedRevision: 0,
        changes: { notes: "second" },
      });

      yield* fromTestPromise(() =>
        db.exec(
          "CREATE TRIGGER fail_initial_admission BEFORE INSERT ON canonical_request_buckets BEGIN SELECT RAISE(ABORT,'fixture admission unavailable'); END"
        )
      );
      expect(
        (yield* fromTestPromise(() => db.send(batchRequest(0, [first, repeated])))).status
      ).toBe(503);
      yield* fromTestPromise(() => db.exec("DROP TRIGGER fail_initial_admission"));
      yield* fromTestPromise(() =>
        db.exec(
          `CREATE TRIGGER unrelated_correction_abort BEFORE UPDATE ON transactions WHEN NEW.notes='first' BEGIN SELECT RAISE(ABORT,'unrelated failure'); END`
        )
      );
      expect(
        (yield* fromTestPromise(() =>
          db.send(batchRequest(0, [first, transactionCall(2, input())]))
        )).status
      ).toBe(503);
      expect(
        yield* fromTestPromise(() =>
          db.exec(
            "SELECT notes,revision FROM transactions WHERE user_id=? AND id=?",
            users[0] ?? "",
            seededId
          )
        )
      ).toEqual([{ notes: "seed", revision: 0 }]);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("refuses a cookie-admitted batch without the browser origin and writes nothing", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      const refused = yield* fromTestPromise(() =>
        db.send(
          new Request("https://api.fidyapp.com/operations/atomic-batch", {
            method: "POST",
            headers: {
              "Fidy-Session-Binding": sessions[0] ?? "invalid",
              cookie: `__Host-fidy_session=${bearer(0)}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ calls: [transactionCall(1, input())] }),
          })
        )
      );

      expect(refused.status).toBe(403);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(db, "SELECT count(*) AS count FROM transactions")
        )
      ).toBe(0);
      expect(yield* fromTestPromise(() => nativeAuditedOperations(db, users[0] ?? ""))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("permanently deletes visible history with provenance retained and rejects another User", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const id = "30000000-0000-4000-8000-000000000991";
      const owner = users[0] ?? "";
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, userId: owner, id, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedNativeSource({
          db,
          userId: owner,
          transactionId: id,
          id: "30000000-0000-4000-8000-000000000992",
        })
      );

      const deletion = (index: number): Request =>
        new Request(request(index, `/transactions/${id}`), {
          method: "DELETE",
          headers: {
            "Fidy-Session-Binding": sessions[index] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(index)}`,
            origin: "https://app.fidyapp.com",
          },
        });

      expect((yield* fromTestPromise(() => db.send(deletion(1)))).status).toBe(404);
      expect((yield* fromTestPromise(() => db.send(deletion(0)))).status).toBe(200);
      expect(
        (yield* fromTestPromise(() =>
          db.send(
            new Request(request(0, `/transactions/${id}`), {
              headers: {
                "Fidy-Session-Binding": sessions[0] ?? "invalid",
                cookie: `__Host-fidy_session=${bearer(0)}`,
                origin: "https://app.fidyapp.com",
              },
            })
          )
        )).status
      ).toBe(404);
      expect((yield* fromTestPromise(() => db.send(deletion(0)))).status).toBe(404);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM source_attestations WHERE user_id=?",
            owner
          )
        )
      ).toBe(1);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_effective_source WHERE user_id=?",
            owner
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_projection_leaf WHERE user_id=?",
            owner
          )
        )
      ).toBe(0);
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM audit_entries WHERE user_id=? AND record_type='session_call' AND operation='transactions.deleteTransaction' AND outcome='success'",
            owner
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it.each(["linked", "audit-outage", "read-only", "revoked"] as const)(
  "does not delete a Transaction when %s refuses the write",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* nativeTransactionJourney;
        const owner = users[0] ?? "";
        const id = "30000000-0000-4000-8000-000000000993";
        yield* fromTestPromise(() =>
          seedNativeTransaction({ db, userId: owner, id, categoryId: category })
        );

        let deletion = new Request(request(0, `/transactions/${id}`), {
          method: "DELETE",
          headers: {
            "Fidy-Session-Binding": sessions[0] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(0)}`,
            origin: "https://app.fidyapp.com",
          },
        });

        if (failure === "linked") {
          const second = "30000000-0000-4000-8000-000000000994";
          yield* fromTestPromise(() =>
            seedNativeTransaction({ db, userId: owner, id: second, categoryId: category })
          );
          yield* fromTestPromise(() =>
            db.send(
              new Request(
                request(0, "/transactions/link", {
                  firstTransactionId: id,
                  secondTransactionId: second,
                }),
                {
                  headers: {
                    "Fidy-Session-Binding": sessions[0] ?? "",
                    cookie: "__Host-fidy_session=" + bearer(0),
                    origin: "https://app.fidyapp.com",
                    "content-type": "application/json",
                  },
                }
              )
            )
          );
        } else if (failure === "audit-outage") {
          yield* fromTestPromise(() =>
            db.exec(
              "CREATE TRIGGER refuse_delete_audit BEFORE INSERT ON audit_entries WHEN NEW.record_type='session_call' AND NEW.operation = 'transactions.deleteTransaction' BEGIN SELECT RAISE(ABORT, 'audit_unavailable'); END"
            )
          );
        } else {
          const token = `fin_${"j".repeat(8)}_${"k".repeat(43)}`;
          const current = yield* Clock.currentTimeMillis;
          yield* seedNativePAT({
            db,
            userId: owner,
            token,
            scopes: [failure === "read-only" ? "read" : "write"],
            current,
          });

          if (failure === "revoked") {
            yield* fromTestPromise(() =>
              db.exec("UPDATE pats SET revoked_at_ms = ? WHERE user_id = ?", current, owner)
            );
          }

          deletion = new Request(`https://api.fidyapp.com/transactions/${id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          });
        }

        const response = yield* fromTestPromise(() => db.send(deletion));
        const status = { linked: 400, "audit-outage": 503, "read-only": 403, revoked: 401 };
        expect(response.status).toBe(status[failure]);
        expect(
          yield* fromTestPromise(() =>
            db
              .exec(
                "SELECT deleted_at_ms FROM transactions WHERE user_id = ? AND id = ?",
                owner,
                id
              )
              .then(([row]) => row)
          )
        ).toMatchObject({ deleted_at_ms: null });
        expect(
          yield* fromTestPromise(() =>
            nativeCountRows(
              db,
              "SELECT COUNT(*) AS count FROM audit_entries WHERE user_id=? AND record_type='session_call' AND operation='transactions.deleteTransaction' AND outcome='success'",
              owner
            )
          )
        ).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
    )
);

it("cannot link a hidden Transaction or restore its visibility", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;
      const owner = users[0] ?? "";
      const first = "30000000-0000-4000-8000-000000000997";
      const second = "30000000-0000-4000-8000-000000000998";
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, userId: owner, id: first, categoryId: category })
      );
      yield* fromTestPromise(() =>
        seedNativeTransaction({ db, userId: owner, id: second, categoryId: category })
      );

      const deletion = new Request(request(0, `/transactions/${first}`), {
        method: "DELETE",
        headers: {
          "Fidy-Session-Binding": sessions[0] ?? "invalid",
          cookie: `__Host-fidy_session=${bearer(0)}`,
          origin: "https://app.fidyapp.com",
        },
      });

      expect((yield* fromTestPromise(() => db.send(deletion))).status).toBe(200);

      const link = new Request(
        request(0, "/transactions/link", {
          firstTransactionId: first,
          secondTransactionId: second,
        }),
        {
          headers: {
            "Fidy-Session-Binding": sessions[0] ?? "invalid",
            cookie: `__Host-fidy_session=${bearer(0)}`,
            origin: "https://app.fidyapp.com",
            "content-type": "application/json",
          },
        }
      );

      expect((yield* fromTestPromise(() => db.send(link))).status).toBe(404);
      yield* fromTestPromise(() =>
        expect(
          db.exec(
            "UPDATE transactions SET deleted_at_ms = NULL WHERE user_id = ? AND id = ?",
            owner,
            first
          )
        ).rejects.toThrow("transaction_deleted")
      );
      expect(yield* fromTestPromise(() => nativeReconciliationState(db, owner))).toEqual({
        decisions: [],
        members: [],
      });
      expect(
        yield* fromTestPromise(() =>
          nativeCountRows(
            db,
            "SELECT COUNT(*) AS count FROM transaction_effective_source WHERE user_id=?",
            owner
          )
        )
      ).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("searches older effective Transactions with combined exact Money filters and bounded continuation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* nativeTransactionJourney;

      yield* Effect.forEach(
        users.entries(),
        Effect.fnUntraced(function* ([index, subject]) {
          yield* fromTestPromise(() =>
            db.owner(subject).exec(
              `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500)
        INSERT INTO transactions(id,user_id,amount,currency,direction,category_id,counterparty,notes,occurred_at_ms,created_at_ms)
        SELECT printf('00000000-0000-4000-8200-%012d',n),?,
        CASE WHEN n=7 THEN '9007199254740993.16' ELSE '9007199254740993.15' END,
        CASE WHEN n=6 THEN 'COP' ELSE 'USD' END,CASE WHEN n=5 THEN 'inflow' ELSE 'outflow' END,?,
        CASE WHEN n<9 THEN 'Internet antiguo' ELSE 'Otro' END,'Pago del hogar',1736424000000+n*1000,1736424000000 FROM seq WHERE (n=8)=?`,
              subject,
              category,
              index
            )
          );
        }),
        { discard: true }
      );

      const read = (query: URLSearchParams): Promise<Response> =>
        db.browser(0, "/transactions/search?" + query);

      const query = new URLSearchParams({
        q: "Internet",
        currency: "USD",
        direction: "outflow",
        amount: "9007199254740993.1500",
        from: "2025-01-09T00:00:00.000Z",
        to: "2025-01-11T00:00:00.000Z",
        limit: "2",
      });

      const Page = Schema.Struct({
        data: Schema.Array(Schema.Struct({ id: Transaction.fields.id })),
        next: Schema.Array(
          Schema.Struct({
            args: Schema.Struct({ query: Schema.Record(Schema.String, Schema.String) }),
          })
        ),
      });

      const first = yield* fromTestPromise(() => read(query));
      expect(first.status).toBe(200);

      const page = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => first.json())
      );

      expect(page.data.map((row) => row.id)).toEqual([
        "00000000-0000-4000-8200-000000000004",
        "00000000-0000-4000-8200-000000000003",
      ]);
      const next = Option.getOrThrow(Option.fromUndefinedOr(page.next[0])).args.query;
      expect(next).toMatchObject({ ...Object.fromEntries(query), amount: "9007199254740993.15" });
      const second = yield* fromTestPromise(() => read(new URLSearchParams(next)));
      expect(second.status).toBe(200);

      const last = yield* Schema.decodeUnknownEffect(Page)(
        yield* fromTestPromise(() => second.json())
      );

      expect(last.data.map((row) => row.id)).toEqual([
        "00000000-0000-4000-8200-000000000002",
        "00000000-0000-4000-8200-000000000001",
      ]);
      expect(last.next).toEqual([]);
      query.set("amount", "9007199254740993.17");
      const absent = yield* fromTestPromise(() => read(query));
      expect(absent.status).toBe(200);
      expect(
        (yield* Schema.decodeUnknownEffect(Page)(yield* fromTestPromise(() => absent.json()))).data
      ).toEqual([]);
      query.set("amount", "1e3");
      expect((yield* fromTestPromise(() => read(query))).status).toBe(400);
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));

it("reads an addressed linked Transaction without work proportional to retained history", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeNativeTransactionJourney(undefined, nativeTransactionReadPlatform);

      const owner = alice.user,
        prefix = "20000000-0000-4000-8000-";

      yield* fromTestPromise(() =>
        db.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
        INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)
        SELECT ?||printf('%012d',i),?,'100','COP','outflow','shop',?,1767225600000+i*1200000,1767225600000+i*1200000 FROM n`,
          prefix,
          owner,
          category
        )
      );
      yield* fromTestPromise(() =>
        db.exec(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
        INSERT INTO transaction_reconciliation_decisions SELECT ?,?||printf('%012d',2*i-1),?||printf('%012d',2*i),'linked',?||printf('%012d',2*i-1),1767225600000 FROM n`,
          owner,
          prefix,
          prefix,
          prefix
        )
      );
      yield* fromTestPromise(() =>
        db.exec(`UPDATE transactions SET reconciliation_first_id=incoming.first_transaction_id,reconciliation_second_id=incoming.second_transaction_id FROM (
        SELECT first_transaction_id AS id,first_transaction_id,second_transaction_id FROM transaction_reconciliation_decisions
        UNION ALL SELECT second_transaction_id,first_transaction_id,second_transaction_id FROM transaction_reconciliation_decisions) incoming WHERE transactions.id=incoming.id`)
      );
      const id = prefix + "000000000002";
      const read = (): Promise<Response> => db.browser(0, "/transactions/" + id);
      const response = yield* fromTestPromise(read);
      expect(response.status).toBe(200);

      const InspectionResponse = Schema.Struct({
        data: TransactionInspection,
        next: Schema.Array(Schema.Unknown),
      });

      const body = yield* Schema.decodeUnknownEffect(InspectionResponse)(
        yield* fromTestPromise(() => response.json())
      ).pipe(Effect.orDie);

      expect(body.data.id).toBe("20000000-0000-4000-8000-000000000001");
      expect(body.data.presentation).toEqual({
        kind: "suppressed-member",
        requestedId: "20000000-0000-4000-8000-000000000002",
      });
      expect(body.data.revision).toBe(0);

      const actual = yield* fromTestPromise(() =>
        db.runtime
          .getDurableObjectNamespace("USER_STORE", "core")
          .then((namespace) =>
            namespace.getByName(owner).fetch("https://fixture.invalid/addressed-cost")
          )
      );

      expect(actual.status).toBe(200);

      const cost = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ rowsRead: Schema.Int, records: Schema.Int })
      )(yield* fromTestPromise(() => actual.json()));

      expect(cost.records).toBe(1);
      expect(cost.rowsRead).toBeLessThan(250);

      yield* Effect.forEach(
        ["dirty", "clearing", "rebuilding"],
        Effect.fnUntraced(function* (readiness) {
          yield* fromTestPromise(() =>
            db.exec(
              "UPDATE transaction_projection_state SET readiness=? WHERE user_id=?",
              readiness,
              owner
            )
          );
          const repaired = yield* fromTestPromise(read);
          expect(repaired.status).toBe(200);
          expect(yield* fromTestPromise(() => repaired.json())).toEqual(
            yield* Schema.encodeEffect(InspectionResponse)(body)
          );
        }),
        { discard: true }
      );
    }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer))
  ));
