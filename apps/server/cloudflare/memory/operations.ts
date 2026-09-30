import {
  Memory,
  type MemoryAuditOutcome,
  MemoryCapacityExceeded,
  MemoryCapacityExceededApi,
  MemoryId,
  type MemoryOperationId,
  type RememberInput,
  type ReviseInput,
  Unavailable,
} from "@fidy/server/memory-contract";
import {
  countAndAdmitMemory,
  countAndAdmitMemoryRevision,
  mapMemoryFailure,
  recordBrowserMemoryWork,
} from "@fidy/server/memory-operations";
import { recordCanonicalPATWork, recordLivePATUse } from "@fidy/server/tokens-operations";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { type HostedInference } from "@fidy/server/hosted-inference";
import type { AuthorizedPAT } from "../pats/operations";
import { prepareOwnedStatement } from "../atomic/operations";
import { dailyAuditExhausted } from "../atomic/daily-canonical-budget";
import { currentMillis, newId } from "../platform/operations";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionSubject,
  boundaryFailure,
  callerAuthority,
  callerScope,
  isPATCaller,
  liveTransactionAuthority,
  refusedCredentialResponse,
  transactionFailure,
  transactionNoStore,
} from "../transactions/transaction-boundary";
import {
  type CanonicalMutationPreparation,
  type MemoryOutcome,
  type PreparedCanonicalMutation,
  failedPreparation,
  refusedPreparation,
  unavailablePreparation,
} from "../mutations/mutation-types";
import {
  deleteMemory,
  insertMemory,
  memoriesFromRows,
  memoryCapacityGuards,
  memoryRowQuery,
  memoryRowsQuery,
  replaceMemory,
} from "./internal/persistence";
import type { MemoryAuthority } from "./contract";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  GuardRefusalWork,
} from "../mutations/mutation-types";

const HTTP_OK = 200;
const MemoryCodec = Schema.toCodecJson(Memory);

const memoryNow = (): number => currentMillis();
const memoryId = (): string => newId();

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

/**
 * Load current Memories for one explicit User's hosted context under live caller authority.
 * Returns None for a corrupt projection; no prose or persistence rows escape on failure.
 * This model-purpose read does not record a separate canonical call.
 */
export const readCurrentMemories = ({
  db,
  userId,
  authority,
}: Readonly<{
  db: D1Database;
  userId: string;
  authority: MemoryAuthority;
}>): Effect.Effect<Option.Option<ReadonlyArray<Memory>>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const query = memoryRowsQuery({ userId, authority });
    const rows = yield* Effect.tryPromise(() =>
      db
        .prepare(query.sql)
        .bind(...query.params)
        .all()
    );
    return memoriesFromRows(rows.results);
  });

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
  waitFor(() => dailyAuditExhausted({ db, userId: subject.userId, current }));

const admit = <A, Requirements>(
  decision: Effect.Effect<A, MemoryCapacityExceeded, Requirements>
): Effect.Effect<Option.Option<A>, never, Requirements> =>
  decision.pipe(
    Effect.asSome,
    Effect.catchTag("MemoryCapacityExceeded", () => Effect.succeedNone)
  );

/** The metadata-only success Audit one accepted Memory mutation commits with its owner write. */
const acceptedAudit = ({
  db,
  subject,
  operation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  current: number;
}>): D1PreparedStatement =>
  isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          subject,
          input: {
            id: memoryId(),
            current,
            operation,
            outcome: "accepted",
            afterOwnerWrite: true,
          },
        }),
      })
    : prepareOwnedStatement({
        db,
        statement: recordBrowserMemoryWork({
          subject,
          input: { id: memoryId(), operation, outcome: "success", afterMutation: true, current },
        }),
      });

