import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, Effect, Option, Redacted, Result, Schema } from "effect";
import {
  ConnectionAuthorizationHandoff,
  ConnectionContinuationInput,
} from "../../../src/shell/connections/contract";
import { UserId } from "../../../src/core/identity/contract";
import { InstitutionId } from "../../../src/core/connections/contract";
import { connectionBrowserTransport } from "../../../src/shell/connections/runtime";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import {
  boundSessionLookup,
  readBoundWebSessionProof,
  resolveBoundCanonicalWebSession,
} from "../../web-session/operations";
import { admitLocalRequest } from "../../canonical-admission/operations";
import { newId } from "../../secret-material/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { ConnectionAuthorizationUnavailable, type ConnectionBankPreparation } from "../contract";
import { institutionsForUser } from "./institution-registration";
import { encodeConsentIntent, prepareProof } from "./authorization";
import { continuationFailure, present } from "./browser";

const limitedStatus = 429;

const missingStatus = 404;

const invalidStatus = 400;

const forbiddenStatus = 403;

const methodStatus = 405;

const unauthorizedStatus = 401;

const unavailableStatus = 503;

export const failed = (): ConnectionAuthorizationUnavailable =>
  new ConnectionAuthorizationUnavailable({ cause: undefined });

export const one = (
  rows: ReadonlyArray<unknown>
): Effect.Effect<void, ConnectionAuthorizationUnavailable> =>
  rows.length === 1 ? Effect.void : Effect.fail(failed());

export type BrowserProof = NonNullable<
  Option.Option.Value<Awaited<ReturnType<typeof readBoundWebSessionProof>>>
>;

export type BrowserUnit = {
  request: Request;
  owns: (user: string) => boolean;
  storage: DurableObjectStorage;
};

class BrowserSessionRefused extends Data.TaggedError("BrowserSessionRefused")<{ status: number }> {}

export const session = Effect.fn(function* (
  proof: BrowserProof,
  owns: BrowserUnit["owns"],
  { fresh, current }: { fresh: boolean; current: number }
) {
  const lookup = boundSessionLookup({ ...proof, current });
  const sql = yield* SqliteClient;

  const [row] = yield* sql.unsafe(
    `SELECT proof.*,web_sessions.fresh_until_ms FROM (${lookup.statement.sql}) proof JOIN web_sessions ON web_sessions.id=proof.id
     WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=proof.userId)`,
    lookup.statement.params
  );

  const subject = resolveBoundCanonicalWebSession({ lookup, row });

  if (Option.isNone(subject) || !owns(subject.value.userId)) {
    return yield* new BrowserSessionRefused({ status: unauthorizedStatus });
  }

  const standing = yield* Schema.decodeUnknownEffect(Schema.Struct({ fresh_until_ms: Schema.Int }))(
    row
  );

  if (fresh && standing.fresh_until_ms <= current) {
    return yield* new BrowserSessionRefused({ status: missingStatus });
  }

  return { ...subject.value, userId: yield* Schema.decodeEffect(UserId)(subject.value.userId) };
});

