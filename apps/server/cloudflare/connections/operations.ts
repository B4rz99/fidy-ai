import { ConnectionInstitutions } from "../../src/shell/connections/contract";
import {
  institutionsForUser,
  registeredInstitutionPredicate,
} from "./internal/institution-registration";
import {
  ConnectionBrowserAdmission,
  ConnectionCallbackAdmission,
  ConnectionRetentionUnavailable,
} from "./contract";
import { completeAuthorization } from "./internal/activation";
import { browseAccounts } from "./internal/accounts";
import { beginContinuation } from "./internal/browser";
import { initiationStatements, readInitiationResult } from "./internal/initiation";
import { type Crypto, Effect, Option, Schema } from "effect";
import {
  ConnectInstitutionInput,
  Connection,
  ConnectionId,
  InstitutionId,
  InstitutionSummary,
} from "../../src/core/connections/contract";
import {
  prepareAuditQueryCall,
  prepareAuthorizedAuditCall,
} from "../../src/shell/audit/operations";
import { recordLivePATUse } from "../../src/shell/tokens/operations";
import { commitPATUnit } from "../tokens/operations";
import {
  type QueryCaller,
  type TransactionAuthority,
  callerAuthority,
  callerScope,
  isPATCaller,
  refusedCredentialResponse,
  transactionFailure,
  transactionId,
  transactionNoStore,
  transactionNow,
  transactionUnavailable,
} from "../canonical-work/operations";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CanonicalPreparationWork,
} from "../canonical-operations/contract";
import type { ConnectionQueryOperation } from "./contract";

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const operation = "connections.connectInstitution";

/** Decide and audit an initiation refusal under the caller's live authority. */
export const connectionInputRefusal = ({
  work,
  code,
}: Readonly<{
  work: CanonicalPreparationWork;
  code: "not_found" | "validation_failed";
}>): CanonicalMutationRefusal => ({
  code,
  message: "Institution unavailable.",
  record: () =>
    Effect.tryPromise(() =>
      commitPATUnit({
        db: work.db,
        statements: [
          ...(isPATCaller(work.subject)
            ? [recordLivePATUse({ subject: work.subject, current: work.current })].map(
                ({ sql, params }) => work.db.prepare(sql).bind(...params)
              )
            : []),
          prepareAuthorizedAuditCall({
            db: work.db,
            authority: callerAuthority(work),
            id: transactionId(),
            operation,
            current: work.current,
            outcome: "rejected",
            afterOwnerWrite: false,
          }),
        ],
      })
    ).pipe(
      Effect.as("recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    disposition === "credential_refused"
      ? refusedCredentialResponse(work)
      : Effect.succeed(
          disposition === "recorded"
            ? transactionFailure({
                code,
                status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
                message: "Institution unavailable.",
              })
            : transactionUnavailable()
        ),
});

/** Prepare a stable Connection and short-lived browser attempt inside the shared canonical unit. */
export const prepareConnectInstitution = (
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const institutions = yield* institutionsForUser(work.subject.userId);
    const input = Schema.decodeUnknownOption(Schema.Struct({ payload: ConnectInstitutionInput }))(
      work.input
    );
    if (Option.isNone(input)) {
      return {
        _tag: "Refused",
        refusal: connectionInputRefusal({ work, code: "validation_failed" }),
      } as const;
    }
    if (input.value.payload.institutionId !== "bancolombia") {
      return {
        _tag: "Refused",
        refusal: connectionInputRefusal({ work, code: "not_found" }),
      } as const;
    }
    if (!institutions.includes(input.value.payload.institutionId)) {
      return {
        _tag: "Refused",
        refusal: connectionInputRefusal({ work, code: "validation_failed" }),
      } as const;
    }
    const prepared: CanonicalMutationPreparation = {
      _tag: "Prepared",
      mutation: {
        requiredScope: callerScope(work.subject),
        oauthReview: Option.none(),

        statements: initiationStatements({ work, institutions }),
        commitGuards: Option.none(),
        guardRefusal: () =>
          Effect.succeed(connectionInputRefusal({ work, code: "validation_failed" })),
        outcome: {
          _tag: "Owner",
          operation,
          collisionKey: Option.some("connections:bancolombia"),
          guardFacts: Option.none(),
          read: (db, userId) => readInitiationResult({ db, userId }),
        },
      },
    };
    return prepared;
  }).pipe(Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const));