/** The guarded writes one accepted Memory mutation commits, in order, before its assertion. */
const acceptedStatements = ({
  db,
  subject,
  operation,
  mutation,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  mutation: D1PreparedStatement;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(subject)
    ? [
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
        mutation,
        acceptedAudit({ db, subject, operation, current }),
      ]
    : [mutation, acceptedAudit({ db, subject, operation, current })];

/**
 * Decide one canonical `memory.remember` against live caller authority, the shared work budget, and
 * the complete aggregate capacity. The returned statements are guard-chained writes; the caller's
 * D1 unit commits them or none of them.
 */
export const prepareRemember = ({
  db,
  subject,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  payload: RememberInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation, never, HostedInference> =>
  Effect.gen(function* () {
    if (yield* budgetExhausted({ db, subject, current })) {
      return refusedPreparation(memoryBudgetRefusal());
    }
    const candidate = Memory.make({
      id: MemoryId.make(memoryId()),
      text: payload.text,
      createdAt: DateTime.makeUnsafe(current),
      updatedAt: DateTime.makeUnsafe(current),
    });
    const stored = yield* readMemories({ db, subject, current });
    if (Option.isNone(stored)) return unavailablePreparation();
    const admitted = yield* admit(countAndAdmitMemory(stored.value, candidate));
    if (Option.isNone(admitted)) {
      return refusedPreparation(
        memoryRefusal({
          db,
          subject,
          operation: "memory.remember",
          outcome: "resource_limit",
          current,
        })
      );
    }
    return {
      _tag: "Prepared",
      mutation: rememberMutation({ db, subject, candidate, current }),
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** The guarded insertion and its success AuditLogEntry for one admitted Memory. */
const rememberMutation = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): PreparedCanonicalMutation => {
  const outcome: MemoryOutcome = {
    _tag: "Memory",
    operation: "memory.remember",
    memoryId: candidate.id,
    candidate,
  };
  return {
    requiredScope: callerScope(subject),
    guardRefusal: memoryGuardRefusal(outcome),
    auditBudget: "shared",
    commitGuards: Option.some(memoryCapacityGuards(candidate)),
    outcome,
    statements: acceptedStatements({
      db,
      subject,
      operation: "memory.remember",
      mutation: insertMemory({
        db,
        authority: callerAuthority({ subject, current }),
        candidate,
      }),
      current,
    }),
  };
};

/** The guarded replacement write and its success AuditLogEntry for one admitted revision. */
const reviseMutation = ({
  db,
  subject,
  candidate,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  candidate: Memory;
  current: number;
}>): PreparedCanonicalMutation => {
  const outcome: MemoryOutcome = {
    _tag: "Memory",
    operation: "memory.revise",
    memoryId: candidate.id,
    candidate,
  };
  return {
    requiredScope: callerScope(subject),
    guardRefusal: memoryGuardRefusal(outcome),
    auditBudget: "shared",
    commitGuards: Option.some(memoryCapacityGuards(candidate)),
    outcome,
    statements: acceptedStatements({
      db,
      subject,
      operation: "memory.revise",
      mutation: replaceMemory({
        db,
        userId: subject.userId,
        authority: callerAuthority({ subject, current }),
        candidate,
      }),
      current,
    }),
  };
};

/**
 * Decide one canonical `memory.revise`: the addressed Memory must be current and the resulting
 * complete aggregate must fit the same capacity. The unit commits the replacement or nothing.
 */
export const prepareRevise = ({
  db,
  subject,
  id,
  payload,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: MemoryId;
  payload: ReviseInput;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation, never, HostedInference> =>
  Effect.gen(function* () {
    if (yield* budgetExhausted({ db, subject, current })) {
      return refusedPreparation(memoryBudgetRefusal());
    }
    const stored = yield* readMemories({ db, subject, current });
    if (Option.isNone(stored)) return unavailablePreparation();
    const previous = Option.fromUndefinedOr(stored.value.find((memory) => memory.id === id));
    if (Option.isNone(previous)) {
      return refusedPreparation(
        memoryRefusal({ db, subject, operation: "memory.revise", outcome: "not_found", current })
      );
    }
    const candidate = Memory.make({
      id: previous.value.id,
      text: payload.text,
      createdAt: previous.value.createdAt,
      updatedAt: DateTime.makeUnsafe(current),
    });
    const admitted = yield* admit(countAndAdmitMemoryRevision(stored.value, candidate));
    if (Option.isNone(admitted)) {
      return refusedPreparation(
        memoryRefusal({
          db,
          subject,
          operation: "memory.revise",
          outcome: "resource_limit",
          current,
        })
      );
    }
    return {
      _tag: "Prepared",
      mutation: reviseMutation({ db, subject, candidate, current }),
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/**
 * Decide one canonical `memory.forget`. An absent or foreign identifier changes no row, so the
 * owner assertion aborts the unit and the caller is classified rather than told which case it was.
 */
export const prepareForget = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: MemoryId;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (yield* budgetExhausted({ db, subject, current })) {
      return refusedPreparation(memoryBudgetRefusal());
    }
    const outcome: MemoryOutcome = { _tag: "Memory", operation: "memory.forget", memoryId: id };
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(subject),
        guardRefusal: memoryGuardRefusal(outcome),
        auditBudget: "shared",
        commitGuards: Option.none(),
        outcome,
        statements: acceptedStatements({
          db,
          subject,
          operation: "memory.forget",
          mutation: deleteMemory({
            db,
            userId: subject.userId,
            authority: callerAuthority({ subject, current }),
            id,
          }),
          current,
        }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Record one refused Memory mutation the Worker decided before dispatching protected work. */
export const rejectMemoryMutation = ({
  db,
  subject,
  operation,
  outcome,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  outcome: MemoryRefusalOutcome;
}>): Effect.Effect<Response> => {
  const refusal = memoryRefusal({ db, subject, operation, outcome, current: memoryNow() });
  return refusal.record().pipe(Effect.flatMap(refusal.respond));
};

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

/** Classify a recall unit whose read or live-authority audit row did not commit. */
const recallRefused = ({
  db,
  subject,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const live = yield* waitFor(() =>
      liveTransactionAuthority({ db, subject, current: memoryNow() })
    );
    return live ? memoryUnavailable() : yield* refusedCredentialResponse({ db, subject });
  });

/** The projection rows one committed recall unit returned, or None when its audit did not commit. */
const recallRows = (
  committed: ReadonlyArray<D1Result>,
  subject: TransactionCaller
): Option.Option<ReadonlyArray<unknown>> => {
  const rows = committed[isPATCaller(subject) ? 1 : 0];
  const audited = committed.at(-1);
  return rows === undefined || audited?.meta.changes !== 1
    ? Option.none()
    : Option.some(rows.results);
};

/** Read every current Memory of the caller and account for it in the same D1 unit. */
export const recallMemories = ({
  db,
  subject,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = memoryNow();
    if (yield* budgetExhausted({ db, subject, current })) return memoryRateLimited();
    const query = memoryRowsQuery({
      userId: subject.userId,
      authority: callerAuthority({ subject, current }),
    });
    const committed = yield* attempt(
      Effect.tryPromise({
        try: () =>
          db.batch([
            ...recallStatements({
              db,
              subject,
              current,
              statement: db.prepare(query.sql).bind(...query.params),
            }),
          ]),
        catch: boundaryFailure,
      })
    );
    if (committed._tag === "Failed") return memoryUnavailable();
    const records = recallRows(committed.value, subject);
    if (Option.isNone(records)) return yield* recallRefused({ db, subject });
    const memories = memoriesFromRows(records.value);
    if (Option.isNone(memories)) return memoryUnavailable();
    return jsonResponse(
      { data: memories.value.map((memory) => Schema.encodeSync(MemoryCodec)(memory)), next: [] },
      HTTP_OK
    );
  }).pipe(Effect.orElseSucceed(memoryUnavailable));

/**
 * The Memory audit outcomes one refusal can report: the owner's individual entry point and its
 * canonical refusal descriptor share this vocabulary.
 */
export type MemoryRefusalOutcome = Exclude<MemoryAuditOutcome, "success">;

const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_RATE_LIMITED = 429;
const HTTP_UNAVAILABLE = 503;

const memoryUnavailableMessage = "Memory is temporarily unavailable. Retry later.";
const memoryInvalidMessage = "Invalid Memory input.";
const memoryNotFoundMessage = "No current Memory with that identifier belongs to you.";
const memoryBudgetMessage = "Memory work budget exhausted. Retry after the current UTC day.";

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: transactionNoStore });
/** The declared content-free failure when authoritative Memory storage cannot answer. */
export const memoryUnavailable = (): Response => {
  const failure = Unavailable.make({
    error: { code: "unavailable", message: memoryUnavailableMessage },
    next: [],
  });
  return jsonResponse(
    Schema.encodeSync(Schema.toCodecJson(Unavailable))(failure),
    HTTP_UNAVAILABLE
  );
};
/** The declared quota failure, encoded from its own canonical declaration and never from prose. */
const memoryCapacityExceeded = (): Response => {
  const failure = mapMemoryFailure(new MemoryCapacityExceeded());
  return jsonResponse(
    Schema.encodeSync(Schema.toCodecJson(MemoryCapacityExceededApi))(failure),
    HTTP_CONFLICT
  );
};
/** The declared validation failure for one Memory input that failed its published schema. */
const memoryInvalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: HTTP_INVALID,
    message: memoryInvalidMessage,
  });
/** The declared absent-or-foreign failure for one addressed Memory identity. */
const memoryNotFound = (): Response =>
  transactionFailure({
    code: "not_found",
    status: HTTP_NOT_FOUND,
    message: memoryNotFoundMessage,
  });
/** The declared budget failure for one Memory call the shared work budget refused. */
export const memoryRateLimited = (): Response =>
  transactionFailure({
    code: "rate_limited",
    status: HTTP_RATE_LIMITED,
    message: memoryBudgetMessage,
  });

/** The canonical individual response for one decided Memory refusal outcome. */
const memoryRejectionResponse = (outcome: MemoryRefusalOutcome): Response => {
  switch (outcome) {
    case "not_found":
      return memoryNotFound();
    case "validation_failed":
      return memoryInvalid();
    case "resource_limit":
      return memoryCapacityExceeded();
  }
};

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
  outcome: MemoryRefusalOutcome;
  current: number;
}>): D1PreparedStatement => {
  const id = newId();
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

/** The caller-facing message one decided Memory refusal outcome reports. */
const memoryRefusalMessage = (outcome: MemoryRefusalOutcome): string => {
  if (outcome === "resource_limit") {
    return mapMemoryFailure(new MemoryCapacityExceeded()).error.message;
  }
  if (outcome === "not_found") return memoryNotFoundMessage;
  return memoryInvalidMessage;
};

/** Classify an indexed Memory guard abort; its returned refusal records evidence when invoked. */
const memoryGuardRefusal =
  (outcome: MemoryOutcome) =>
  ({ db, subject, current, kind }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const operation = outcome.operation;
    if (kind === "capacity") {
      return Effect.succeed(
        memoryRefusal({
          db,
          subject,
          current,
          operation,
          outcome: "resource_limit",
        })
      );
    }
    const generic = memoryRefusal({
      db,
      subject,
      current,
      operation,
      outcome: "validation_failed",
    });
    if (operation === "memory.remember") {
      return Effect.succeed(generic);
    }
    return findOwnedMemory({ db, userId: subject.userId, id: outcome.memoryId }).pipe(
      Effect.map((owns) =>
        Option.match(owns, {
          onNone: () => generic,
          onSome: (owned) =>
            owned
              ? generic
              : memoryRefusal({
                  db,
                  subject,
                  current,
                  operation,
                  outcome: "not_found",
                }),
        })
      )
    );
  };

/** Record one metadata-only Memory refusal under its child authority and render its response. */
export const memoryRefusal = ({
  db,
  subject,
  operation,
  outcome,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: MemoryOperationId;
  outcome: MemoryRefusalOutcome;
  current: number;
}>): CanonicalMutationRefusal => ({
  code: outcome === "resource_limit" ? "quota_exhausted" : outcome,
  message: memoryRefusalMessage(outcome),
  record: () =>
    Effect.tryPromise(() =>
      rejectionStatement({ db, subject, operation, outcome, current }).run()
    ).pipe(
      Effect.map((audited) =>
        audited.meta.changes === 1 ? ("recorded" as const) : ("credential_refused" as const)
      ),
      Effect.catch((cause) =>
        Effect.succeed(
          refusedByAuditBudget(cause) ? ("rate_limited" as const) : ("unavailable" as const)
        )
      )
    ),
  respond: (disposition) => {
    switch (disposition) {
      case "recorded":
        return Effect.succeed(memoryRejectionResponse(outcome));
      case "credential_refused":
        return refusedCredentialResponse({ db, subject });
      case "rate_limited":
        return Effect.succeed(memoryRateLimited());
      case "unavailable":
        return Effect.succeed(memoryUnavailable());
    }
  },
});

/**
 * The refusal a Memory child reports when the shared daily audit budget, not the child, refused its
 * unit. The batch answers `rate_limited` without a row and the individual entry point answers its
 * own Memory budget failure, exactly as its pre-check does.
 */
export const memoryBudgetRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: memoryBudgetMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(memoryRateLimited()),
});

/**
 * True while the caller owns the named Memory row, or None when the read cannot decide — the same
 * "cannot decide" answer `findExistingCategory` gives, never a guessed `false` that would blame
 * the child with `not_found`.
 */
const findOwnedMemory = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
}>): Effect.Effect<Option.Option<boolean>> =>
  Effect.tryPromise(() =>
    db.prepare("SELECT 1 FROM memories WHERE user_id = ? AND id = ?").bind(userId, id).first()
  ).pipe(
    Effect.map((row) => Option.some(row !== null)),
    Effect.orElseSucceed(() => Option.none())
  );

/**
 * Read one committed Memory child's canonical value: the stored row for a remember or revise, and
 * the removed id for a forget whose row the unit already proved gone. The stored read reuses the
 * owner's published single-row projection; the guarded write and its completion assertion already
 * proved the caller's authority, so the readback stays unguarded.
 */
export const findMemoryValue = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: MemoryOutcome;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  outcome.operation === "memory.forget"
    ? Effect.succeedSome({ _tag: "RemovedMemory" as const, id: outcome.memoryId })
    : Effect.tryPromise(() => {
        const query = memoryRowQuery({ userId, id: outcome.memoryId });
        return db
          .prepare(query.sql)
          .bind(...query.params)
          .all();
      }).pipe(
        Effect.map((rows) =>
          Option.flatMap(memoriesFromRows(rows.results), (memories) => {
            const memory = memories.find((value) => value.id === outcome.memoryId);
            return memory === undefined
              ? Option.none<CommittedMutationValue>()
              : Option.some({ _tag: "Memory" as const, memory });
          })
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );
