import {
  Memory,
  MemoryCapacityExceeded,
  MemoryCapacityExceededApi,
  MemoryId,
  RememberInput,
  ReviseInput,
  Unavailable,
  countAndAdmitMemory,
  countAndAdmitMemoryRevision,
  mapMemoryFailure,
  memoriesFromRows,
  memoryCompletion,
  memoryOperationIds,
  memoryRowsQuery,
  recordBrowserMemoryWork,
} from "@fidy/server/memory-runtime";
import type { MemoryAuditOutcome, MemoryOperationId } from "@fidy/server/memory-runtime";
import type { HostedInference } from "@fidy/server/hosted-inference";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import type { AuthorizedPAT } from "../pats/pat-authorization";
import { commitPATUnit, prepareOwnedStatement } from "../pats/pat-unit";
import { currentMillis, newId } from "../pats/pat-shared";
import { RequestBodyPolicy, boundedJsonBody } from "../http/request-body";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionSubject,
  boundaryFailure,
  callerAuthority,
  isPATCaller,
  liveTransactionAuthority,
  refusedCredentialResponse,
  transactionAuditExhausted,
  transactionFailure,
  transactionNoStore,
} from "../transactions/transaction-boundary";

/** Recognizes one implemented canonical Memory operation without a parallel route registry. */
export const isMemoryOperationId = (id: string): id is MemoryOperationId =>
  memoryOperationIds.some((operation) => operation === id);

const Remember = Schema.toCodecJson(RememberInput);
const Revision = Schema.toCodecJson(ReviseInput);
const Output = Schema.toCodecJson(Memory);
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_RATE_LIMITED = 429;
const HTTP_UNAVAILABLE = 503;

const memoryNow = (): number => currentMillis();
const memoryId = (): string => newId();
const memoryPathLastSegment = (request: Request): string =>
  new URL(request.url).pathname.split("/").at(-1) ?? "";

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: transactionNoStore });
const invalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: HTTP_INVALID,
    message: "Invalid Memory input.",
  });
const notFound = (): Response =>
  transactionFailure({
    code: "not_found",
    status: HTTP_NOT_FOUND,
    message: "No current Memory with that identifier belongs to you.",
  });
const rateLimited = (): Response =>
  transactionFailure({
    code: "rate_limited",
    status: HTTP_RATE_LIMITED,
    message: "Memory work budget exhausted. Retry after the current UTC day.",
  });
/** The declared content-free failure when authoritative Memory storage cannot answer. */
const unavailable = (): Response => {
  const failure = Unavailable.make({
    error: { code: "unavailable", message: "Memory is temporarily unavailable. Retry later." },
    next: [],
  });
  const encoded = Schema.encodeSync(Schema.toCodecJson(Unavailable))(failure);
  return jsonResponse(encoded, HTTP_UNAVAILABLE);
};
/** The declared quota failure, encoded from its own canonical declaration and never from prose. */
const capacityExceeded = (): Response => {
  const failure = mapMemoryFailure(new MemoryCapacityExceeded());
  const encoded = Schema.encodeSync(Schema.toCodecJson(MemoryCapacityExceededApi))(failure);
  return jsonResponse(encoded, HTTP_CONFLICT);
};
const rejected = (outcome: Rejection): Response => {
  switch (outcome) {
    case "not_found":
      return notFound();
    case "validation_failed":
      return invalid();
    case "resource_limit":
      return capacityExceeded();
  }
};

const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, TransactionBoundaryFailure> =>
  Effect.tryPromise({ try: run, catch: boundaryFailure });
const attempt = <A>(
  effect: Effect.Effect<A, TransactionBoundaryFailure>
): Effect.Effect<
  Readonly<{ _tag: "Failed"; cause: unknown }> | Readonly<{ _tag: "Ok"; value: A }>
> =>
  Effect.match(effect, {
    onFailure: (error) => ({ _tag: "Failed" as const, cause: error.cause }),
    onSuccess: (value) => ({ _tag: "Ok" as const, value }),
  });

type Rejection = Exclude<MemoryAuditOutcome, "success">;

/** Decode one bounded Memory write body; malformed, oversized, and untrimmed prose never reach D1. */
const readMemories = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<Option.Option<ReadonlyArray<Memory>>, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const query = memoryRowsQuery({
      userId: subject.userId,
      authority: callerAuthority({ subject, current }),
    });
    const rows = yield* waitFor(() =>
      db
        .prepare(query.sql)
        .bind(...query.params)
        .all()
    );
    return memoriesFromRows(rows.results);
  });

const ownsMemory = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
}>): Effect.Effect<boolean, TransactionBoundaryFailure> =>
  waitFor(() =>
    db.prepare("SELECT 1 FROM memories WHERE user_id = ? AND id = ?").bind(userId, id).first()
  ).pipe(Effect.map((row) => row !== null));

