import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { BillingAttemptId, renewalGraceMs } from "../../../src/core/subscription/contract";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { type ExternalEventBindings } from "../../directory/contract";
import { lookupExternalEventRoute, reserveExternalEventRoute } from "../../directory/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  LocalBillingCollection,
  type WompiBillingEvent,
  type WompiBindings,
  collectUserBillingUrl,
  settleUserBillingUrl,
} from "../contract";
import { Snapshot, billingAmount, matchesSnapshot, verifiedOutcome } from "./billing-transaction";
import { nativeSettlementStatements } from "./billing-settlement";
import { WompiBillingClient, type WompiTransaction } from "./wompi-billing-client";
import {
  WompiBillingStatus,
  WompiSourceId,
  WompiTransactionId,
  WompiTransactionReference,
} from "./wompi-model";
import type { WompiTransportFactory } from "./wompi-runtime";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";

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

const readAttempt = Effect.fn(function* (
  work: { userId: UserId; attemptId: BillingAttemptId },
  settlement = false
) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT a.*,s.method,s.billing_email,s.wompi_source_id FROM billing_attempt_context a JOIN payment_source_context s ON s.id=a.payment_source_id AND s.user_id=a.user_id
    WHERE a.id=${work.attemptId} AND a.user_id=${work.userId} AND a.wompi_environment=s.wompi_environment AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=a.user_id AND (state<>'Draining' OR ${Number(settlement)}=0 OR a.collection_state IS NOT 'sent'))`;

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

const observe = Effect.fn(function* (
  observation: typeof Observation.Type,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const captured = yield* readAttempt(observation, true);

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

  const observedAtMs = yield* Clock.currentTimeMillis;

  yield* Effect.forEach(
    nativeSettlementStatements({
      attemptId: observation.attemptId,
      transactionId: found.transactionId,
      observedAtMs,
      outcome,
    }),
    (statement) => sql.unsafe(statement.text, statement.params),
    { discard: true }
  );

  return yield* scheduleObservation({
    id: observation.attemptId,
    candidate: found.transactionId,
    storage,
  });
});

const lookupCooldown = 60000;

const maximumChecks = 8;

const auditedObservation = Effect.fn(function* (id: BillingAttemptId) {
  const sql = yield* SqliteClient;

  const [attempt] = yield* sql`SELECT status,followup_due_at_ms,
    status='pending' OR EXISTS(SELECT 1 FROM billing_transition_audit a WHERE a.attempt_id=b.id AND a.transition=b.status) AS accounted
    FROM billing_attempts b WHERE id=${id}`;

  if (attempt?.accounted === 0) return yield* Effect.fail("billing-audit-unavailable" as const);

  return attempt;
});

const scheduleObservation = Effect.fn(function* ({
  id,
  candidate,
  storage,
}: {
  id: BillingAttemptId;
  candidate: WompiTransactionId;
  storage: DurableObjectStorage;
}) {
  const sql = yield* SqliteClient;
  const attempt = yield* auditedObservation(id);

  if (Predicate.isNumber(attempt?.followup_due_at_ms)) {
    yield* preserveStoreAlarm(storage, attempt.followup_due_at_ms);
  }

  if (attempt?.status !== "pending") {
    yield* sql`UPDATE billing_provider_transactions SET next_check_ms=NULL WHERE attempt_id=${id}`;

    return absent();
  }

  const next = (yield* Clock.currentTimeMillis) + lookupCooldown;

  const scheduled =
    yield* sql`UPDATE billing_provider_transactions SET next_check_ms=coalesce(next_check_ms,${next}) WHERE transaction_id=${candidate} AND attempt_id=${id} AND checks<${maximumChecks} RETURNING next_check_ms`;

  if (scheduled.length === 1) {
    yield* preserveStoreAlarm(storage, Number(scheduled[0]?.next_check_ms));
  }

  return new Response(null, { status: pendingStatus });
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
    subject: ConsentSubject.User({ userId: work.userId }),
    requirement: "active",
    statement: {
      sql: `UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=? WHERE id=? AND collection_state='armed' AND status='pending' AND wompi_environment=? AND wompi_reference=?
      AND EXISTS(SELECT 1 FROM billing_attempt_context a WHERE a.id=billing_attempts.id AND a.user_id=?)
      AND EXISTS(SELECT 1 FROM payment_sources p WHERE p.id=billing_attempts.payment_source_id AND p.retired_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM subscription_cancellations c WHERE c.payment_source_id=p.id))
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
  input: { candidate: WompiTransactionId; storage: DurableObjectStorage }
) {
  const { candidate, storage } = input;
  const sql = yield* SqliteClient;
  yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      yield* sql`INSERT INTO billing_provider_transactions(transaction_id,attempt_id) SELECT ${candidate},a.id FROM billing_attempt_context a WHERE a.id=${work.attemptId} AND a.user_id=${work.userId} AND a.collection_state='sent' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') ON CONFLICT DO NOTHING`;
      yield* scheduleObservation({ id: work.attemptId, candidate, storage });

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

const recordSubmissionFailure = Effect.fn(function* (work: Work, now: number, certainty: string) {
  const sql = yield* SqliteClient;

  if (certainty === "rejected") {
    yield* sql`UPDATE billing_attempts SET collection_state='rejected' WHERE id=${work.attemptId} AND collection_state='sent' AND collection_sent_at_ms=${now} AND NOT EXISTS(SELECT 1 FROM billing_provider_transactions WHERE attempt_id=${work.attemptId})`;
  }

  return absent();
});

type CollectionContext = {
  env: WompiBindings & Pick<ExternalEventBindings, "DIRECTORY">;
  transport: WompiTransportFactory;
  storage: DurableObjectStorage;
};

const collect = Effect.fn(function* (work: Work, { env, transport, storage }: CollectionContext) {
  const retained = yield* readAttempt(work);

  if (Option.isNone(retained)) return absent();
  const captured = retained.value;

  if (captured.wompi_environment !== env.WOMPI_ENVIRONMENT) return blocked();
  yield* registerAttempt(env.DIRECTORY, work, captured);

  const client = WompiBillingClient.fromOutboundHttp({
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

  if (Result.isFailure(sent)) {
    return yield* recordSubmissionFailure(work, now, sent.failure.certainty);
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
  yield* retainCandidate(work, captured, { candidate, storage });
  const verified = yield* client.findTransaction(candidate);

  if (verified.transactionId !== candidate) return blocked();

  return yield* observe(
    {
      ...work,
      environment: client.environment,
      ...observationFor(verified),
    },
    storage
  ).pipe(withStoreCapacity("required"));
});

export const nativeBillingRequest = Effect.fn(function* ({
  request,
  env,
  owns,
  transport,
  storage,
}: {
  request: Request;
  env: WompiBindings & Pick<ExternalEventBindings, "DIRECTORY">;
  owns: (id: string) => boolean;
  transport: WompiTransportFactory;
  storage: DurableObjectStorage;
}) {
  const body: unknown = yield* Effect.tryPromise(() => request.json());

  if (request.url === collectUserBillingUrl) {
    const work = yield* Schema.decodeUnknownEffect(LocalBillingCollection)(body);

    return owns(work.userId) ? yield* collect(work, { env, transport, storage }) : absent();
  }

  const evidence = yield* Schema.decodeUnknownEffect(Observation)(body);

  return owns(evidence.userId) && evidence.environment === env.WOMPI_ENVIRONMENT
    ? yield* observe(evidence, storage).pipe(withStoreCapacity("required"))
    : absent();
});

export const routeBillingEvent = Effect.fn(function* (
  event: typeof WompiBillingEvent.Type,
  env: WompiBindings & ExternalEventBindings,
  transport: WompiTransportFactory
) {
  if (event.environment !== env.WOMPI_ENVIRONMENT) return;

  const client = WompiBillingClient.fromOutboundHttp({
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

export const reconcileLocalCandidates = Effect.fn(function* (context: {
  env: WompiBindings;
  transport: WompiTransportFactory;
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
}) {
  const { env, transport, storage, owns } = context;
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const due = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const rows =
        yield* sql`UPDATE billing_provider_transactions SET checks=checks+1,next_check_ms=CASE WHEN checks+1<${maximumChecks} THEN ${now + lookupCooldown} END WHERE transaction_id IN (SELECT t.transaction_id FROM billing_provider_transactions t JOIN billing_attempt_context a ON a.id=t.attempt_id WHERE t.next_check_ms<=${now} AND a.collection_state='sent' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining') AND a.wompi_environment=${env.WOMPI_ENVIRONMENT} AND a.status='pending' ORDER BY next_check_ms LIMIT 16) RETURNING transaction_id,attempt_id,(SELECT user_id FROM billing_attempt_context a WHERE a.id=billing_provider_transactions.attempt_id) AS user_id`;

      if (rows.length > 0) yield* preserveStoreAlarm(storage, now + lookupCooldown);

      return yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            transaction_id: WompiTransactionId,
            attempt_id: BillingAttemptId,
            user_id: UserId,
          })
        )
      )(rows);
    })
  );

  if (due.length === 0) return;

  const client = WompiBillingClient.fromOutboundHttp({
    environment: env.WOMPI_ENVIRONMENT,
    outboundHttp: yield* transport(env),
  });

  yield* Effect.forEach(
    due,
    (row) =>
      Effect.gen(function* () {
        if (!owns(row.user_id)) return;
        const found = yield* client.findTransaction(row.transaction_id);

        if (found.transactionId !== row.transaction_id) return;
        yield* observe(
          {
            ...observationFor(found),
            userId: row.user_id,
            attemptId: row.attempt_id,
            environment: env.WOMPI_ENVIRONMENT,
          },
          storage
        ).pipe(withStoreCapacity("required"));
      }).pipe(Effect.result),
    { concurrency: 4 }
  );
});
