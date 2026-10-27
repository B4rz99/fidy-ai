import { registeredInstitutionPredicate } from "./institution-registration";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  ConnectionAuthorizationHandoff,
  ConnectionContinuationReview,
  ConnectionInstitutions,
} from "../../../src/shell/connections/contract";
import { Connection } from "../../../src/core/connections/contract";
import {
  prepareAuditQueryCall,
  prepareAuthorizedAuditCall,
} from "../../../src/shell/audit/operations";
import {
  type TransactionAuthority,
  callerAuthority,
  transactionId,
  transactionNoStore,
} from "../../canonical-work/operations";
import type { AuthenticatedWebSession } from "../../web-session/contract";
import type { ConnectionBrowserAdmission } from "../contract";
import { ConnectionBank } from "../contract";
import {
  authorizationStatements,
  encodeConsentIntent,
  prepareProof,
  settleAuthorization,
} from "./authorization";

const missingStatus = 404;
const unavailableStatus = 503;

const ContinuationRow = Schema.Struct({
  ...Connection.fields,
  expiresAtMilliseconds: Schema.Int,
  phase: Schema.Literals(["ready", "preparing", "prepared", "failed"]),
  handoffUrl: Schema.NullOr(Schema.String),
  handoffExpiresAt: Schema.NullOr(Schema.Int),
});
export const continuationFailure = (status: number): Response =>
  Response.json(
    { error: { code: "continuation_unavailable" } },
    { status, headers: transactionNoStore }
  );
const databaseFailure = (cause: unknown): Response =>
  continuationFailure(
    cause instanceof Error && cause.message.includes("connection_browser_commit")
      ? missingStatus
      : unavailableStatus
  );
const query = (
  registered: string
): string => `SELECT c.id, c.institution_id AS institutionId, c.state, a.expires_at_ms AS expiresAtMilliseconds,
  CASE WHEN a.status = 'pending' THEN 'ready' ELSE coalesce(b.phase,'prepared') END AS phase,
  b.handoff_url AS handoffUrl, b.expires_at_ms AS handoffExpiresAt
  FROM connection_attempts a JOIN connections c ON c.id = a.connection_id
  LEFT JOIN connection_authorizations b ON b.attempt_id=a.id
  WHERE a.public_reference = ? AND c.user_id = ? AND a.expires_at_ms > ? AND c.state = 'Connecting'
    AND (a.status = 'pending' OR (a.status = 'consumed' AND a.prepared_session_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM connection_attempts newer WHERE newer.connection_id = a.connection_id AND newer.rowid > a.rowid)
    AND ${registered}`;
const present = (candidate: unknown): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ContinuationRow))(candidate);
    const row = Option.fromUndefinedOr(rows[0]);
    if (Option.isNone(row)) return continuationFailure(missingStatus);
    const now = yield* Clock.currentTimeMillis;
    const expired = row.value.handoffExpiresAt !== null && row.value.handoffExpiresAt <= now;
    const review = yield* Schema.decodeUnknownEffect(Schema.toType(ConnectionContinuationReview))({
      connection: {
        id: row.value.id,
        institutionId: row.value.institutionId,
        state: row.value.state,
      },
      institutionName: "Bancolombia",
      expiresAt: DateTime.makeUnsafe(row.value.expiresAtMilliseconds),
      phase: expired ? "failed" : row.value.phase,
      ...(!expired && row.value.handoffUrl !== null && row.value.handoffExpiresAt !== null
        ? {
            authorization: yield* Schema.decodeEffect(ConnectionAuthorizationHandoff)({
              url: row.value.handoffUrl,
              expiresAt: DateTime.formatIso(DateTime.makeUnsafe(row.value.handoffExpiresAt)),
            }),
          }
        : {}),
    });
    const body = yield* Schema.encodeEffect(Schema.toCodecJson(ConnectionContinuationReview))(
      review
    );
    return Response.json(body, { headers: transactionNoStore });
  });
const guardedQuery = (authority: TransactionAuthority, registered: string): string =>
  `${query(registered)} AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`;