/** True while the caller's shared stable-User canonical work budget is already spent. */
const budgetExhausted = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<boolean, TransactionBoundaryFailure> =>
  waitFor(() => transactionAuditExhausted({ db, userId: subject.userId, current }));

/** Report a lost credential truthfully after the protected D1 unit refused the work. */
const classifyAuthority = ({
  db,
  subject,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  waitFor(() => liveTransactionAuthority({ db, subject, current: memoryNow() })).pipe(
    Effect.flatMap((live) =>
      live ? Effect.succeed(unavailable()) : refusedCredentialResponse({ db, subject })
    )
  );

/** True when the shared stable-User canonical work budget refused the write. */
const limitedByBudget = (cause: unknown): boolean =>
  String(cause).includes("transaction_audit_limit");

/** Map a refused Memory Audit write to the cause the caller is told about. */
const refusalFromCause = (cause: unknown): Response =>
  limitedByBudget(cause) ? rateLimited() : unavailable();

const rejectionStatement = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  outcome: Rejection;
  current: number;
}>): D1PreparedStatement => {
  const id = memoryId();
  return isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: { id, current, operation, outcome: "rejected", afterOwnerWrite: false },
        }),
      })
    : prepareOwnedStatement({
        db,
        statement: recordBrowserMemoryWork({
          subject,
          input: { id, operation, outcome, afterMutation: false, current },
        }),
      });
};

/** Record one hard refusal under live authority, then answer it. Nothing partial is committed. */
const rejectMemory = ({
  db,
  subject,
  operation,
  outcome,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  outcome: Rejection;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const audited = yield* attempt(
      waitFor(() =>
        rejectionStatement({ db, subject, operation, outcome, current: memoryNow() }).run()
      )
    );
    if (audited._tag === "Failed") return refusalFromCause(audited.cause);
    if (audited.value.meta.changes !== 1) return yield* refusedCredentialResponse({ db, subject });
    return rejected(outcome);
  });

/** The preceding owner mutation and its metadata-only audit commit in one guarded D1 unit. */
const acceptedStatements = ({
  db,
  subject,
  operation,
  afterMutation,
  mutation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  afterMutation: boolean;
  mutation: D1PreparedStatement;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  const audit = isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: memoryId(),
            current,
            operation,
            outcome: "accepted",
            afterOwnerWrite: afterMutation,
          },
        }),
      })
    : prepareOwnedStatement({
        db,
        statement: recordBrowserMemoryWork({
          subject,
          input: { id: memoryId(), operation, outcome: "success", afterMutation, current },
        }),
      });
  return isPATCaller(subject)
    ? [
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
        mutation,
        audit,
      ]
    : [mutation, audit, db.prepare(memoryCompletion)];
};

const commit = ({
  db,
  subject,
  statements,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  statements: ReadonlyArray<D1PreparedStatement>;
}>): Effect.Effect<ReadonlyArray<D1Result>, TransactionBoundaryFailure> =>
  isPATCaller(subject)
    ? waitFor(() => commitPATUnit({ db, statements }))
    : waitFor(() => db.batch([...statements]));

const insertMemory = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`INSERT INTO memories (id, user_id, text, created_at, updated_at)
      SELECT ?, user_id, ?, ?, ? FROM ${authority.table} WHERE ${authority.predicate}`)
    .bind(
      candidate.id,
      candidate.text,
      DateTime.formatIso(candidate.createdAt),
      DateTime.formatIso(candidate.updatedAt),
      ...authority.bindings
    );
};

const replaceMemory = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`UPDATE memories SET text = ?, updated_at = ? WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      candidate.text,
      DateTime.formatIso(candidate.updatedAt),
      subject.userId,
      candidate.id,
      ...authority.bindings
    );
};

const deleteMemory = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  current: number;
}>): D1PreparedStatement => {
  const authority = callerAuthority({ subject, current });
  return db
    .prepare(`DELETE FROM memories WHERE user_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(subject.userId, id, ...authority.bindings);
};

/** Answer a refused mutation without inventing state: budget, capacity, absence, then authority. */
const refusalForMutation = ({
  db,
  subject,
  operation,
  cause,
  memoryId: candidateId,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  cause: unknown;
  memoryId: Option.Option<string>;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    if (limitedByBudget(cause)) return rateLimited();
    if (String(cause).includes("memory_capacity_exceeded")) {
      return yield* rejectMemory({ db, subject, operation, outcome: "resource_limit" });
    }
    if (
      Option.isSome(candidateId) &&
      !(yield* ownsMemory({ db, userId: subject.userId, id: candidateId.value }))
    ) {
      return yield* rejectMemory({ db, subject, operation, outcome: "not_found" });
    }
    return yield* classifyAuthority({ db, subject });
  });

