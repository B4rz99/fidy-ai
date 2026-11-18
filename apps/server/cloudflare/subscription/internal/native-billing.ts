import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Result, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { BillingAttemptId, renewalGraceMs } from "../../../src/core/subscription/contract";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { type ExternalEventBindings } from "../../directory/contract";
import { lookupExternalEventRoute, reserveExternalEventRoute } from "../../directory/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  LocalBillingCollection,
  type WompiBillingEvent,
  type WompiBindings,
  collectUserBillingUrl,
  settleUserBillingUrl,
} from "../contract";
import { Snapshot, billingAmount, matchesSnapshot, verifiedOutcome } from "./billing-transaction";
import { nativeSettlementStatements } from "./billing-settlement";
import { type WompiTransaction, makeWompiBillingClient } from "./wompi-billing-client";
import {
  WompiBillingStatus,
  WompiSourceId,
  WompiTransactionId,
  WompiTransactionReference,
} from "./wompi-model";
import type { WompiTransportFactory } from "./wompi-runtime";
import { protectConsentStatement } from "../../../src/shell/consent/operations";

const noContentStatus = 204;
const pendingStatus = 202;

const Observation = Schema.Struct({
  userId: UserId,
  attemptId: BillingAttemptId,
  environment: WompiEnvironment,
  transactionId: WompiTransactionId,
  reference: WompiTransactionReference,
  status: WompiBillingStatus,
  amountInCents: Schema.Int,
  currency: Schema.String,
  generation: Schema.optionalKey(
    Schema.Struct({ signedAt: Schema.Int, signedStatus: Schema.String })
  ),
  sourceId: Schema.NullOr(WompiSourceId),
  finalizedAt: Schema.NullOr(Schema.Int),
});
type Work = typeof LocalBillingCollection.Type;
const absent = (): Response => new Response(null, { status: noContentStatus });
const blocked = (): Response => new Response(null, { status: 503 });
const readAttempt = Effect.fn(function* (work: { userId: UserId; attemptId: BillingAttemptId }) {
  const sql = yield* SqliteClient;
  const [row] =
    yield* sql`SELECT a.*,s.method,s.billing_email,s.wompi_source_id FROM billing_attempt_context a JOIN payment_source_context s ON s.id=a.payment_source_id AND s.user_id=a.user_id
    WHERE a.id=${work.attemptId} AND a.user_id=${work.userId} AND a.wompi_environment=s.wompi_environment AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=a.user_id)`;
  if (row === undefined) return Option.none<typeof Snapshot.Type>();
  return Option.some(yield* Schema.decodeUnknownEffect(Snapshot)(row));
});

