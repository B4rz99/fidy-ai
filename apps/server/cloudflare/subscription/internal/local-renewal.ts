import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  BillingAttempt,
  BillingAttemptId,
  BillingPeriod,
  renewalGraceMs,
} from "../../../src/core/subscription/contract";
import { UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { renewalPeriod } from "../../../src/core/subscription/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";

import { type WompiBindings } from "../contract";
import {
  type Registration,
  finishAdmission,
  hashInputs,
  insertAttempt,
  priceCodec,
  registerTerms,
  requestCodec,
  saveRegistration,
} from "./local-billing-admission";

type RenewalContext = {
  env: WompiBindings & { PRICING: DurableObjectNamespace };
  storage: DurableObjectStorage;
  owns: (id: string) => boolean;
};

const oneDay = 86400000;

const cooldown = 60000;

const maxAttempts = 3;

const Boundary = Schema.Struct({
  user_id: UserId,
  id: BillingAttemptId,
  payment_source_id: Schema.String,
  paid_ends_at_ms: Schema.Int,
  anchor: Schema.Int,
  billing_period: BillingPeriod,
  time_zone: IanaTimeZone,
});

type Boundary = typeof Boundary.Type;

const readBoundary = Effect.fn(function* (id: string, environment: string, now: number) {
  const sql = yield* SqliteClient;

  const guard = protectConsentStatement({
    subject: ConsentSubject.Owner({ column: "a.user_id" }),
    requirement: "active",
    statement: {
      sql: `SELECT a.user_id,a.id,a.payment_source_id,a.paid_ends_at_ms,COALESCE(a.calendar_anchor_ms,a.paid_starts_at_ms) anchor,a.billing_period,a.time_zone FROM billing_attempt_context a JOIN subscription_standing s ON s.attempt_id=a.id AND s.user_id=a.user_id JOIN payment_source_context p ON p.id=a.payment_source_id AND p.user_id=a.user_id
    WHERE a.id=? AND a.status='succeeded' AND p.retired_at_ms IS NULL AND a.wompi_environment=? AND p.wompi_environment=a.wompi_environment AND a.paid_ends_at_ms<=? AND a.paid_ends_at_ms+?>?
    AND NOT EXISTS(SELECT 1 FROM subscription_renewal_fences WHERE user_id=a.user_id) AND NOT EXISTS(SELECT 1 FROM erasure_requests)
    AND NOT EXISTS(SELECT 1 FROM billing_attempt_context b WHERE b.user_id=a.user_id AND b.no_charge_confirmed_at_ms IS NULL AND (b.status='pending' OR (b.status='failed' AND b.previous_paid_attempt_id IS NULL)))`,
      params: [id, environment, now, renewalGraceMs, now],
    },
  });

  const [row] = yield* sql.unsafe(guard.sql, guard.params);

  return Schema.decodeUnknownOption(Boundary)(row);
});

const capture = Effect.fn(function* (
  boundary: Boundary,
  env: WompiBindings,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;

  const [retained] =
    yield* sql`SELECT request FROM billing_admissions WHERE subject_id=${boundary.id} AND user_id=${boundary.user_id}`;

  const inputsDigest = yield* hashInputs(
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
      boundary,
      env.WOMPI_ENVIRONMENT,
    ])
  );

  if (retained !== undefined) {
    const prior = yield* Schema.decodeUnknownEffect(requestCodec)(retained.request);

    if (prior.inputsDigest !== inputsDigest) {
      return yield* Effect.fail("renewal-inputs-changed" as const);
    }

    return prior;
  }

  const reg: Registration = {
    operationId: newId(),
    userId: boundary.user_id,
    admission: { kind: "renewal", previousPaidAttemptId: boundary.id },
    deadlineMs: boundary.paid_ends_at_ms + renewalGraceMs,
    billingPeriod: boundary.billing_period,
    inputsDigest,
  };

  if ((yield* saveRegistration(reg, storage)) === undefined) {
    return yield* Effect.fail("registration-conflict" as const);
  }

  return reg;
});

const reserveRenewal = Effect.fn(function* (id: string, context: RenewalContext) {
  const { env, storage, owns } = context;
  const now = yield* Clock.currentTimeMillis;
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const [due] =
        yield* sql`UPDATE billing_attempts SET followup_due_at_ms=${now + cooldown} WHERE id=${id} AND followup_due_at_ms<=${now} RETURNING paid_ends_at_ms`;

      if (due === undefined) return Option.none();
      const deadline = Number(due.paid_ends_at_ms) + renewalGraceMs;

      if (deadline <= now) {
        yield* sql`UPDATE billing_attempts SET followup_due_at_ms=NULL WHERE id=${id}`;

        return Option.none();
      }

      yield* preserveStoreAlarm(storage, Math.min(deadline, now + cooldown));
      const boundary = yield* readBoundary(id, env.WOMPI_ENVIRONMENT, now);

      if (Option.isNone(boundary) || !owns(boundary.value.user_id)) return Option.none();

      return Option.some({
        boundary: boundary.value,
        reg: yield* capture(boundary.value, env, storage),
      });
    })
  );
});

const previousAttempts = Effect.fn(function* (reg: Registration, boundary: Boundary, at: number) {
  const sql = yield* SqliteClient;
  const id = boundary.id;

  const [receipt] =
    yield* sql`SELECT outcome FROM billing_admissions WHERE operation_id=${reg.operationId} AND user_id=${reg.userId}`;

  if (receipt === undefined) return;

  const [latest] =
    yield* sql`SELECT status,renewal_attempt_number FROM billing_attempts WHERE previous_paid_attempt_id=${id} ORDER BY renewal_attempt_number DESC LIMIT 1`;

  if (latest === undefined) return receipt.outcome === null ? 0 : undefined;

  if (receipt.outcome !== "committed" || latest.status !== "failed") return;
  const count = Number(latest.renewal_attempt_number);

  if (count >= maxAttempts || at < boundary.paid_ends_at_ms + count * oneDay) return;

  return count;
});

export const processRenewal = Effect.fn(function* (id: string, context: RenewalContext) {
  const { env, storage } = context;
  const sql = yield* SqliteClient;
  const initial = yield* reserveRenewal(id, context);

  if (Option.isNone(initial)) return;
  const { boundary, reg } = initial.value;

  const [first] =
    yield* sql`SELECT price_terms FROM billing_attempts WHERE previous_paid_attempt_id=${id} AND renewal_attempt_number=1`;

  const terms =
    first !== undefined
      ? Option.some(yield* Schema.decodeUnknownEffect(priceCodec)(first.price_terms))
      : yield* registerTerms(env.PRICING, reg);

  if (Option.isNone(terms)) return;
  const price = terms.value;

  const window = yield* renewalPeriod({
    timeZone: boundary.time_zone,
    billingPeriod: boundary.billing_period,
    originalStartsAt: DateTime.makeUnsafe(boundary.anchor),
    previousEndsAt: DateTime.makeUnsafe(boundary.paid_ends_at_ms),
  });

  yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const live = yield* readBoundary(id, env.WOMPI_ENVIRONMENT, at);

      if (Option.isNone(live) || !Schema.toEquivalence(Boundary)(boundary, live.value)) return;
      const count = yield* previousAttempts(reg, boundary, at);

      if (count === undefined) return;

      const attempt = yield* insertAttempt({
        id: count === 0 ? reg.operationId : newId(),
        user: reg.userId,
        source: boundary.payment_source_id,
        price,
        zone: boundary.time_zone,
        environment: env.WOMPI_ENVIRONMENT,
        now: at,
        period: Option.some({
          previous: id,
          starts: DateTime.toEpochMillis(window.startsAt),
          ends: DateTime.toEpochMillis(window.endsAt),
          anchor: boundary.anchor,
          number: count + 1,
        }),
        storage,
      });

      if (count === 0) {
        const report = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(BillingAttempt))
        )(attempt);

        yield* finishAdmission({ reg, price, report, now: at, session: Option.none() });
      }

      const next = Math.min(reg.deadlineMs, boundary.paid_ends_at_ms + (count + 1) * oneDay);
      yield* sql`UPDATE billing_attempts SET followup_due_at_ms=${next} WHERE id=${id}`;
      yield* preserveStoreAlarm(storage, next);
    })
  );
});
