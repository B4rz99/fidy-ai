import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import {
  preserveStoreAlarm,
  withStoreAdmission,
  withStoreCapacity,
} from "../../runtime/sqlite/operations";
import type { QuotaStatus } from "../../../src/core/quotas/contract";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { CanonicalRetryKey, canonicalRetryLifetimeMs } from "../../../src/core/quotas/contract";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { UserId } from "../../../src/core/identity/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { decideOperationAccess } from "../../../src/shell/canonical-policy/operations";
import { patRouteHeader } from "../../directory/contract";
import { decodeQuotaStatus, quotaStatusSelection } from "../../quotas/operations";
import { localPATCredential, patRouteProof } from "../../tokens/operations";
import {
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { newId } from "../../secret-material/operations";
import {
  CanonicalAdmissionUnavailable,
  type LocalMutationResult,
  canonicalRequestProtection,
} from "../contract";
import {
  attachStanding,
  exhausted,
  invalid,
  noAuthority,
  rateLimited,
  scopeMissing,
} from "./responses";
import { cryptoHash, validatedCanonicalInput } from "./request-input";

export const admitLocalRequest = Effect.fn(function* ({
  user,
  current,
}: Readonly<{ user: string; current: number }>) {
  const sql = yield* SqliteClient;
  const policy = canonicalRequestProtection;
  yield* sql`DELETE FROM canonical_request_leases WHERE user_id=${user} AND expires_at_ms<=${current}`;
  return yield* sql`INSERT INTO canonical_request_buckets(subject,virtual_at_ms)
      SELECT ${"user:" + user},${current + policy.intervalMs}
      WHERE (SELECT count(*) FROM canonical_request_leases WHERE user_id=${user}) < ${policy.concurrency}
      ON CONFLICT(subject) DO UPDATE SET virtual_at_ms=max(virtual_at_ms,${current})+${policy.intervalMs}
      WHERE virtual_at_ms<=${current + (policy.burst - 1) * policy.intervalMs} RETURNING 1`;
});

export const localStanding = Effect.fn(function* (userId: string, current: number) {
  const sql = yield* SqliteClient;
  const select = quotaStatusSelection({
    users: { sql: "SELECT ? AS userId", params: [userId] },
    current,
  });
  const [row] = yield* sql.unsafe(select.sql, select.params);
  return yield* Effect.fromOption(
    decodeQuotaStatus({ row, current }),
    () => new CanonicalAdmissionUnavailable({ cause: "standing" })
  );
});
const Receipt = Schema.Struct({
  operation: Schema.String,
  input_digest: Schema.String,
  status: Schema.Int,
  body: Schema.NullOr(Schema.String),
});
const bodyResponse = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const resolveSession = Effect.fn(function* (
  proof: Awaited<ReturnType<typeof readBoundWebSessionProof>>,
  owns: (user: string) => boolean,
  current: number
) {
  if (Option.isNone(proof)) return "unauthenticated" as const;
  const lookup = boundSessionLookup({ ...proof.value, current });
  const sql = yield* SqliteClient;
  const [row] = yield* sql.unsafe(lookup.statement.sql, lookup.statement.params);
  const session = resolveBoundCanonicalWebSession({ lookup, row });
  if (Option.isNone(session) || !owns(session.value.userId)) return "unauthenticated" as const;
  return {
    sessionId: session.value.id,
    userId: yield* Schema.decodeEffect(UserId)(session.value.userId),
  };
});
export const localProof = Effect.fn(function* (request: Request, owns: (user: string) => boolean) {
  if (request.headers.has("authorization")) {
    const candidate = patRouteProof(request);
    const id = Option.fromNullishOr(request.headers.get(patRouteHeader));
    if (Option.isNone(candidate) || Option.isNone(id)) {
      return (): Effect.Effect<"unauthenticated"> => Effect.succeed("unauthenticated");
    }
    const digest = yield* candidate.value.digest;
    return (current: number): ReturnType<typeof localPATCredential> =>
      localPATCredential({ id: id.value, shortId: candidate.value.shortId, digest, current, owns });
  }
  const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));
  return (current: number): ReturnType<typeof resolveSession> =>
    resolveSession(proof, owns, current);
});
type Mutation<A, E> = Readonly<{
  request: Request;
  storage: DurableObjectStorage;
  operation: CatalogOperation;
  owns: (user: string) => boolean;
  input: Effect.Effect<Option.Option<A>>;
  work: (
    input: A,
    userId: UserId,
    current: number
  ) => Effect.Effect<LocalMutationResult, E, SqliteClient>;
}>;

