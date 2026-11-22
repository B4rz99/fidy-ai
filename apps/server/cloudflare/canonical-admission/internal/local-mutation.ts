import {
  OperationAccessCaller,
  OperationAccessDecision,
} from "../../../src/shell/canonical-policy/contract";
import { confirmLocalOAuth } from "../../oauth-confirmation/operations";
import { resolveLocalOAuthCaller } from "../../oauth-agents/operations";
import { CurrentOAuthInvocation, type LocalOAuthInvocation } from "../../oauth-agents/contract";
import type { PATScopes } from "../../../src/core/tokens/contract";
import { recordOAuthCall } from "../../../src/shell/audit/operations";
import { liveOAuthCommitAuthority } from "../../../src/shell/oauth-agents/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import {
  preserveStoreAlarm,
  withStoreAdmission,
  withStoreCapacity,
} from "../../runtime/sqlite/operations";
import {
  CanonicalRetryKey,
  QuotaStatus,
  canonicalRetryLifetimeMs,
} from "../../../src/core/quotas/contract";
import { Clock, DateTime, Effect, Match, Option, Predicate, Schema } from "effect";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { UserId } from "../../../src/core/identity/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import {
  type SuggestedOperationCaller,
  freePatCaller,
  grantsRequiredTier,
} from "../../../src/shell/canonical-operations/operations";
import { listLaunchCategories } from "../../../src/core/categories/operations";
import { decideOperationAccess } from "../../../src/shell/canonical-policy/operations";
import { patRouteHeader } from "../../directory/contract";
import { decodeQuotaStatus, quotaStatusSelection } from "../../quotas/operations";
import { localPATCredential, patRouteProof } from "../../tokens/operations";
import {
  boundSecuritySessionLookup,
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { newId } from "../../secret-material/operations";
import {
  CanonicalAdmissionUnavailable,
  type CanonicalOutcome,
  type CanonicalRejection,
  CurrentSuggestionCaller,
  type LocalMutationOutcome,
  type LocalMutationResult,
  canonicalRequestProtection,
  validationRejection,
} from "../contract";
import {
  attachStanding,
  exhausted,
  invalid,
  noAuthority,
  rateLimited,
  scopeMissing,
} from "./responses";
import { catchRejection, rejectionResponse } from "../rejection";
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

const isResponse = Schema.is(Schema.instanceOf(Response));

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

const resolveSession = Effect.fn(function* ({
  proof,
  owns,
  current,
  sessionLookup,
}: {
  proof: Awaited<ReturnType<typeof readBoundWebSessionProof>>;
  owns: (user: string) => boolean;
  current: number;
  sessionLookup: typeof boundSessionLookup;
}) {
  if (Option.isNone(proof)) return "unauthenticated" as const;
  const lookup = sessionLookup({ ...proof.value, current });
  const sql = yield* SqliteClient;

  const [row] = yield* sql.unsafe(
    lookup.statement.sql +
      " AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=web_sessions.user_id)",
    lookup.statement.params
  );

  const session = resolveBoundCanonicalWebSession({ lookup, row });

  if (Option.isNone(session) || !owns(session.value.userId)) return "unauthenticated" as const;

  return {
    sessionId: session.value.id,
    userId: yield* Schema.decodeEffect(UserId)(session.value.userId),
  };
});

export const localProof = Effect.fn(function* (
  request: Request,
  owns: (user: string) => boolean,
  sessionLookup: typeof boundSessionLookup = boundSessionLookup
) {
  const invocation = yield* CurrentOAuthInvocation;

  if (Option.isSome(invocation)) {
    const oauth = invocation.value;

    return Effect.fn(function* (current: number) {
      if (
        !owns(oauth.subject.userId) ||
        oauth.admission.deadlineMilliseconds <= current ||
        request.signal.aborted
      ) {
        return "unauthenticated" as const;
      }

      const facts = yield* resolveLocalOAuthCaller({ subject: oauth.subject, current });

      return Option.isNone(facts)
        ? ("unauthenticated" as const)
        : { oauth, userId: oauth.subject.userId, scopes: facts.value.scopes };
    });
  }

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
    resolveSession({ proof, owns, current, sessionLookup });
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
  ) => Effect.Effect<LocalMutationResult, E | CanonicalRejection, SqliteClient>;
}>;

type Subject = Exclude<
  | Effect.Success<ReturnType<typeof localPATCredential>>
  | Effect.Success<ReturnType<typeof resolveSession>>
  | { oauth: LocalOAuthInvocation; userId: UserId; scopes: PATScopes },
  string
>;

const suggestionCallerFor = (subject: Subject): SuggestedOperationCaller => {
  if ("patId" in subject) return freePatCaller(subject.scopes);

  if ("oauth" in subject) {
    return {
      accessCaller: OperationAccessCaller.OAuthAgent({ capabilities: subject.scopes }),
      tier: "free",
    };
  }

  return { accessCaller: OperationAccessCaller.WebSession({ fresh: false }), tier: "free" };
};

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

const sessionOutcome = (
  outcome: CanonicalOutcome
): { kind: string; reason: Option.Option<string> } =>
  outcome === "resource_limit"
    ? { kind: "validation_failed", reason: Option.some(outcome) }
    : { kind: outcome, reason: Option.none() };

export const audit = Effect.fn(function* (
  { subject, operation, current }: Call,
  outcome: CanonicalOutcome
) {
  const sql = yield* SqliteClient;
  const { userId } = subject;

  if ("oauth" in subject) {
    const stmt = recordOAuthCall({
      id: newId(),
      authority: liveOAuthCommitAuthority({ subject: subject.oauth.subject, current }),
      operation: operation.id,
      current,
      outcome: outcome === "success" ? "accepted" : "rejected",
    });

    yield* oneStored(yield* sql.unsafe(stmt.sql + " RETURNING id", stmt.params));
  } else if ("patId" in subject) {
    yield* oneStored(
      yield* sql`INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,outcome,occurred_at_ms)
      VALUES ('credential_call',${newId()},${userId},${subject.patId},${operation.id},${outcome === "success" ? "accepted" : "rejected"},${current}) RETURNING id`
    );

    if (outcome === "success") {
      yield* oneStored(
        yield* sql`UPDATE pats SET last_used_at_ms=${current} WHERE id=${subject.patId} AND user_id=${userId} RETURNING id`
      );

      const currentProof = yield* localPATCredential({
        id: subject.patId,
        shortId: subject.shortId,
        digest: subject.digest,
        current: yield* Clock.currentTimeMillis,
        owns: (user) => user === userId,
      });

      if (Predicate.isString(currentProof) || deniedAccess({ subject: currentProof, operation })) {
        return yield* new CanonicalAdmissionUnavailable({
          cause: "PAT authority changed during commit",
        });
      }
    }
  } else {
    const recorded = sessionOutcome(outcome);
    yield* oneStored(
      yield* sql`INSERT INTO audit_entries(record_type,id,user_id,session_id,operation,outcome,occurred_at_ms,refusal_reason)
      VALUES('session_call',${newId()},${userId},${subject.sessionId},${operation.id},${recorded.kind},${current},${Option.getOrNull(recorded.reason)}) RETURNING id`
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

const refilledBucketIdleMs = 60000;

export const sweepLocalReceipts = Effect.fn(function* (current: number) {
  const sql = yield* SqliteClient;
  yield* sql`DELETE FROM canonical_request_receipts WHERE rowid IN (
    SELECT rowid FROM canonical_request_receipts WHERE accepted_at_ms<=${current - canonicalRetryLifetimeMs}
      ORDER BY accepted_at_ms LIMIT ${receiptCleanupPageSize})`;
});

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

  yield* Effect.forEach(
    parts,
    Effect.fnUntraced(function* ({ position, part }) {
      if (position !== next) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "incomplete_receipt" });
      }

      next += part.length;
    }),
    { discard: true }
  );

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
    yield* sql`SELECT r.operation,r.input_digest,r.status,coalesce(a.body,r.body) AS body FROM canonical_request_receipts r LEFT JOIN agent_operation_receipt_bodies a ON a.user_id=r.user_id AND a.retry_key_digest=r.retry_key_digest
    WHERE r.user_id=${subject.userId} AND r.retry_key_digest=${invocation.digest.value} AND r.accepted_at_ms>${current - canonicalRetryLifetimeMs}`;

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

  if (
    "sessionId" in subject ||
    ["quota.getQuota", "subscription.getUpgradeUrl"].includes(operation.id)
  ) {
    return Option.none<Response>();
  }

  const meter = status.canonicalCalls;

  if (
    Match.valueTags(meter, { Uncapped: () => false, Limited: ({ remaining }) => remaining === 0 })
  ) {
    return Option.some(yield* reject(call, exhausted(current)));
  }

  const sql = yield* SqliteClient;
  const identity = newId();
  const period = DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt);
  yield* oneStored(
    yield* sql`INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
    VALUES(${subject.userId},'canonical_call',${identity},${period},${current},${Match.valueTags(meter, { Uncapped: () => 0, Limited: () => 1 })}) RETURNING identity`
  );

  if ("patId" in subject) {
    yield* oneStored(
      yield* sql`INSERT INTO audit_entries(record_type,id,user_id,pat_id,operation,occurred_at_ms)
    VALUES('request_admission',${identity},${subject.userId},${subject.patId},${operation.id},${current}) RETURNING id`
    );
  }

  return Option.none<Response>();
});