/** Read caller-owned lifecycle facts with credential use and Audit in the same D1 snapshot. */
export const browseConnections = ({
  db,
  subject,
  request,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
  operation: ConnectionQueryOperation;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = transactionNow();
    if (operation === "connections.listAccounts") {
      return yield* browseAccounts({ db, subject, request, current });
    }
    const authority = callerAuthority({ subject, current });
    const id =
      operation === "connections.getConnection"
        ? (new URL(request.url).pathname.split("/").at(-1) ?? "")
        : "";
    const selection = operation === "connections.getConnection" ? "AND id = ?" : "";
    const bindings = [
      subject.userId,
      ...(operation === "connections.getConnection" ? [id] : []),
      ...authority.bindings,
    ];

    const read = db
      .prepare(
        `SELECT id, institution_id AS institutionId, state FROM connections WHERE user_id = ? ${selection} AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) ORDER BY institution_id, id`
      )
      .bind(...bindings);
    const audit = queryAudit({ db, authority, current, userId: subject.userId, operation, id });
    const results = yield* Effect.tryPromise(() =>
      commitPATUnit({
        db,
        statements: [
          read,
          ...(isPATCaller(subject)
            ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
                db.prepare(sql).bind(...params)
              )
            : []),
          audit,
        ],
      })
    );
    return yield* presentConnections({ results, operation, userId: subject.userId });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const presentConnections = ({
  results,
  operation,
  userId,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: ConnectionQueryOperation;
  userId: string;
}>): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const connections = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.toType(Connection)))(
      results[0]?.results
    );
    if (operation === "connections.getConnection") {
      const connection = Option.fromUndefinedOr(connections[0]);
      if (Option.isNone(connection)) {
        return transactionFailure({
          code: "not_found",
          status: 404,
          message: "Connection unavailable.",
        });
      }
      const data = yield* Schema.encodeEffect(Schema.toCodecJson(Connection))(connection.value);
      return Response.json({ data, next: [] }, { headers: transactionNoStore });
    }
    if (operation === "connections.listConnections") {
      const data = yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(Connection)))(
        connections
      );
      return Response.json({ data, next: [] }, { headers: transactionNoStore });
    }
    const first = Option.fromUndefinedOr(connections[0]);
    const summary: InstitutionSummary = {
      id: InstitutionId.make("bancolombia"),
      displayName: "Bancolombia",
      availability: (yield* institutionsForUser(userId)).includes(InstitutionId.make("bancolombia"))
        ? "available"
        : "unavailable",
      connection: Option.map(first, ({ id, state }) => ({ id: ConnectionId.make(id), state })),
    };
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(InstitutionSummary)))([
      summary,
    ]);
    return Response.json({ data, next: [] }, { headers: transactionNoStore });
  });

const queryAudit = ({
  db,
  authority,
  current,
  userId,
  operation,
  id,
}: Readonly<{
  db: D1Database;
  authority: TransactionAuthority;
  current: number;
  userId: string;
  operation: ConnectionQueryOperation;
  id: string;
}>): D1PreparedStatement =>
  operation === "connections.getConnection"
    ? prepareAuditQueryCall({
        db,
        authority,
        id: transactionId(),
        operation,
        current,
        missingWhen: {
          sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND id = ?)",
          params: [userId, id],
        },
      })
    : prepareAuthorizedAuditCall({
        db,
        authority,
        id: transactionId(),
        operation,
        current,
        outcome: "accepted",
        afterOwnerWrite: false,
      });

/** Admit preparation only to the original stable User's coordinator, with live guards at commit. */
export const executeConnectionBrowserAdmission = (
  input: Readonly<{ db: D1Database; candidate: unknown; userId: string; signal: AbortSignal }>
): Effect.Effect<Response> => {
  const admission = Schema.decodeUnknownOption(ConnectionBrowserAdmission)(input.candidate);
  if (Option.isNone(admission) || admission.value.userId !== input.userId) {
    return Effect.succeed(transactionUnavailable());
  }
  return beginContinuation({ db: input.db, admission: admission.value, signal: input.signal });
};

export const executeConnectionCallbackAdmission = (
  input: Readonly<{ db: D1Database; candidate: unknown; userId: string; signal: AbortSignal }>
): Effect.Effect<Response, never, Crypto.Crypto> => {
  const admission = Schema.decodeUnknownOption(ConnectionCallbackAdmission, {
    onExcessProperty: "error",
  })(input.candidate);
  if (Option.isNone(admission) || admission.value.userId !== input.userId) {
    return Effect.succeed(transactionUnavailable());
  }
  return completeAuthorization({
    db: input.db,
    admission: admission.value,
    signal: input.signal,
  }).pipe(
    Effect.as(new Response(null, { status: 204, headers: transactionNoStore })),
    Effect.orElseSucceed(transactionUnavailable)
  );
};

/** Until #313 publishes completed suppression, an enabled institution's Connection blocks whole-User erasure. */
export const requiresErasureSuppression = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<boolean, ConnectionRetentionUnavailable> =>
  Effect.gen(function* () {
    const institutions = yield* ConnectionInstitutions;
    return yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT EXISTS(SELECT 1 FROM connections c
    WHERE c.user_id=? AND (${registeredInstitutionPredicate({ column: "c.institution_id", institutions })}
      OR EXISTS (SELECT 1 FROM connection_attempts a JOIN connection_authorizations b ON b.attempt_id=a.id
        WHERE a.connection_id=c.id AND b.consent_id IS NOT NULL))) AS pending`)
          .bind(input.userId)
          .first<number>("pending"),
      catch: () => new ConnectionRetentionUnavailable(),
    }).pipe(Effect.map((pending) => pending !== 0));
  });