const admitGeneration = Effect.fn(function* (observation: typeof Observation.Type) {
  const sql = yield* SqliteClient;
  const generation = observation.generation;
  if (generation !== undefined) {
    const admitted =
      yield* sql`INSERT INTO billing_provider_transactions(transaction_id,attempt_id,event_signed_at,event_signed_status)
      VALUES(${observation.transactionId},${observation.attemptId},${generation.signedAt},${generation.signedStatus})
      ON CONFLICT(transaction_id) DO UPDATE SET event_signed_at=excluded.event_signed_at,event_signed_status=excluded.event_signed_status
      WHERE attempt_id=excluded.attempt_id AND (event_signed_at IS NULL OR excluded.event_signed_at>event_signed_at OR
        (excluded.event_signed_at=event_signed_at AND (event_signed_status=excluded.event_signed_status OR excluded.event_signed_status='APPROVED'))) RETURNING 1`;
    if (admitted.length === 0) return false;
  }
  return true;
});
const observe = Effect.fn(function* (observation: typeof Observation.Type) {
  const sql = yield* SqliteClient;
  const captured = yield* readAttempt(observation);
  if (Option.isNone(captured)) return absent();
  const found: WompiTransaction = {
    ...observation,
    sourceId: Option.fromNullOr(observation.sourceId),
    finalizedAt: Option.map(Option.fromNullOr(observation.finalizedAt), DateTime.makeUnsafe),
  };
  if (
    !matchesSnapshot({
      captured: captured.value,
      found,
      expectedId: observation.transactionId,
      expectedAmount: yield* billingAmount(captured.value),
      environment: observation.environment,
      requireFinalization: true,
    })
  ) {
    return absent();
  }
  const [eligible] =
    yield* sql`SELECT 1 FROM billing_attempts a WHERE id=${observation.attemptId} AND collection_sent_at_ms IS NOT NULL AND collection_state='sent'
    AND NOT EXISTS (SELECT 1 FROM billing_provider_transactions WHERE transaction_id=${observation.transactionId} AND attempt_id<>a.id)`;
  if (eligible === undefined) return absent();
  if (!(yield* admitGeneration(observation))) return absent();
  const outcome = yield* verifiedOutcome(captured.value, found);
  for (const statement of nativeSettlementStatements({
    attemptId: observation.attemptId,
    transactionId: found.transactionId,
    observedAtMs: yield* Clock.currentTimeMillis,
    outcome,
  })) {
    yield* sql.unsafe(statement.text, statement.params);
  }
  const [attempt] =
    yield* sql`SELECT status FROM billing_attempts WHERE id=${observation.attemptId}`;
  return attempt?.status === "pending" ? new Response(null, { status: pendingStatus }) : absent();
});
const observationFor = (
  found: WompiTransaction
): Omit<typeof Observation.Type, "userId" | "attemptId" | "environment"> => ({
  ...found,
  sourceId: Option.getOrNull(found.sourceId),
  finalizedAt: Option.getOrNull(Option.map(found.finalizedAt, DateTime.toEpochMillis)),
});
const claim = Effect.fn(function* (work: Work, captured: typeof Snapshot.Type, now: number) {
  const sql = yield* SqliteClient;
  const current = yield* readAttempt(work);
  if (Option.isNone(current) || !Schema.toEquivalence(Snapshot)(current.value, captured)) {
    return false;
  }
  const guard = protectConsentStatement({
    subject: { _tag: "User", userId: work.userId },
    requirement: "active",
    statement: {
      sql: `UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=? WHERE id=? AND collection_state='armed' AND status='pending' AND wompi_environment=? AND wompi_reference=?
      AND EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=billing_attempts.id AND a.user_id=?)
      AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=?)
      AND (previous_paid_attempt_id IS NULL OR (period_starts_at_ms+?>? AND EXISTS(SELECT 1 FROM subscription_standing s WHERE s.user_id=? AND s.attempt_id=billing_attempts.previous_paid_attempt_id)
        AND NOT EXISTS(SELECT 1 FROM subscription_renewal_fences WHERE user_id=?)))`,
      params: [
        now,
        work.attemptId,
        captured.wompi_environment,
        captured.wompi_reference,
        work.userId,
        work.userId,
        renewalGraceMs,
        now,
        work.userId,
        work.userId,
      ],
    },
  });
  const armed = yield* sql.unsafe(guard.sql + " RETURNING id", guard.params);
  return armed.length === 1;
});
const retainCandidate = Effect.fn(function* (
  work: Work,
  captured: typeof Snapshot.Type,
  candidate: WompiTransactionId
) {
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`INSERT INTO billing_provider_transactions(transaction_id,attempt_id) SELECT ${candidate},a.id FROM billing_attempt_context a WHERE a.id=${work.attemptId} AND a.user_id=${work.userId} AND a.collection_state='sent' AND NOT EXISTS(SELECT 1 FROM erasure_requests) ON CONFLICT DO NOTHING`;
      if (captured.method === "card" && Option.isNone(captured.previous_paid_attempt_id)) {
        yield* sql`UPDATE billing_attempts SET checkout_transaction_id=${candidate} WHERE id=${work.attemptId} AND checkout_transaction_id IS NULL AND EXISTS(SELECT 1 FROM billing_provider_transactions WHERE transaction_id=${candidate} AND attempt_id=${work.attemptId})`;
      }
    })
  );
});
const registerAttempt = Effect.fn(function* (
  directory: ExternalEventBindings["DIRECTORY"],
  work: Work,
  captured: typeof Snapshot.Type
) {
  yield* reserveExternalEventRoute(directory, {
    kind: "wompi",
    endpoint: captured.wompi_environment,
    lookup: captured.wompi_reference,
    family: "billing",
    userId: work.userId,
    operationId: work.attemptId,
  });
});
const collect = Effect.fn(function* (
  work: Work,
  env: WompiBindings & Pick<ExternalEventBindings, "DIRECTORY">,
  transport: WompiTransportFactory
) {
  const retained = yield* readAttempt(work);
  if (Option.isNone(retained)) return absent();
  const captured = retained.value;
  if (captured.wompi_environment !== env.WOMPI_ENVIRONMENT) return blocked();
  yield* registerAttempt(env.DIRECTORY, work, captured);
  const client = makeWompiBillingClient({
    environment: env.WOMPI_ENVIRONMENT,
    outboundHttp: yield* transport(env),
  });
  const amount = yield* billingAmount(captured);
  const now = yield* Clock.currentTimeMillis;
  const armed = yield* claim(work, captured, now).pipe(withStoreCapacity("required"));
  if (!armed) return absent();
  const sent = yield* Effect.result(
    client.createTransaction({
      reference: captured.wompi_reference,
      amountInCents: amount,
      currency: captured.currency,
      billingEmail: captured.billing_email,
      sourceId: captured.wompi_source_id,
      method: captured.method,
    })
  );
  const sql = yield* SqliteClient;
  if (Result.isFailure(sent)) {
    if (sent.failure.certainty === "rejected") {
      yield* sql`UPDATE billing_attempts SET collection_state='rejected' WHERE id=${work.attemptId} AND collection_state='sent' AND collection_sent_at_ms=${now} AND NOT EXISTS(SELECT 1 FROM billing_provider_transactions WHERE attempt_id=${work.attemptId})`;
    }
    return absent();
  }
  if (
    !matchesSnapshot({
      captured,
      found: sent.success,
      expectedId: sent.success.transactionId,
      expectedAmount: amount,
      environment: client.environment,
      requireFinalization: false,
    })
  ) {
    return absent();
  }
  const candidate = sent.success.transactionId;
  yield* retainCandidate(work, captured, candidate);
  const verified = yield* client.findTransaction(candidate);
  if (verified.transactionId !== candidate) return blocked();
  return yield* observe({
    ...work,
    environment: client.environment,
    ...observationFor(verified),
  }).pipe(withStoreCapacity("required"));
});