export const auditBrowser = Effect.fn(function* (
  { userId: user, id }: Pick<Effect.Success<ReturnType<typeof session>>, "id" | "userId">,
  { operation, current }: { operation: string; current: number },
  outcome = "success"
) {
  const sql = yield* SqliteClient;
  yield* one(
    yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms)
    VALUES(${newId()},${user},${id},'session_call',${operation},${outcome},${current}) RETURNING id`
  );
});

const attemptRead = Effect.fn(function* (
  unit: BrowserUnit,
  proof: BrowserProof,
  { attempt, pressure }: { attempt: string; pressure: boolean }
) {
  const sql = yield* SqliteClient;
  const current = yield* Clock.currentTimeMillis;
  const subject = yield* session(proof, unit.owns, { fresh: false, current });

  if (pressure && (yield* admitLocalRequest({ user: subject.userId, current })).length === 0) {
    return continuationFailure(limitedStatus);
  }

  const registered = (yield* institutionsForUser(subject.userId)).includes(
    InstitutionId.make("bancolombia")
  );

  const rows =
    yield* sql`SELECT c.id,c.institution_id AS institutionId,c.state,a.expires_at_ms AS expiresAtMilliseconds,
    CASE WHEN a.status='pending' THEN 'ready' ELSE coalesce(b.phase,'prepared') END AS phase,b.handoff_url AS handoffUrl,b.expires_at_ms AS handoffExpiresAt
    FROM connection_attempts a JOIN connections c ON c.id=a.connection_id LEFT JOIN connection_authorizations b ON b.attempt_id=a.id
    WHERE ${Number(registered)} AND a.public_reference=${attempt} AND c.user_id=${subject.userId} AND c.state='Connecting' AND a.expires_at_ms>${current}
    AND (a.status='pending' OR (a.status='consumed' AND a.prepared_session_id=${subject.id}))
    AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid)`;

  yield* auditBrowser(
    subject,
    { operation: "connections.reviewContinuation", current },
    rows.length > 0 ? "success" : "not_found"
  );

  return yield* present(rows);
});

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 2000,
});

const maximumWait = 30000;

type AuthorizationProof = Effect.Success<ReturnType<typeof prepareProof>>;

type ClaimedAttempt<Claim> = Claim extends Result.Result<infer Claimed, unknown> ? Claimed : never;

const claimAttempt = Effect.fn(function* (
  unit: BrowserUnit,
  proof: BrowserProof,
  {
    attempt,
    auth,
    intent,
  }: {
    attempt: typeof ConnectionContinuationInput.Type.attempt;
    auth: AuthorizationProof;
    intent: string;
  }
) {
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const subject = yield* session(proof, unit.owns, { fresh: true, current });

      if ((yield* admitLocalRequest({ user: subject.userId, current })).length === 0) {
        return Result.fail(continuationFailure(limitedStatus));
      }

      if (
        !(yield* institutionsForUser(subject.userId)).includes(InstitutionId.make("bancolombia"))
      ) {
        return Result.fail(continuationFailure(missingStatus));
      }

      const [raw] =
        yield* sql`UPDATE connection_attempts SET status='consumed',consumed_at_ms=${current},prepared_session_id=${subject.id}
      WHERE public_reference=${attempt} AND status='pending' AND expires_at_ms>${current}
      AND EXISTS(SELECT 1 FROM connections c WHERE c.id=connection_attempts.connection_id AND c.user_id=${subject.userId} AND c.state='Connecting')
      AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=connection_attempts.connection_id AND newer.rowid>connection_attempts.rowid) RETURNING id,expires_at_ms`;

      if (raw === undefined) return Result.fail(continuationFailure(missingStatus));

      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, expires_at_ms: Schema.Int })
      )(raw);

      yield* auditBrowser(subject, { operation: "connections.beginContinuation", current });

      if (Option.isSome(auth)) {
        yield* sql`INSERT INTO connection_authorizations(attempt_id,intent_json,verifier,state_digest,phase,expires_at_ms) VALUES(${row.id},${intent},${Redacted.value(auth.value.verifier)},${auth.value.stateDigest},'preparing',${row.expires_at_ms})`;
      }

      yield* preserveStoreAlarm(unit.storage, row.expires_at_ms);

      const [standing] =
        yield* sql`SELECT coalesce(max(rowid),0) AS withdrawal FROM consent_history WHERE user_id=${subject.userId} AND record_type='processing_withdrawal'`;

      return Result.succeed({
        ...row,
        user: subject.userId,
        withdrawal: (yield* Schema.decodeUnknownEffect(Schema.Struct({ withdrawal: Schema.Int }))(
          standing
        )).withdrawal,
      });
    })
  );
});

const settleHandoff = Effect.fn(function* (
  input: {
    claim: ClaimedAttempt<Effect.Success<ReturnType<typeof claimAttempt>>>;
    unit: BrowserUnit;
    proof: BrowserProof;
  },
  handoff: Option.Option<{ url: string; expiresAtMilliseconds: number }>,
  now: number
) {
  const sql = yield* SqliteClient;
  const { claim, unit, proof } = input;

  const authorized = yield* session(proof, unit.owns, { fresh: false, current: now }).pipe(
    Effect.as(true),
    Effect.catchTag("BrowserSessionRefused", () => Effect.succeed(false))
  );

  const registered = (yield* institutionsForUser(claim.user)).includes(
    InstitutionId.make("bancolombia")
  );

  const [current] =
    yield* sql`SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE a.id=${claim.id} AND c.state='Connecting' AND c.user_id=${claim.user} AND a.expires_at_ms>${now} AND NOT EXISTS(SELECT 1 FROM connection_attempts n WHERE n.connection_id=c.id AND n.rowid>a.rowid) AND NOT EXISTS(SELECT 1 FROM consent_history h WHERE h.user_id=c.user_id AND h.record_type='processing_withdrawal' AND h.rowid>${claim.withdrawal})`;

  const safe = authorized && registered && current !== undefined ? handoff : Option.none();
  const url = Option.getOrNull(Option.map(safe, (value) => value.url));

  const expiry = Option.match(handoff, {
    onNone: () => now,
    onSome: (value) => value.expiresAtMilliseconds,
  });

  yield* sql`UPDATE connection_authorizations SET phase=CASE WHEN ${url} IS NOT NULL AND consent_id IS NOT NULL THEN 'prepared' ELSE 'failed' END,
      handoff_url=CASE WHEN consent_id IS NOT NULL THEN ${url} END,verifier=CASE WHEN consent_id IS NOT NULL AND ${url} IS NOT NULL THEN verifier END,expires_at_ms=min(expires_at_ms,${expiry}) WHERE attempt_id=${claim.id} AND phase='preparing' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')`;
});