/** Review and its metadata-only Audit use the same authoritative snapshot. */
export const reviewContinuation = (
  input: Readonly<{
    db: D1Database;
    subject: AuthenticatedWebSession;
    attempt: string;
    current: number;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const authority = callerAuthority(input);
    const institutions = yield* ConnectionInstitutions;
    const registered = registeredInstitutionPredicate({ column: "c.institution_id", institutions });
    const sql = guardedQuery(authority, registered);
    const bindings = [input.attempt, input.subject.userId, input.current, ...authority.bindings];
    const result = yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          input.db.prepare(sql).bind(...bindings),
          prepareAuditQueryCall({
            db: input.db,
            authority,
            id: transactionId(),
            operation: "connections.reviewContinuation",
            current: input.current,
            missingWhen: { sql: `SELECT 1 WHERE NOT EXISTS (${sql})`, params: bindings },
          }),
          prepareChangedRowAssertion({ db: input.db, scope: "connection_browser" }),
        ]),
      catch: databaseFailure,
    });
    return yield* present(result[0]?.results);
  }).pipe(
    Effect.catch((response) =>
      Effect.succeed(
        response instanceof Response ? response : continuationFailure(unavailableStatus)
      )
    )
  );

const admittedSubject = (admission: ConnectionBrowserAdmission): AuthenticatedWebSession => ({
  id: admission.sessionId,
  userId: admission.userId,
  digest: new Uint8Array(admission.digest),
});
const freshAuthority = (
  admission: ConnectionBrowserAdmission,
  current: number
): ReturnType<typeof callerAuthority> => {
  const live = callerAuthority({
    subject: admittedSubject(admission),
    current,
  });
  return {
    ...live,
    predicate: `${live.predicate} AND fresh_until_ms > ?`,
    bindings: [...live.bindings, current],
  };
};

const claimStatements = ({
  db,
  admission,
  current,
  authority,
  registered,
  authorization,
}: Readonly<{
  db: D1Database;
  admission: ConnectionBrowserAdmission;
  current: number;
  authority: TransactionAuthority;
  registered: string;
  authorization: ReadonlyArray<D1PreparedStatement>;
}>): D1PreparedStatement[] => [
  db
    .prepare(`UPDATE connection_attempts SET status = 'consumed', consumed_at_ms = ?, prepared_session_id = ?
      WHERE public_reference = ? AND EXISTS(SELECT 1 FROM connections c WHERE c.id=connection_attempts.connection_id AND c.user_id=?) AND status = 'pending' AND expires_at_ms > ?
      AND EXISTS (SELECT 1 FROM connections c WHERE c.id = connection_attempts.connection_id AND c.state = 'Connecting' AND ${registered})
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
    .bind(
      current,
      admission.sessionId,
      admission.attempt,
      admission.userId,
      current,
      ...authority.bindings
    ),
  prepareAuthorizedAuditCall({
    db,
    authority,
    id: transactionId(),
    operation: "connections.beginContinuation",
    current,
    outcome: "accepted",
    afterOwnerWrite: true,
  }),
  prepareChangedRowAssertion({ db, scope: "connection_browser" }),
  ...authorization,
  db
    .prepare(guardedQuery(authority, registered))
    .bind(admission.attempt, admission.userId, current, ...authority.bindings),
];

/** Claim once under fresh same-User authority before any external preparation. */
export const beginContinuation = (
  input: Readonly<{ db: D1Database; admission: ConnectionBrowserAdmission; signal: AbortSignal }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const bank = yield* ConnectionBank;
    const proof = yield* prepareProof(bank);
    const intentJson = yield* encodeConsentIntent(bank);
    const current = yield* Clock.currentTimeMillis;
    if (input.signal.aborted || current >= input.admission.deadlineMilliseconds) {
      return continuationFailure(unavailableStatus);
    }
    const { admission, db } = input;
    const institutions = yield* ConnectionInstitutions;
    const registered = registeredInstitutionPredicate({ column: "c.institution_id", institutions });
    const authority = freshAuthority(admission, current);
    const result = yield* Effect.tryPromise({
      try: () =>
        db.batch(
          claimStatements({
            db,
            admission,
            current,
            authority,
            registered,
            authorization: authorizationStatements({ db, admission, current, proof, intentJson }),
          })
        ),
      catch: databaseFailure,
    });
    if (Option.isSome(bank) && Option.isSome(proof)) {
      const claimed = yield* Schema.decodeUnknownEffect(Schema.Array(ContinuationRow))(
        result.at(-1)?.results
      );
      const attempt = Option.fromUndefinedOr(claimed[0]);
      if (Option.isNone(attempt)) return continuationFailure(missingStatus);
      yield* settleAuthorization({
        db,
        admission,
        bank: bank.value,
        proof: proof.value,
        expiresAtMilliseconds: attempt.value.expiresAtMilliseconds,
      });
      return yield* reviewContinuation({
        db,
        subject: admittedSubject(admission),
        attempt: admission.attempt,
        current: yield* Clock.currentTimeMillis,
      });
    }
    return yield* present(result.at(-1)?.results);
  }).pipe(
    Effect.catch((response) =>
      Effect.succeed(
        response instanceof Response ? response : continuationFailure(unavailableStatus)
      )
    )
  );
