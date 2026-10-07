import { initiationStatements, readInitiationResult } from "./internal/initiation";
import { Effect, Option, Schema } from "effect";
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
import { prepareOwnedStatement } from "../database/operations";
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
const Gate = Schema.Struct({ enabled: Schema.Literals([0, 1]) });

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
            ? [
                prepareOwnedStatement({
                  db: work.db,
                  statement: recordLivePATUse({ subject: work.subject, current: work.current }),
                }),
              ]
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

const initiationAuditLimit = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily audit budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code: "rate_limited",
        status: 429,
        message: "Daily audit budget exhausted.",
      })
    ),
});

/** Prepare a stable Connection and short-lived browser attempt inside the shared canonical unit. */
export const prepareConnectInstitution = (
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
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
    const authority = callerAuthority(work);
    const raw = yield* Effect.tryPromise(() =>
      work.db
        .prepare(
          `SELECT enabled FROM connection_institution_gate WHERE institution_id = 'bancolombia' AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`
        )
        .bind(...authority.bindings)
        .first()
    );
    if (raw === null) return { _tag: "CredentialRefused" } as const;
    const gate = yield* Schema.decodeUnknownEffect(Gate)(raw);
    if (gate.enabled === 0) {
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
        auditBudget: "shared",
        statements: initiationStatements(work),
        commitGuards: Option.none(),
        guardRefusal: () =>
          Effect.succeed(connectionInputRefusal({ work, code: "validation_failed" })),
        outcome: {
          _tag: "Owner",
          operation,
          collisionKey: Option.some("connections:bancolombia"),
          guardFacts: Option.none(),
          read: (db, userId) => readInitiationResult({ db, userId }),
          triggerRefusal: (_work, kind) =>
            kind === "audit" ? Option.some(initiationAuditLimit()) : Option.none(),
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
    const gate = db
      .prepare(
        `SELECT enabled FROM connection_institution_gate WHERE institution_id = 'bancolombia' AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`
      )
      .bind(...authority.bindings);
    const audit = queryAudit({ db, authority, current, userId: subject.userId, operation, id });
    const results = yield* Effect.tryPromise(() =>
      commitPATUnit({
        db,
        statements: [
          read,
          gate,
          ...(isPATCaller(subject)
            ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
            : []),
          audit,
        ],
      })
    );
    return yield* presentConnections({ results, operation });
  }).pipe(Effect.orElseSucceed(transactionUnavailable));

const presentConnections = ({
  results,
  operation,
}: Readonly<{
  results: ReadonlyArray<D1Result>;
  operation: ConnectionQueryOperation;
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
    const gateRows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ enabled: Schema.Literals([0, 1]) }))
    )(results[1]?.results);
    const first = Option.fromUndefinedOr(connections[0]);
    const summary: InstitutionSummary = {
      id: InstitutionId.make("bancolombia"),
      displayName: "Bancolombia",
      availability: gateRows[0]?.enabled === 1 ? "available" : "unavailable",
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