const financialGrowth = new Set<string>([
  "memory.remember",
  "memory.revise",
  "insights.updateReminderSchedule",
  "connections.connectInstitution",
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

export const requiresGrowthAdmission = (operation: string): boolean =>
  financialGrowth.has(operation) ||
  operation === "ingestion.applyReviewEdit" ||
  operation === "ingestion.resolveNeedsReviewItem" ||
  operation === "pats.createManualPAT" ||
  operation === "pats.approvePATPairing";

export const replayableOperations = new Set<string>([
  ...financialGrowth,
  "memory.forget",
  "insights.dismissInsight",
  "insights.markInsightRead",
  "insights.markInsightDelivered",
  "categories.deleteKeywordRule",
  "budgets.deleteBudget",
  "subscription.cancelSubscription",
  "transactions.unlinkTransactions",
  "transactions.deleteTransaction",
]);

const remainingReplayableChildren = new Set([
  "identity.updateUserPreferences",
  "ingestion.enableEmailForwarding",
  "ingestion.applyReviewEdit",
  "ingestion.abandonStatementSubmission",
  "ingestion.resolveNeedsReviewItem",
  "ingestion.skipNeedsReviewItem",
]);

export const replayableBatchChild = (id: string): boolean =>
  replayableOperations.has(id) || remainingReplayableChildren.has(id);

const usesAgentReceiptBody = (operation: string): boolean =>
  operation.startsWith("memory.") || operation.startsWith("insights.");

const highSurrogateStart = 0xd800;

const highSurrogateEnd = 0xdbff;

const writeReceiptParts = Effect.fn(function* (body: string, user: UserId, digest: string) {
  const sql = yield* SqliteClient;
  let start = 0;

  while (start < body.length) {
    let end = Math.min(start + receiptPartCharacters, body.length);
    const tail = body.charCodeAt(end - 1);

    if (tail >= highSurrogateStart && tail <= highSurrogateEnd && end < body.length) end -= 1;
    yield* sql`INSERT INTO canonical_receipt_parts(user_id,retry_key_digest,position,part) VALUES(${user},${digest},${start},${body.slice(start, end)})`;
    start = end;
  }
});

type ReceiptStorage = Readonly<{ parent: Option.Option<string>; agent: boolean; parts: boolean }>;

const receiptStorage = (operation: string, retain: boolean, body: string): ReceiptStorage => {
  if (!retain) return { parent: Option.none(), agent: false, parts: false };

  if (usesAgentReceiptBody(operation)) return { parent: Option.none(), agent: true, parts: false };

  if (chunkedReceipt(operation) && body.length > receiptPartCharacters) {
    return { parent: Option.some(String(body.length)), agent: false, parts: true };
  }

  return { parent: Option.some(body), agent: false, parts: false };
};

export const complete = Effect.fn(function* (
  call: Call,
  invocation: Invocation,
  outcome: LocalMutationOutcome & { retain: boolean }
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
    const storage = receiptStorage(operation.id, retain, body);
    yield* oneStored(
      yield* sql`INSERT INTO canonical_request_receipts(user_id,retry_key_digest,operation,input_digest,accepted_at_ms,status,body)
      VALUES(${subject.userId},${invocation.digest.value},${operation.id},${invocation.inputHash},${current},${outcome.status},${Option.getOrNull(storage.parent)}) RETURNING status`
    );

    if (storage.agent) {
      yield* oneStored(
        yield* sql`INSERT INTO agent_operation_receipt_bodies(user_id,retry_key_digest,body) VALUES(${subject.userId},${invocation.digest.value},${body}) RETURNING user_id`
      );
    }

    if (storage.parts) yield* writeReceiptParts(body, subject.userId, invocation.digest.value);
  }

  return attachStanding({
    response: bodyResponse(outcome.status, body),
    status: yield* localStanding(subject.userId, current),
    current,
  });
});

const deniedAccess = (call: Pick<Call, "subject" | "operation">): boolean =>
  !("sessionId" in call.subject) &&
  !OperationAccessDecision.$is("Allowed")(
    decideOperationAccess(
      call.operation.policy.access,
      "oauth" in call.subject
        ? OperationAccessCaller.OAuthAgent({ capabilities: call.subject.scopes })
        : OperationAccessCaller.PAT({ capabilities: call.subject.scopes })
    )
  );

export const localRetryKey = Effect.fnUntraced(function* (request: Request) {
  return request.headers.has("authorization") || Option.isSome(yield* CurrentOAuthInvocation)
    ? request.headers.get("Fidy-Retry-Key")
    : null;
});

export const localPreparationSubject = Effect.fn(function* (
  request: Request,
  owns: (user: string) => boolean,
  operation: CatalogOperation
) {
  const resolve = yield* localProof(request, owns);
  const subject = yield* resolve(yield* Clock.currentTimeMillis);

  return Predicate.isString(subject) || deniedAccess({ subject, operation })
    ? Option.none<UserId>()
    : Option.some(subject.userId);
});

const prepareIdentity = Effect.fn(function* (request: Request, operation: CatalogOperation) {
  const valid = yield* validatedCanonicalInput({ request, operation });
  const key = operation.method !== "GET" ? yield* localRetryKey(request) : null;
  const validKey = Schema.decodeUnknownOption(CanonicalRetryKey)(key);

  const digest = Option.isSome(validKey)
    ? Option.some(yield* cryptoHash(validKey.value))
    : Option.none<string>();

  return {
    keyValid: key === null || Option.isSome(validKey),
    identity: Option.map(valid, ({ inputHash }): Invocation => ({ inputHash, digest })),
  };
});

const confirmCall = Effect.fn(function* (call: Call) {
  return "oauth" in call.subject && call.operation.policy.agentConfirmation === "required"
    ? yield* confirmLocalOAuth(call.subject.oauth, call.current, charge(call))
    : { paid: false, consume: Effect.void };
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
  work: () => Effect.Effect<LocalMutationResult, E | CanonicalRejection, SqliteClient>;
}>) {
  const confirmation = yield* confirmCall(call);

  if (isResponse(confirmation)) return attachStanding({ ...call, response: confirmation });
  yield* sweepLocalReceipts(call.current);
  const prior = yield* replay(call, invocation);

  if (Option.isSome(prior)) return prior.value;
  const refusal = confirmation.paid ? Option.none<Response>() : yield* charge(call);

  if (Option.isSome(refusal)) return refusal.value;
  yield* admission;
  const result = yield* catchRejection(work());

  if (result.status < firstFailureStatus) yield* confirmation.consume;

  return yield* complete(call, invocation, {
    ...result,
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

const policyRefusal = Effect.fn(function* (call: Call) {
  if (deniedAccess(call)) return Option.some(yield* reject(call, scopeMissing()));

  if (
    grantsRequiredTier({
      requiredTier: call.operation.policy.requiredTier,
      callerTier: call.status.accessTier,
    })
  ) {
    return Option.none<Response>();
  }

  return Option.some(
    yield* reject(
      call,
      Response.json(
        {
          error: { code: "paywall_required", message: "This operation requires Pro access." },
          next: [],
        },
        { status: 402 }
      )
    )
  );
});

const sessionLookupFor = (operation: string): typeof boundSessionLookup =>
  operation === "pats.revokePAT" || operation === "pats.revokeAllPATs"
    ? boundSecuritySessionLookup
    : boundSessionLookup;

export const runLocalMutation = Effect.fn(function* <A, E>(
  { request, storage, operation, owns, input, work }: Mutation<A, E>,
  pathRejection: Option.Option<CanonicalRejection> = Option.none()
) {
  const resolve = yield* localProof(request, owns, sessionLookupFor(operation.id));
  const { keyValid, identity } = yield* prepareIdentity(request, operation);
  const argumentsForOwner = Option.product(yield* input, identity);

  const invalidInput = Option.getOrElse(pathRejection, () =>
    validationRejection("Invalid canonical operation input.")
  );

  const prepared = Option.match(argumentsForOwner, {
    onNone: () => ({ refusal: invalidInput }) as const,
    onSome: ([value, invocation]) =>
      keyValid
        ? ({ value, invocation } as const)
        : ({
            refusal: validationRejection("Invalid canonical retry key."),
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

      const forbidden = yield* policyRefusal(call);

      if (Option.isSome(forbidden)) return forbidden.value;

      if (prepared.refusal !== undefined) {
        yield* audit(call, prepared.refusal.audit.outcome);

        return attachStanding({
          ...call,
          response: rejectionResponse(prepared.refusal),
        });
      }

      return yield* authorizedWork({
        call,
        invocation: prepared.invocation,
        admission: requiresGrowthAdmission(operation.id) ? admitGrowth : Effect.void,
        work: work.bind(null, prepared.value, subject.userId, current),
      }).pipe(Effect.provideService(CurrentSuggestionCaller, suggestionCallerFor(subject)));
    })
  );
});

export const isNativeAccountQuery = (operation: string): boolean =>
  operation === "categories.listCategories" || operation === "quota.getQuota";

export const readNativeAccountQuery = Effect.fn(function* (
  operation: string,
  user: UserId,
  current: number
) {
  if (operation === "categories.listCategories") {
    return {
      status: 200,
      outcome: "success" as const,
      body: { data: [...listLaunchCategories()], next: [] },
    } satisfies LocalMutationResult;
  }

  if (operation === "quota.getQuota") {
    const standing = yield* localStanding(user, current);

    return {
      status: 200,
      outcome: "success" as const,
      body: {
        data: yield* Schema.encodeEffect(Schema.toCodecJson(QuotaStatus))(standing),
        next: [],
      },
    } satisfies LocalMutationResult;
  }

  return yield* new CanonicalAdmissionUnavailable({ cause: "unsupported account query" });
});

export const externalRead = Effect.fn(function* (
  unit: Pick<Mutation<boolean, never>, "request" | "operation" | "owns" | "storage">
) {
  return yield* runLocalMutation({
    ...unit,
    input: Effect.succeedSome(true),
    work: (_input, user, current) => readNativeAccountQuery(unit.operation.id, user, current),
  }).pipe(
    Effect.catchCause(() =>
      Effect.succeed(
        Response.json(
          {
            error: {
              code: "unavailable",
              message: "Canonical operation is temporarily unavailable.",
            },
            next: [],
          },
          { status: 503 }
        )
      )
    )
  );
});

export const repairReceiptAlarm = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT min(deadline) AS deadline FROM (SELECT min(accepted_at_ms)+${canonicalRetryLifetimeMs} AS deadline FROM canonical_request_receipts UNION ALL SELECT min(expires_at_ms) FROM canonical_request_leases UNION ALL SELECT min(virtual_at_ms)+${refilledBucketIdleMs} FROM canonical_request_buckets)`;

  const deadline = yield* Schema.decodeUnknownEffect(Schema.OptionFromNullOr(Schema.Int))(
    row?.deadline
  );

  return Option.isSome(deadline)
    ? yield* preserveStoreAlarm(storage, Math.max(current, deadline.value))
    : false;
});

export const sweepReceiptWork = Effect.fnUntraced(function* (
  current: number,
  storage: DurableObjectStorage
) {
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sweepLocalReceipts(current);
      const sql = yield* SqliteClient;
      yield* sql`DELETE FROM canonical_request_leases WHERE id IN(SELECT id FROM canonical_request_leases WHERE expires_at_ms<=${current} ORDER BY expires_at_ms LIMIT ${receiptCleanupPageSize})`;
      yield* sql`DELETE FROM canonical_request_buckets WHERE subject IN(SELECT subject FROM canonical_request_buckets WHERE virtual_at_ms<=${current - refilledBucketIdleMs} ORDER BY virtual_at_ms LIMIT ${receiptCleanupPageSize})`;
      yield* repairReceiptAlarm(current, storage);

      return { attempted: 0, failed: 0 };
    })
  );
});
