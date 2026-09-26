import { Effect, Option, Schema } from "effect";
import {
  type MemoryAuditOutcome,
  MemoryCapacityExceeded,
  MemoryCapacityExceededApi,
  type MemoryOperationId,
  Unavailable,
  mapMemoryFailure,
  memoriesFromRows,
  memoryRowQuery,
  recordBrowserMemoryWork,
} from "@fidy/server/memory-runtime";
import { recordCanonicalPATWork } from "@fidy/server/tokens-runtime";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  GuardRefusalWork,
  MemoryOutcome,
} from "./mutation-types";
import { newId } from "../pats/pat-shared";
import { refusedByAuditBudget } from "../audit/audit-triggers";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionCaller,
  isPATCaller,
  refusedCredentialResponse,
  transactionFailure,
  transactionNoStore,
} from "../transactions/transaction-boundary";

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
export const memoryGuardRefusal =
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
export const findOwnedMemory = ({
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