type Subject = Exclude<
  | Effect.Success<ReturnType<typeof localPATCredential>>
  | Effect.Success<ReturnType<typeof resolveSession>>,
  string
>;
export type Call = Readonly<{
  storage: DurableObjectStorage;
  subject: Subject;
  operation: CatalogOperation;
  status: QuotaStatus;
  current: number;
}>;
export type Invocation = Readonly<{ digest: Option.Option<string>; inputHash: string }>;

const oneStored = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<void, CanonicalAdmissionUnavailable> =>
  rows.length === 1
    ? Effect.void
    : Effect.fail(new CanonicalAdmissionUnavailable({ cause: "incomplete_local_mutation" }));
export const audit = Effect.fn(function* (
  { subject, operation, current }: Call,
  outcome: LocalMutationResult["outcome"]
) {
  const sql = yield* SqliteClient;
  const { userId } = subject;
  if ("patId" in subject) {
    yield* oneStored(
      yield* sql`INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,outcome,occurred_at_ms)
      VALUES ('credential_call',${newId()},${userId},${subject.patId},${operation.id},${outcome === "success" ? "accepted" : "rejected"},${current}) RETURNING id`
    );
    if (outcome === "success") {
      yield* oneStored(
        yield* sql`UPDATE pats SET last_used_at_ms=${current} WHERE id=${subject.patId} AND user_id=${userId} RETURNING id`
      );
    }
  } else {
    yield* oneStored(
      yield* sql`INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms)
      VALUES('session_call',${newId()},${userId},${subject.sessionId},${operation.id},${outcome},${current}) RETURNING id`
    );
  }
});
export const reject = Effect.fn(function* (call: Call, response: Response) {
  yield* audit(call, "validation_failed");
  return attachStanding({ ...call, response });
});
const firstFailureStatus = 400;
const validateOutput = Effect.fn(function* (
  operation: CatalogOperation,
  status: number,
  body: Schema.Json
) {
  const codec = status < firstFailureStatus ? operation.success : operation.failure;
  yield* Schema.decodeEffect(codec, { onExcessProperty: "error" })(body);
});
const receiptCleanupPageSize = 32;
/** Expire one bounded page, both on active use and when the maintenance owner visits an idle User. */
export const sweepLocalReceipts = Effect.fn(function* (current: number) {
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM canonical_request_receipts WHERE rowid IN (
    SELECT rowid FROM canonical_request_receipts WHERE accepted_at_ms<=${current - canonicalRetryLifetimeMs}
      ORDER BY accepted_at_ms LIMIT ${receiptCleanupPageSize})`;
});
// A full Recurring ledger or correlated batch result can exceed the SQLite row limit.
const chunkedReceipt = (id: string): boolean =>
  id === "recurringPlans.applyRecurringEdit" || id === "operations.executeAtomicBatch";
const receiptPartCharacters = 200_000;
const ReceiptPart = Schema.Struct({ position: Schema.Int, part: Schema.String });
const fullReceiptBody = Effect.fn(function* ({
  body,
  operation,
  user,
  digest,
}: {
  body: string;
  operation: string;
  user: UserId;
  digest: string;
}) {
  if (!chunkedReceipt(operation) || body.startsWith("{")) return body;
  const length = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Int))(body);
  const sql = yield* SqliteClient;
  const parts = yield* Schema.decodeUnknownEffect(Schema.Array(ReceiptPart))(
    yield* sql`SELECT position,part FROM canonical_receipt_parts WHERE user_id=${user} AND retry_key_digest=${digest} ORDER BY position`
  );
  let next = 0;
  for (const { position, part } of parts) {
    if (position !== next) {
      return yield* new CanonicalAdmissionUnavailable({ cause: "incomplete_receipt" });
    }
    next += part.length;
  }
  if (next !== length) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "incomplete_receipt" });
  }
  return parts.map((row) => row.part).join("");
});
export const replay = Effect.fn(function* (call: Call, invocation: Invocation) {
  if (Option.isNone(invocation.digest)) return Option.none<Response>();
  const sql = yield* SqliteClient;
  const { operation, current, subject } = call;
  const [stored] =
    yield* sql`SELECT operation,input_digest,status,body FROM canonical_request_receipts
    WHERE user_id=${subject.userId} AND retry_key_digest=${invocation.digest.value} AND accepted_at_ms>${current - canonicalRetryLifetimeMs}`;
  if (stored === undefined) return Option.none<Response>();
  const receipt = yield* Schema.decodeUnknownEffect(Receipt)(stored);
  if (receipt.operation !== operation.id || receipt.input_digest !== invocation.inputHash) {
    return Option.some(
      yield* reject(call, invalid("The retry key is already bound to different operation inputs."))
    );
  }
  if (receipt.body === null) {
    return Option.some(
      yield* reject(call, invalid("This completed operation cannot replay its one-time result."))
    );
  }
  const body = yield* fullReceiptBody({
    body: receipt.body,
    operation: operation.id,
    user: subject.userId,
    digest: invocation.digest.value,
  });
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(body);
  yield* validateOutput(operation, receipt.status, decoded);
  yield* audit(call, receipt.status < firstFailureStatus ? "success" : "validation_failed");
  return Option.some(attachStanding({ ...call, response: bodyResponse(receipt.status, body) }));
});
export const charge = Effect.fn(function* (call: Call) {
  const { subject, current, operation, status } = call;
  if (!("patId" in subject)) return Option.none<Response>();
  const meter = status.canonicalCalls;
  if (meter._tag !== "Uncapped" && meter.remaining === 0) {
    return Option.some(yield* reject(call, exhausted(current)));
  }
  const sql = yield* SqliteClient;
  const identity = newId();
  const period = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt);
  yield* oneStored(
    yield* sql`INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
    VALUES(${subject.userId},'canonical_call',${identity},${period},${current},${meter._tag === "Uncapped" ? 0 : 1}) RETURNING identity`
  );
  yield* oneStored(
    yield* sql`INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,occurred_at_ms)
    VALUES('request_admission',${identity},${subject.userId},${subject.patId},${operation.id},${current}) RETURNING id`
  );
  return Option.none<Response>();
});
export const financialGrowth = new Set<string>([
  "categories.createKeywordRule",
  "categories.updateKeywordRule",
  "transactions.updateTransactions",
  "recurringPlans.applyRecurringEdit",
  "dashboard.initializeDashboard",
  "dashboard.applyDashboardEdit",
  "budgets.createBudget",
  "budgets.updateBudget",
  "transactions.createTransaction",
  "transactions.updateTransaction",
  "transactions.linkTransactions",
]);
export const replayableOperations = new Set<string>([
  ...financialGrowth,
  "categories.deleteKeywordRule",
  "budgets.deleteBudget",
  "subscription.cancelSubscription",
  "transactions.unlinkTransactions",
  "transactions.deleteTransaction",
]);
const highSurrogateStart = 0xd800;
const highSurrogateEnd = 0xdbff;
const writeReceiptParts = Effect.fn(function* (body: string, user: UserId, digest: string) {
  const sql = yield* SqliteClient;
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + receiptPartCharacters, body.length);
    // SQLite text parameters must never split a Unicode scalar.
    const tail = body.charCodeAt(end - 1);
    if (tail >= highSurrogateStart && tail <= highSurrogateEnd && end < body.length) end -= 1;
    yield* sql`INSERT INTO canonical_receipt_parts(user_id,retry_key_digest,position,part) VALUES(${user},${digest},${start},${body.slice(start, end)})`;
    start = end;
  }
});
export const complete = Effect.fn(function* (
  call: Call,
  invocation: Invocation,
  outcome: LocalMutationResult & { retain: boolean }
) {
  const { subject, operation, current } = call;
  const { retain } = outcome;
  yield* validateOutput(operation, outcome.status, outcome.body);
  yield* audit(call, outcome.outcome);
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(outcome.body);
  if (Option.isSome(invocation.digest)) {
    const sql = yield* SqliteClient;
    yield* preserveStoreAlarm(call.storage, current + canonicalRetryLifetimeMs);
    yield* sql`DELETE FROM canonical_request_receipts WHERE user_id=${subject.userId} AND retry_key_digest=${invocation.digest.value} AND accepted_at_ms<=${current - canonicalRetryLifetimeMs}`;
    const large = retain && chunkedReceipt(operation.id) && body.length > receiptPartCharacters;
    const value = large ? String(body.length) : body;
    // A positive allowlist keeps future one-time responses out of storage until explicitly reviewed.
    yield* oneStored(
      yield* sql`INSERT INTO canonical_request_receipts(user_id,retry_key_digest,operation,input_digest,accepted_at_ms,status,body)
      VALUES(${subject.userId},${invocation.digest.value},${operation.id},${invocation.inputHash},${current},${outcome.status},${retain ? value : null}) RETURNING status`
    );
    if (large) yield* writeReceiptParts(body, subject.userId, invocation.digest.value);
  }
  return attachStanding({
    response: bodyResponse(outcome.status, body),
    status: yield* localStanding(subject.userId, current),
    current,
  });
});
const deniedAccess = (call: Call): boolean =>
  "patId" in call.subject &&
  decideOperationAccess(call.operation.policy.access, {
    _tag: "PAT",
    capabilities: call.subject.scopes,
  })._tag !== "Allowed";
export const localRetryKey = (request: Request): ReturnType<Headers["get"]> =>
  request.headers.has("authorization") ? request.headers.get("Fidy-Retry-Key") : null;
const prepareIdentity = Effect.fn(function* (request: Request, operation: CatalogOperation) {
  const valid = yield* validatedCanonicalInput({ request, operation });
  const key = operation.method !== "GET" ? localRetryKey(request) : null;
  const validKey = Schema.decodeUnknownOption(CanonicalRetryKey)(key);
  const digest = Option.isSome(validKey)
    ? Option.some(yield* cryptoHash(validKey.value))
    : Option.none<string>();
  return {
    keyValid: key === null || Option.isSome(validKey),
    identity: Option.map(valid, ({ inputHash }): Invocation => ({ inputHash, digest })),
  };
});
const authorizedWork = Effect.fn(function* <E>({
  call,
  invocation,
  admission,
  work,
}: Readonly<{
  call: Call;
  invocation: Invocation;
  admission: Effect.Effect<void, StoreCapacityUnavailable>;
  work: () => Effect.Effect<LocalMutationResult, E, SqliteClient>;
}>) {
  yield* sweepLocalReceipts(call.current);
  const prior = yield* replay(call, invocation);
  if (Option.isSome(prior)) return prior.value;
  const refusal = yield* charge(call);
  if (Option.isSome(refusal)) return refusal.value;
  yield* admission;
  return yield* complete(call, invocation, {
    ...(yield* work()),
    retain: replayableOperations.has(call.operation.id),
  });
});
export const withdrawn = (): Response =>
  Response.json(
    {
      error: {
        code: "user_action_required",
        message: "Return to Fidy to review your withdrawn Consent.",
      },
      next: [],
    },
    { status: 403 }
  );
export const runLocalMutation = Effect.fn(function* <A, E>(
  { request, storage, operation, owns, input, work }: Mutation<A, E>,
  invalidTarget: Option.Option<LocalMutationResult> = Option.none()
) {
  const resolve = yield* localProof(request, owns);
  const { keyValid, identity } = yield* prepareIdentity(request, operation);
  const argumentsForOwner = Option.product(yield* input, identity);
  const invalidInput = Option.match(invalidTarget, {
    onNone: () => ({
      response: invalid("Invalid canonical operation input."),
      outcome: "validation_failed" as const,
    }),
    onSome: (target) => ({
      response: Response.json(target.body, {
        status: target.status,
        headers: { "cache-control": "no-store" },
      }),
      outcome: target.outcome,
    }),
  });
  const prepared = Option.match(argumentsForOwner, {
    onNone: () => ({ refusal: invalidInput }) as const,
    onSome: ([value, invocation]) =>
      keyValid
        ? ({ value, invocation } as const)
        : ({
            refusal: {
              response: invalid("Invalid canonical retry key."),
              outcome: "validation_failed" as const,
            },
          } as const),
  });
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const subject = yield* resolve(current);
      if (subject === "unauthenticated") return noAuthority();
      if (subject === "consent_revoked") return withdrawn();
      const status = yield* localStanding(subject.userId, current);
      const call = { subject, status, current, operation, storage };
      if ((yield* admitLocalRequest({ user: subject.userId, current })).length !== 1) {
        return attachStanding({ ...call, response: rateLimited() });
      }
      if (deniedAccess(call)) return yield* reject(call, scopeMissing());
      if (prepared.refusal !== undefined) {
        yield* audit(call, prepared.refusal.outcome);
        return attachStanding({ ...call, response: prepared.refusal.response });
      }
      return yield* authorizedWork({
        call,
        invocation: prepared.invocation,
        admission: financialGrowth.has(operation.id) ? admitGrowth : Effect.void,
        work: work.bind(null, prepared.value, subject.userId, current),
      });
    })
  );
});

export const repairReceiptAlarm = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const next =
    yield* sql`SELECT accepted_at_ms FROM canonical_request_receipts ORDER BY accepted_at_ms LIMIT 1`;
  if (next.length > 0) {
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ accepted_at_ms: Schema.Int })])
    )(next);
    return yield* preserveStoreAlarm(
      storage,
      Math.max(current, row.accepted_at_ms + canonicalRetryLifetimeMs)
    );
  }
  return false;
});

export const sweepReceiptWork = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage
) {
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sweepLocalReceipts(current);
      yield* repairReceiptAlarm(current, storage);
      return { attempted: 0, failed: 0 };
    })
  );
});
