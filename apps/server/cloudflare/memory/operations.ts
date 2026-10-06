import type { MemoryRefusalOutcome } from "../../src/shell/memory/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import {
  Memory,
  type MemoryCapacityExceeded,
  MemoryId,
  type RememberInput,
  type ReviseInput,
} from "../../src/core/memory/contract";
import { type MemoryOperationId } from "../../src/shell/memory/contract";
import {
  countAndAdmitMemory,
  countAndAdmitMemoryRevision,
  recordBrowserMemoryWork,
} from "../../src/shell/memory/operations";
import {
  deleteMemory,
  insertMemory,
  memoriesFromRows,
  memoryCapacityGuards,
  memoryRowsQuery,
  readCurrentMemories,
  replaceMemory,
} from "./internal/storage";
import {
  dailyAuditExhausted,
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  recordOAuthCall,
} from "../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../src/shell/tokens/operations";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { type HostedInference } from "../../src/shell/hosted-inference/operations";
import type { AuthorizedPAT } from "../tokens/contract";
import { prepareOwnedStatement } from "../database/operations";
import { newId } from "../secret-material/operations";
import {
  type QueryCaller,
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionSubject,
  boundaryFailure,
  callerAuthority,
  callerScope,
  failedPreparation,
  isOAuthCaller,
  isPATCaller,
  liveTransactionAuthority,
  refusedCredentialResponse,
  refusedPreparation,
  transactionNoStore,
  unavailablePreparation,
} from "../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type PreparedCanonicalMutation,
} from "../canonical-operations/contract";

import {
  type MemoryOutcome,
  memoryBudgetRefusal,
  memoryGuardRefusal,
  memoryOutcome,
  memoryRateLimited,
  memoryRefusal,
  memoryUnavailable,
} from "./internal/outcome";

const HTTP_OK = 200;
const MemoryCodec = Schema.toCodecJson(Memory);

const memoryId = (): string => newId();

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: transactionNoStore });

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

const memoryAuthorityQuery = (input: Parameters<typeof callerAuthority>[0]): OwnedStatement => {
  const authority = callerAuthority(input);
  return {
    sql: `SELECT user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
    params: authority.bindings,
  };
};

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
      authority: memoryAuthorityQuery({ subject, current }),
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
  subject: QueryCaller;
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
}>): D1PreparedStatement => {
  if (isOAuthCaller(subject)) {
    return prepareAuthorizedAuditCall({
      db,
      authority: callerAuthority({ subject, current }),
      id: memoryId(),
      operation,
      outcome: "accepted",
      current,
      afterOwnerWrite: true,
    });
  }
  return isPATCaller(subject)
    ? prepareOwnedStatement({
        db,
        statement: recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
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
};

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
    const outcome: MemoryOutcome = {
      operation: "memory.remember",
      memoryId: candidate.id,
    };
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(subject),
        guardRefusal: memoryGuardRefusal(outcome),
        auditBudget: "shared",
        commitGuards: Option.some(memoryCapacityGuards(candidate)),
        outcome: memoryOutcome(outcome),
        statements: acceptedStatements({
          db,
          subject,
          operation: "memory.remember",
          mutation: insertMemory({ db, subject, candidate, current }),
          current,
        }),
      },
    } as const;
  }).pipe(Effect.orElseSucceed(failedPreparation));

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
    operation: "memory.revise",
    memoryId: candidate.id,
  };
  return {
    requiredScope: callerScope(subject),
    guardRefusal: memoryGuardRefusal(outcome),
    auditBudget: "shared",
    commitGuards: Option.some(memoryCapacityGuards(candidate)),
    outcome: memoryOutcome(outcome),
    statements: acceptedStatements({
      db,
      subject,
      operation: "memory.revise",
      mutation: replaceMemory({ db, subject, candidate, current }),
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
    const outcome: MemoryOutcome = { operation: "memory.forget", memoryId: id };
    return {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(subject),
        guardRefusal: memoryGuardRefusal(outcome),
        auditBudget: "shared",
        commitGuards: Option.none(),
        outcome: memoryOutcome(outcome),
        statements: acceptedStatements({
          db,
          subject,
          operation: "memory.forget",
          mutation: deleteMemory({ db, subject, id, current }),
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
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const refusal = memoryRefusal({ db, subject, operation, outcome, current });
    return yield* refusal.record().pipe(Effect.flatMap(refusal.respond));
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
      authority: livePATAuthority({ subject, current }),
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
  subject: QueryCaller;
  current: number;
  statement: D1PreparedStatement;
}>): ReadonlyArray<D1PreparedStatement> => {
  if (isOAuthCaller(subject)) {
    return [
      statement,
      prepareOwnedStatement({
        db,
        statement: recordOAuthCall({
          authority: callerAuthority({ subject, current }),
          id: memoryId(),
          current,
          operation: "memory.recall",
          outcome: "accepted",
        }),
      }),
    ];
  }
  return isPATCaller(subject)
    ? [
        prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) }),
        statement,
        patRecallAudit({ db, subject, current }),
      ]
    : [statement, browserRecallAudit({ db, subject, current })];
};

/** Classify a recall unit whose read or live-authority audit row did not commit. */
const recallRefused = ({
  db,
  subject,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
}>): Effect.Effect<Response, TransactionBoundaryFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const live = yield* waitFor(() => liveTransactionAuthority({ db, subject, current }));
    return live ? memoryUnavailable() : yield* refusedCredentialResponse({ db, subject });
  });

/** The projection rows one committed recall unit returned, or None when its audit did not commit. */
const recallRows = (
  committed: ReadonlyArray<D1Result>,
  subject: QueryCaller
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
  subject: QueryCaller;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (yield* budgetExhausted({ db, subject, current })) return memoryRateLimited();
    const query = memoryRowsQuery({
      userId: subject.userId,
      authority: memoryAuthorityQuery({ subject, current }),
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
 * Load only current Memory prose for one explicitly authorized hosted context. The supplied live
 * authority must project semantic userId; it is correlated again to the requested User. A borrowed
 * subject returns no prose and a malformed aggregate is unavailable, never partially decoded.
 * Admission owns the Consent timing for the Turn; this read grants no new model or tool authority.
 */
export const readMemoryContext = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    authority: OwnedStatement;
  }>
): Effect.Effect<Option.Option<ReadonlyArray<Pick<Memory, "text">>>> =>
  readCurrentMemories(input).pipe(
    Effect.map(Option.map((memories) => memories.map(({ text }) => ({ text }))))
  );

/** Prepare metadata-only refusal evidence for an invalid canonical Memory input. */
export const invalidMemoryInput = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    operation: MemoryOperationId;
    current: number;
  }>
): CanonicalMutationRefusal => memoryRefusal({ ...input, outcome: "validation_failed" });