/** The Mutation committed, or its refusal has already been decided and audited. */
type MutationOutcome =
  | Readonly<{ _tag: "Committed" }>
  | Readonly<{ _tag: "Refused"; response: Response }>;

/** Run one guarded mutation batch and classify every reason it could not commit. */
const commitMutation = ({
  db,
  subject,
  operation,
  afterMutation,
  mutation,
  memoryId: candidateId,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  afterMutation: boolean;
  mutation: D1PreparedStatement;
  memoryId: Option.Option<string>;
  current: number;
}>): Effect.Effect<MutationOutcome, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const committed = yield* attempt(
      commit({
        db,
        subject,
        statements: acceptedStatements({
          db,
          subject,
          operation,
          afterMutation,
          mutation,
          current,
        }),
      })
    );
    if (committed._tag === "Failed") {
      return {
        _tag: "Refused",
        response: yield* refusalForMutation({
          db,
          subject,
          operation,
          cause: committed.cause,
          memoryId: candidateId,
        }),
      };
    }
    if (committed.value.some((result) => result.meta.changes !== 1)) {
      return { _tag: "Refused", response: yield* classifyAuthority({ db, subject }) };
    }
    return { _tag: "Committed" };
  });

const encodeMemory = (memory: Memory): unknown => Schema.encodeSync(Output)(memory);
const admit = <A, Requirements>(
  decision: Effect.Effect<A, MemoryCapacityExceeded, Requirements>
): Effect.Effect<Option.Option<A>, never, Requirements> =>
  decision.pipe(
    Effect.asSome,
    Effect.catchTag("MemoryCapacityExceeded", () => Effect.succeedNone)
  );

/** Retain one formatting-normalized Memory for the caller after counting the complete aggregate. */
const remember = ({
  db,
  subject,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  payload: typeof Remember.Type;
}>): Effect.Effect<Response, TransactionBoundaryFailure, HostedInference> =>
  Effect.gen(function* () {
    const current = memoryNow();
    if (yield* budgetExhausted({ db, subject, current })) return rateLimited();
    const candidate = Memory.make({
      id: MemoryId.make(memoryId()),
      text: payload.text,
      createdAt: DateTime.makeUnsafe(current),
      updatedAt: DateTime.makeUnsafe(current),
    });
    const stored = yield* readMemories({ db, subject, current });
    if (Option.isNone(stored)) return unavailable();
    const admitted = yield* admit(countAndAdmitMemory(stored.value, candidate));
    if (Option.isNone(admitted)) {
      return yield* rejectMemory({
        db,
        subject,
        operation: "memory.remember",
        outcome: "resource_limit",
      });
    }
    const committed = yield* commitMutation({
      db,
      subject,
      operation: "memory.remember",
      afterMutation: true,
      mutation: insertMemory({ db, subject, candidate, current }),
      memoryId: Option.none(),
      current,
    });
    if (committed._tag === "Refused") return committed.response;
    return jsonResponse({ data: encodeMemory(candidate), next: [] }, HTTP_CREATED);
  });

/** Replace one current Memory's prose in place, preserving identity and creation order. */
const revise = ({
  db,
  subject,
  id,
  payload,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  payload: typeof Revision.Type;
}>): Effect.Effect<Response, TransactionBoundaryFailure, HostedInference> =>
  Effect.gen(function* () {
    const current = memoryNow();
    if (yield* budgetExhausted({ db, subject, current })) return rateLimited();
    const stored = yield* readMemories({ db, subject, current });
    if (Option.isNone(stored)) return unavailable();
    const previous = Option.fromUndefinedOr(stored.value.find((memory) => memory.id === id));
    if (Option.isNone(previous)) {
      return yield* rejectMemory({
        db,
        subject,
        operation: "memory.revise",
        outcome: "not_found",
      });
    }
    const candidate = Memory.make({
      id: previous.value.id,
      text: payload.text,
      createdAt: previous.value.createdAt,
      updatedAt: DateTime.makeUnsafe(current),
    });
    const admitted = yield* admit(countAndAdmitMemoryRevision(stored.value, candidate));
    if (Option.isNone(admitted)) {
      return yield* rejectMemory({
        db,
        subject,
        operation: "memory.revise",
        outcome: "resource_limit",
      });
    }
    const committed = yield* commitMutation({
      db,
      subject,
      operation: "memory.revise",
      afterMutation: true,
      mutation: replaceMemory({ db, subject, candidate, current }),
      memoryId: Option.some(id),
      current,
    });
    if (committed._tag === "Refused") return committed.response;
    return jsonResponse({ data: encodeMemory(candidate), next: [] }, HTTP_OK);
  });

/** Physically remove one current Memory belonging to the caller. Absent and foreign look identical. */
const forget = ({
  db,
  subject,
  id,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const current = memoryNow();
    if (yield* budgetExhausted({ db, subject, current })) return rateLimited();
    const committed = yield* commitMutation({
      db,
      subject,
      operation: "memory.forget",
      afterMutation: true,
      mutation: deleteMemory({ db, subject, id, current }),
      memoryId: Option.some(id),
      current,
    });
    if (committed._tag === "Refused") return committed.response;
    return jsonResponse({ data: id, next: [] }, HTTP_OK);
  });

const browserRecallAudit = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  current: number;
}>): D1PreparedStatement =>
  prepareOwnedStatement({
    db,
    statement: recordBrowserMemoryWork({
      subject,
      input: {
        id: memoryId(),
        operation: "memory.recall",
        outcome: "success",
        afterMutation: false,
        current,
      },
    }),
  });

const patRecallAudit = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: AuthorizedPAT;
  current: number;
}>): D1PreparedStatement =>
  prepareOwnedStatement({
    db,
    statement: recordCanonicalPATWork({
      subject,
      input: {
        id: memoryId(),
        current,
        operation: "memory.recall",
        outcome: "accepted",
        afterOwnerWrite: false,
      },
    }),
  });

const recallStatements = ({
  db,
  subject,
  current,
  statement,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  statement: D1PreparedStatement;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(subject)
    ? [
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
        statement,
        patRecallAudit({ db, subject, current }),
      ]
    : [statement, browserRecallAudit({ db, subject, current })];

/** Read every current Memory of the caller and account for it in the same D1 unit. */
const recall = ({
  db,
  subject,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const current = memoryNow();
    if (yield* budgetExhausted({ db, subject, current })) return rateLimited();
    const query = memoryRowsQuery({
      userId: subject.userId,
      authority: callerAuthority({ subject, current }),
    });
    const committed = yield* attempt(
      commit({
        db,
        subject,
        statements: recallStatements({
          db,
          subject,
          current,
          statement: db.prepare(query.sql).bind(...query.params),
        }),
      })
    );
    if (committed._tag === "Failed") return refusalFromCause(committed.cause);
    const rows = committed.value[isPATCaller(subject) ? 1 : 0];
    const audited = committed.value.at(-1);
    if (rows === undefined || audited?.meta.changes !== 1) {
      return yield* classifyAuthority({ db, subject });
    }
    const memories = memoriesFromRows(rows.results);
    if (Option.isNone(memories)) return unavailable();
    return jsonResponse({ data: memories.value.map(encodeMemory), next: [] }, HTTP_OK);
  });

const mutationResponse = ({
  db,
  subject,
  operation,
  request,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  request: Request;
}>): Effect.Effect<Response, TransactionBoundaryFailure, HostedInference> =>
  Effect.gen(function* () {
    const payload = yield* waitFor(() =>
      operation === "memory.remember"
        ? boundedJsonBody(request, bodyPolicy, Remember)
        : boundedJsonBody(request, bodyPolicy, Revision)
    );
    if (Option.isNone(payload)) {
      return yield* rejectMemory({ db, subject, operation, outcome: "validation_failed" });
    }
    if (operation === "memory.remember") {
      return yield* remember({ db, subject, payload: payload.value });
    }
    const id = memoryPathLastSegment(request);
    if (!Schema.is(MemoryId)(id)) {
      return yield* rejectMemory({
        db,
        subject,
        operation: "memory.revise",
        outcome: "validation_failed",
      });
    }
    return yield* revise({ db, subject, id, payload: payload.value });
  });

const removalResponse = ({
  db,
  subject,
  request,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  request: Request;
}>): Effect.Effect<Response, TransactionBoundaryFailure> => {
  const id = memoryPathLastSegment(request);
  return Schema.is(MemoryId)(id)
    ? forget({ db, subject, id })
    : rejectMemory({ db, subject, operation: "memory.forget", outcome: "validation_failed" });
};

/** Execute one declared Memory operation under the caller's already-resolved canonical authority. */
export const executeMemoryOperation = ({
  request,
  db,
  subject,
  operation,
}: Readonly<{
  request: Request;
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
}>): Effect.Effect<Response, never, HostedInference> =>
  Effect.gen(function* () {
    if (operation === "memory.recall") return yield* recall({ db, subject });
    if (operation === "memory.forget") return yield* removalResponse({ db, subject, request });
    return yield* mutationResponse({ db, subject, operation, request });
  }).pipe(Effect.orElseSucceed(unavailable));