export const nativeBillingRequest = Effect.fn(function* ({
  request,
  env,
  owns,
  transport,
}: {
  request: Request;
  env: WompiBindings & Pick<ExternalEventBindings, "DIRECTORY">;
  owns: (id: string) => boolean;
  transport: WompiTransportFactory;
}) {
  const body: unknown = yield* Effect.tryPromise(() => request.json());
  if (request.url === collectUserBillingUrl) {
    const work = yield* Schema.decodeUnknownEffect(LocalBillingCollection)(body);
    return owns(work.userId) ? yield* collect(work, env, transport) : absent();
  }
  const evidence = yield* Schema.decodeUnknownEffect(Observation)(body);
  return owns(evidence.userId) && evidence.environment === env.WOMPI_ENVIRONMENT
    ? yield* observe(evidence).pipe(withStoreCapacity("required"))
    : absent();
});

export const routeBillingEvent = Effect.fn(function* (
  event: typeof WompiBillingEvent.Type,
  env: WompiBindings & ExternalEventBindings,
  transport: WompiTransportFactory
) {
  if (event.environment !== env.WOMPI_ENVIRONMENT) return;
  const client = makeWompiBillingClient({
    environment: env.WOMPI_ENVIRONMENT,
    outboundHttp: yield* transport(env),
  });
  const id = yield* Schema.decodeEffect(WompiTransactionId)(event.transactionId);
  const found = yield* client.findTransaction(id);
  if (found.transactionId !== id) return;
  const route = yield* lookupExternalEventRoute(env.DIRECTORY, {
    kind: "wompi",
    endpoint: event.environment,
    lookup: found.reference,
  });
  if (Option.isNone(route) || route.value.family !== "billing") return;
  const picked = route.value;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId: picked.userId,
    attemptId: picked.operationId,
    generation: { signedAt: event.signedAt, signedStatus: event.signedStatus },
    environment: event.environment,
    ...observationFor(found),
  });
  const reply = yield* Effect.tryPromise((signal) =>
    env.USER_STORE.getByName(picked.userId).fetch(settleUserBillingUrl, {
      method: "POST",
      signal,
      body,
    })
  );
  if (!reply.ok || reply.status === pendingStatus) {
    return yield* Effect.fail("billing-callback-unavailable" as const);
  }
});
