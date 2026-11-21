import { Clock, Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import {
  FrozenRecovery,
  RecoveryCandidate,
  SupportApproval,
  SupportOperator,
  localRecoveryCheckUrl,
  localSupportUrl,
  supportAdmissionUrl,
} from "../contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";

const refusedStatus = 400;

const acceptedStatus = 204,
  limitedStatus = 429;

const refused = (): Response =>
  Response.json(
    { status: "not_approved" },
    { status: 400, headers: { "cache-control": "no-store" } }
  );

const hour = 3600000,
  minute = 60000;

const admit = Effect.fn(function* (request: Request) {
  const operator = yield* Schema.decodeUnknownEffect(SupportOperator)(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (operator.issuedAtMs > now || operator.expiresAtMs <= now) {
      return new Response(null, { status: 401 });
    }

    yield* sql`DELETE FROM support_recovery_admissions WHERE admitted_at_ms<=${now - hour}`;

    const added =
      yield* sql`INSERT INTO support_recovery_admissions(issuer,subject,admitted_at_ms) SELECT ${operator.issuer},${operator.subject},${now} WHERE (SELECT count(*) FROM support_recovery_admissions WHERE issuer=${operator.issuer} AND subject=${operator.subject} AND admitted_at_ms>${now - minute})<5 AND (SELECT count(*) FROM support_recovery_admissions WHERE issuer=${operator.issuer} AND subject=${operator.subject})<20 AND (SELECT count(*) FROM support_recovery_admissions WHERE admitted_at_ms>${now - minute})<20 AND (SELECT count(*) FROM support_recovery_admissions)<100 RETURNING 1`;

    return new Response(null, { status: added.length === 1 ? acceptedStatus : limitedStatus });
  }).pipe(withStoreCapacity("growth"));
});

export const directorySupport = Effect.fn(function* (
  request: Request,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  if (request.url === supportAdmissionUrl) return yield* admit(request);

  const input = yield* Schema.decodeUnknownEffect(SupportApproval)(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  const [route] =
    yield* sql`SELECT user_id,revision FROM recovery_routes WHERE code_digest=unhex(${input.digest})`;

  if (route === undefined) return refused();

  const candidate = yield* Schema.decodeUnknownEffect(RecoveryCandidate)({
    ...route,
    digest: input.digest,
  });

  const lookupBody = yield* Schema.encodeEffect(Schema.fromJsonString(RecoveryCandidate))(
    candidate
  );

  const preflight = yield* Effect.tryPromise((signal) =>
    users
      .getByName(candidate.user_id)
      .fetch(localRecoveryCheckUrl, { method: "POST", body: lookupBody, signal })
  );

  if (!preflight.ok) {
    return preflight.status === refusedStatus ? refused() : new Response(null, { status: 503 });
  }

  const handoff = yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const { operator } = input;

    if (operator.issuedAtMs > now || operator.expiresAtMs <= now) return null;
    const id = newId();

    const changes =
      yield* sql`INSERT INTO support_handoffs SELECT ${id},p.id,r.user_id,${input.digest},r.revision,${operator.issuer},${operator.subject},${operator.issuedAtMs},${operator.expiresAtMs} FROM browser_pairings p JOIN recovery_routes r ON r.code_digest=unhex(${input.digest}) WHERE r.user_id=${candidate.user_id} AND r.revision=${candidate.revision} AND p.public_code=${input.publicCode} AND p.user_id IS NULL AND p.expires_at_ms>${now} AND p.wrong_attempts<5 RETURNING user_id,pairing_id`;

    if (changes.length === 1) {
      yield* sql`UPDATE browser_pairings SET user_id=(SELECT user_id FROM support_handoffs WHERE id=${id}) WHERE id=(SELECT pairing_id FROM support_handoffs WHERE id=${id}) AND user_id IS NULL`;
    }

    const [raw] =
      yield* sql`SELECT h.*,p.ordinal,p.verifier_digest,p.expires_at_ms,p.wrong_attempts,p.last_poll_ms,p.minimum_poll_seconds FROM support_handoffs h JOIN browser_pairings p ON p.id=h.pairing_id AND p.user_id=h.user_id WHERE p.public_code=${input.publicCode} AND h.credential_digest=${input.digest} AND h.operator_issuer=${operator.issuer} AND h.operator_subject=${operator.subject} AND h.operator_expires_ms>${now} AND p.expires_at_ms>${now}`;

    return raw === undefined ? null : yield* Schema.decodeUnknownEffect(FrozenRecovery)(raw);
  }).pipe(withStoreCapacity("growth"));

  if (handoff === null) return refused();
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(FrozenRecovery))(handoff);

  return yield* Effect.tryPromise((signal) =>
    users.getByName(handoff.user_id).fetch(localSupportUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );
});
