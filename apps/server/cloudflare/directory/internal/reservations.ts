import { Clock, Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { SessionRoute, bootstrapCancelUrl } from "../contract";
import { BrowserLoginPairingId } from "../../../src/core/browser-login/contract";
import { inspectHandoff } from "./provider";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { invalidProvider, unavailable } from "../../browser-login/operations";

const SessionRegistration = Schema.Struct({
  ...SessionRoute.fields,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  hard: Schema.Int,
  pairingId: BrowserLoginPairingId,
  attemptId: Schema.String,
});

export const registerBrowserSession = Effect.fn(function* (request: Request) {
  const input = yield* Schema.decodeUnknownEffect(SessionRegistration)(
    yield* Effect.tryPromise(() => request.json())
  );

  const digest = yield* Effect.fromResult(Hex.decode(input.digest));
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const [route] =
      yield* sql`SELECT 1 FROM browser_pairings p WHERE p.id=${input.pairingId} AND p.user_id=${input.userId} AND p.expires_at_ms>${yield* Clock.currentTimeMillis} AND
      (p.email_handoff=${input.attemptId} OR EXISTS(SELECT 1 FROM provider_attempts a WHERE a.id=${input.attemptId} AND a.pairing_id=p.id AND a.state='bound') OR EXISTS(SELECT 1 FROM support_handoffs h WHERE h.id=${input.attemptId} AND h.pairing_id=p.id AND h.user_id=p.user_id) OR EXISTS(SELECT 1 FROM channel_approvals c WHERE c.id=${input.attemptId} AND c.pairing_id=p.id AND c.user_id=p.user_id))`;

    if (route === undefined) return invalidProvider();
    yield* sql`INSERT INTO session_routes(token_digest,user_id,session_id,reservation_id,hard_expires_at_ms) VALUES(${digest},${input.userId},${input.sessionId},${input.attemptId},${input.hard}) ON CONFLICT DO NOTHING`;

    const exact =
      yield* sql`SELECT 1 FROM session_routes WHERE token_digest=${digest} AND user_id=${input.userId} AND session_id=${input.sessionId} AND reservation_id=${input.attemptId} AND hard_expires_at_ms=${input.hard}`;

    return exact.length === 1 ? new Response(null, { status: 204 }) : invalidProvider();
  }).pipe(withStoreCapacity("growth"));
});

export const releaseBrowserSession = Effect.fn(function* (request: Request) {
  const input = yield* Schema.decodeUnknownEffect(SessionRegistration)(
    yield* Effect.tryPromise(() => request.json())
  );

  const digest = yield* Effect.fromResult(Hex.decode(input.digest));
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    yield* sql`DELETE FROM session_routes WHERE token_digest=${digest} AND user_id=${input.userId} AND session_id=${input.sessionId} AND reservation_id=${input.attemptId} AND hard_expires_at_ms=${input.hard}`;
    const remaining = yield* sql`SELECT 1 FROM session_routes WHERE token_digest=${digest}`;

    return remaining.length === 0 ? new Response(null, { status: 204 }) : unavailable();
  }).pipe(withStoreCapacity("required"));
});

export const cancelProviderHandoff = Effect.fn(function* (
  id: string,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const handoff = yield* inspectHandoff(id);

  if (handoff === null) return invalidProvider();

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    id,
    pairingId: handoff.pairing_id,
  });

  const result = yield* Effect.tryPromise((signal) =>
    users.getByName(handoff.user_id).fetch(bootstrapCancelUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal,
    })
  );

  if (!result.ok) return unavailable();

  const { outcome } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ outcome: Schema.Literals(["committed", "cancelled"]) })
  )(yield* Effect.tryPromise(() => result.json()));

  const sql = yield* SqliteClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const fenced = yield* sql`SELECT 1 FROM erasure_barriers WHERE user_id=${handoff.user_id}`;

      if (outcome === "committed") {
        yield* sql`UPDATE provider_attempts SET acknowledged=1 WHERE id=${id} AND state='bound'`;

        if (fenced.length !== 0) return;
        yield* sql`UPDATE whatsapp_routes SET established=1 WHERE user_id=${handoff.user_id} AND attempt_id=${id}`;
        yield* sql`UPDATE provider_routes SET established=1 WHERE user_id=${handoff.user_id} AND creation_attempt=${id}`;
      } else {
        yield* sql`UPDATE provider_attempts SET state='cancelled' WHERE id=${id} AND state='bound'`;

        if (fenced.length !== 0) return;
        yield* sql`DELETE FROM recovery_routes WHERE user_id=${handoff.user_id} AND attempt_id=${id}`;
        yield* sql`DELETE FROM whatsapp_routes WHERE user_id=${handoff.user_id} AND attempt_id=${id} AND established=0`;
        yield* sql`DELETE FROM provider_routes WHERE user_id=${handoff.user_id} AND creation_attempt=${id} AND established=0`;
      }
    })
  );

  return Response.json({ outcome });
});

export const registerRecoveryCredential = Effect.fn(function* (request: Request) {
  const input = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      attempt: Schema.String,
      user: SessionRoute.fields.userId,
      digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      generation: Schema.Int,
    })
  )(yield* Effect.tryPromise(() => request.json()));

  const bytes = yield* Effect.fromResult(Hex.decode(input.digest));
  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const handoff = yield* inspectHandoff(input.attempt);

    if (
      handoff === null ||
      handoff.user_id !== input.user ||
      handoff.established !== 0 ||
      handoff.creation_attempt !== input.attempt ||
      handoff.expires_at_ms <= (yield* Clock.currentTimeMillis)
    ) {
      return invalidProvider();
    }

    yield* sql`INSERT INTO recovery_routes(code_digest,user_id,attempt_id,revision,generation) VALUES(${bytes},${input.user},${input.attempt},1,${input.generation}) ON CONFLICT(user_id) WHERE revision=1 DO UPDATE SET code_digest=excluded.code_digest,generation=excluded.generation WHERE recovery_routes.attempt_id=excluded.attempt_id AND recovery_routes.revision=1 AND recovery_routes.generation<excluded.generation`;

    const exact =
      yield* sql`SELECT 1 FROM recovery_routes WHERE user_id=${input.user} AND attempt_id=${input.attempt} AND generation=${input.generation} AND code_digest=${bytes}`;

    return exact.length === 1 ? new Response(null, { status: 204 }) : invalidProvider();
  }).pipe(withStoreCapacity("growth"));
});