const prepareHandoff = Effect.fn(function* (
  context: {
    claim: ClaimedAttempt<Effect.Success<ReturnType<typeof claimAttempt>>>;
    unit: BrowserUnit;
    proof: BrowserProof;
  },
  {
    attempt,
    auth,
  }: {
    attempt: typeof ConnectionContinuationInput.Type.attempt;
    auth: Option.Option.Value<AuthorizationProof>;
  },
  bank: ConnectionBankPreparation
) {
  const { claim } = context;
  const sql = yield* SqliteClient;
  const started = yield* Clock.currentTimeMillis;

  const response = yield* bank
    .prepare({
      userId: claim.user,
      attempt,
      state: auth.state,
      challenge: auth.challenge,
      expiresAtMilliseconds: claim.expires_at_ms,
      recordConsent: (value) =>
        Effect.gen(function* () {
          const consent = yield* Schema.decodeEffect(
            Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u))
          )(value);

          yield* one(
            yield* sql`UPDATE connection_authorizations SET consent_id=${consent} WHERE attempt_id=${claim.id} AND consent_id IS NULL AND phase='preparing' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') RETURNING attempt_id`
          );
        }).pipe(Effect.mapError(failed)),
    })
    .pipe(
      Effect.timeout(Math.min(maximumWait, Math.max(1, claim.expires_at_ms - started))),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            url: ConnectionAuthorizationHandoff.fields.url,
            expiresAtMilliseconds: Schema.Int,
          })
        )
      ),
      Effect.option
    );

  const now = yield* Clock.currentTimeMillis;

  const handoff = Option.filter(
    response,
    (handoff) =>
      now < started + maximumWait &&
      now < handoff.expiresAtMilliseconds &&
      handoff.expiresAtMilliseconds <= claim.expires_at_ms
  );

  yield* sql.withTransaction(settleHandoff(context, handoff, now));
});

const beginBrowserAttempt = Effect.fn(function* (
  unit: BrowserUnit,
  proof: BrowserProof,
  bank: Option.Option<ConnectionBankPreparation>
) {
  const { request } = unit;
  const url = new URL(request.url);
  const sql = yield* SqliteClient;

  if (url.searchParams.size > 0) return continuationFailure(invalidStatus);
  const input = yield* boundedJsonBody({ request, policy, schema: Schema.Unknown });

  const target = Option.flatMap(
    input,
    Schema.decodeUnknownOption(ConnectionContinuationInput, { onExcessProperty: "error" })
  );

  if (Option.isNone(target)) return continuationFailure(invalidStatus);
  const attempt = target.value.attempt;
  const auth = yield* prepareProof(bank);
  const intent = yield* encodeConsentIntent(bank);
  const claim = yield* claimAttempt(unit, proof, { attempt, auth, intent });

  if (Result.isFailure(claim)) return claim.failure;

  if (Option.isSome(auth) && Option.isSome(bank)) {
    yield* prepareHandoff(
      { claim: claim.success, unit, proof },
      { attempt, auth: auth.value },
      bank.value
    );
  }

  return yield* sql.withTransaction(attemptRead(unit, proof, { attempt, pressure: false }));
});

export const browser = Effect.fn(
  function* (unit: BrowserUnit, origin: string, bank: Option.Option<ConnectionBankPreparation>) {
    const { request } = unit;
    const url = new URL(request.url);
    const transport = connectionBrowserTransport(url.pathname);

    if (Option.isNone(transport) || transport.value.method !== request.method) {
      return continuationFailure(methodStatus);
    }

    if (request.headers.get("origin") !== origin) return continuationFailure(forbiddenStatus);
    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));

    if (Option.isNone(proof)) return continuationFailure(unauthorizedStatus);
    const sql = yield* SqliteClient;

    if (transport.value.operation === "review") {
      if (url.searchParams.size !== 1) return continuationFailure(invalidStatus);

      const target = Schema.decodeUnknownOption(ConnectionContinuationInput)({
        attempt: url.searchParams.get("attempt"),
      });

      return Option.isSome(target)
        ? yield* sql.withTransaction(
            attemptRead(unit, proof.value, { attempt: target.value.attempt, pressure: true })
          )
        : continuationFailure(invalidStatus);
    }

    return yield* beginBrowserAttempt(unit, proof.value, bank);
  },
  Effect.catchTag("BrowserSessionRefused", (err) =>
    Effect.succeed(continuationFailure(err.status))
  ),
  Effect.catchCause(() => Effect.succeed(continuationFailure(unavailableStatus)))
);
