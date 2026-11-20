import type { MemoryRefusalOutcome } from "../../../src/shell/memory/contract";
import { Effect, Option, Schema } from "effect";
import { livePATAuthority } from "../../../src/shell/tokens/operations";
import { Memory, MemoryCapacityExceeded, MemoryId } from "../../../src/core/memory/contract";
import {
  MemoryCapacityExceededApi,
  type MemoryOperationId,
} from "../../../src/shell/memory/contract";
import { mapMemoryFailure, recordBrowserMemoryWork } from "../../../src/shell/memory/operations";
import { Unavailable } from "../../../src/shell/public-http/contract";
import { memoriesFromRows, memoryRowQuery } from "./storage";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  GuardRefusalWork,
  OwnerOutcome,
} from "../../canonical-operations/contract";
import { newId } from "../../secret-material/operations";
import {
  type TransactionCaller,
  callerAuthority,
  isHostedCaller,
  isOAuthCaller,
  isPATCaller,
  refusedCredentialResponse,
  transactionFailure,
  transactionNoStore,
} from "../../canonical-work/operations";

const HTTP_INVALID = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const HTTP_UNAVAILABLE = 503;

const memoryUnavailableMessage = "Memory is temporarily unavailable. Retry later.";
const memoryInvalidMessage = "Invalid Memory input.";
const memoryNotFoundMessage = "No current Memory with that identifier belongs to you.";

const jsonResponse = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: transactionNoStore });

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

const memoryCapacityExceeded = (): Response => {
  const failure = mapMemoryFailure(new MemoryCapacityExceeded());
  return jsonResponse(
    Schema.encodeSync(Schema.toCodecJson(MemoryCapacityExceededApi))(failure),
    HTTP_CONFLICT
  );
};

const memoryInvalid = (): Response =>
  transactionFailure({
    code: "validation_failed",
    status: HTTP_INVALID,
    message: memoryInvalidMessage,
  });

const memoryNotFound = (): Response =>
  transactionFailure({
    code: "not_found",
    status: HTTP_NOT_FOUND,
    message: memoryNotFoundMessage,
  });

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
  if (isOAuthCaller(subject) || isHostedCaller(subject)) {
    return prepareAuthorizedAuditCall({
      db,
      authority: callerAuthority({ subject, current }),
      id,
      operation,
      outcome: "rejected",
      current,
      afterOwnerWrite: false,
    });
  }
  if (isPATCaller(subject)) {
    const auditStatement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject, current }),
      input: { id, current, operation, outcome: "rejected", afterOwnerWrite: false },
    });
    return db.prepare(auditStatement.sql).bind(...auditStatement.params);
  }

  const auditStatement = recordBrowserMemoryWork({
    subject,
    input: { id, operation, outcome, afterMutation: false, current },
  });
  return db.prepare(auditStatement.sql).bind(...auditStatement.params);
};

const memoryRefusalMessage = (outcome: MemoryRefusalOutcome): string => {
  if (outcome === "resource_limit") {
    return mapMemoryFailure(new MemoryCapacityExceeded()).error.message;
  }
  if (outcome === "not_found") return memoryNotFoundMessage;
  return memoryInvalidMessage;
};

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
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) => {
    switch (disposition) {
      case "recorded":
        return Effect.succeed(memoryRejectionResponse(outcome));
      case "credential_refused":
        return refusedCredentialResponse({ db, subject });

      case "unavailable":
        return Effect.succeed(memoryUnavailable());
    }
  },
});

export const findOwnedMemory = ({
  db,
  userId,
  id,
}: Readonly<{ db: D1Database; userId: string; id: string }>): Effect.Effect<
  Option.Option<boolean>
> =>
  Effect.tryPromise(() =>
    db.prepare("SELECT 1 FROM memories WHERE user_id = ? AND id = ?").bind(userId, id).first()
  ).pipe(
    Effect.map((row) => Option.some(row !== null)),
    Effect.orElseSucceed(() => Option.none())
  );

export const findMemoryValue = ({
  db,
  userId,
  outcome,
}: Readonly<{ db: D1Database; userId: string; outcome: MemoryOutcome }>): Effect.Effect<
  Option.Option<CommittedMutationValue>
> =>
  outcome.operation === "memory.forget"
    ? Effect.succeedSome({
        _tag: "Owner" as const,
        payload: outcome.memoryId,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(MemoryId))(outcome.memoryId),
      })
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
              : Option.some({
                  _tag: "Owner" as const,
                  payload: memory,
                  encode: () => Schema.encodeEffect(Schema.toCodecJson(Memory))(memory),
                });
          })
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

export type MemoryOutcome = Readonly<{
  operation: "memory.remember" | "memory.revise" | "memory.forget";
  memoryId: MemoryId;
}>;

export const memoryOutcome = (outcome: MemoryOutcome): OwnerOutcome => ({
  _tag: "Owner",
  operation: outcome.operation,
  collisionKey: Option.some(`memory:${outcome.memoryId}`),
  guardFacts: Option.none(),
  read: (db, userId) => findMemoryValue({ db, userId, outcome }),
});
