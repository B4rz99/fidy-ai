import type { CleanupCommand } from "../../erasure-store/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { ownerCheckRequest, ownerCheckResponse } from "../../maintenance/contract";
import {
  preserveStoreAlarm,
  withStoreAdmission,
  withStoreCapacity,
} from "../../runtime/sqlite/operations";
import { StoreCapacity, type StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { UserId } from "../../../src/core/identity/contract";
import { Price, PriceId, SubscriptionOffers } from "../../../src/core/subscription/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";

import {
  AdmittedPricePublication as publication,
  BillingRegistration as registration,
} from "../contract";

const hourlyWindowMs = 3600000;

const checkCooldownMs = 60000;

const noContent = 204;

const rateLimited = 429;

const conflict = 409;

const terms = Schema.fromJsonString(Price);

const priceRows = Schema.Array(Schema.Struct({ terms }));

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 4096,
  deadlineMilliseconds: 5000,
});

const offers = Effect.gen(function* () {
  yield* (yield* StoreCapacity).observe;
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql`SELECT p.terms FROM selected_prices s JOIN prices p ON p.id=s.price_id
    ORDER BY CASE s.period WHEN 'weekly' THEN 1 WHEN 'monthly' THEN 2 WHEN 'yearly' THEN 3 END LIMIT 4`;

  const decoded = yield* Schema.decodeUnknownEffect(priceRows)(rows);

  return Response.json(
    yield* Schema.encodeEffect(SubscriptionOffers)(
      yield* Schema.decodeUnknownEffect(Schema.toType(SubscriptionOffers))(
        decoded.map((row) => row.terms)
      )
    )
  );
});

type PricingResult = Effect.Effect<
  Response,
  SqlError.SqlError | Schema.SchemaError | StoreCapacityUnavailable,
  SqlClient.SqlClient | StoreCapacity
>;

const publish = (input: typeof publication.Type): PricingResult =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encoded = yield* Schema.encodeEffect(terms)(input.price);

    return yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        if (input.authority.expiresAtMs <= now) return new Response(null, { status: 403 });

        const rows = yield* sql`SELECT p.terms, r.operator_id FROM price_publications r
      JOIN prices p ON p.id=r.price_id WHERE r.id=${input.publicationId}`;

        const receipt = { publicationId: input.publicationId, priceId: input.price.id };

        if (rows.length > 0) {
          const [row] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                terms: Schema.String,
                operator_id: Schema.String,
              }),
            ])
          )(rows);

          return row.terms === encoded && row.operator_id === input.authority.operatorId
            ? Response.json(receipt)
            : new Response(null, { status: 409 });
        }

        const known = yield* sql`SELECT 1 FROM prices WHERE id=${input.price.id}`;

        if (known.length > 0) return new Response(null, { status: 409 });
        yield* admitGrowth;
        yield* sql`INSERT INTO prices VALUES (${input.price.id}, ${encoded})`;

        const changed =
          yield* sql`UPDATE selected_prices SET price_id=${input.price.id} WHERE period=${input.price.billingPeriod} RETURNING price_id`;

        yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ price_id: PriceId })]))(
          changed
        );
        yield* sql`INSERT INTO price_publications VALUES (${input.publicationId}, ${input.price.id}, ${input.authority.operatorId}, ${now})`;

        return Response.json(receipt);
      })
    );
  });

const register = Effect.fn(function* (
  input: typeof registration.Type,
  storage: DurableObjectStorage
) {
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(registration))(input);

  const admissionId =
    input.admission.kind === "renewal"
      ? input.admission.previousPaidAttemptId
      : input.admission.enrollmentId;

  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      if (
        (yield* sql`SELECT 1 WHERE ${input.deadlineMs}<=${yield* Clock.currentTimeMillis} OR EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=${input.userId})`)
          .length > 0
      ) {
        return new Response(null, { status: 410 });
      }

      const saved =
        yield* sql`SELECT r.request, p.terms FROM price_registrations r JOIN prices p ON p.id=r.price_id
      WHERE r.operation_id=${input.operationId} OR (r.user_id=${input.userId} AND r.admission_kind=${input.admission.kind} AND r.admission_id=${admissionId}) LIMIT 2`;

      if (saved.length > 0) {
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ request: Schema.String, terms }))
        )(saved);

        const row = rows[0];

        if (rows.length !== 1 || row?.request !== encoded) {
          return new Response(null, { status: 409 });
        }

        return Response.json({ ...input, price: yield* Schema.encodeEffect(Price)(row.terms) });
      }

      const selected =
        yield* sql`SELECT p.terms FROM selected_prices s JOIN prices p ON p.id=s.price_id WHERE s.period=${input.billingPeriod}`;

      const [row] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ terms })]))(
        selected
      );

      if (
        input.admission.kind === "enrollment" &&
        input.admission.acceptedPriceId !== row.terms.id
      ) {
        return new Response(null, { status: 409 });
      }

      yield* admitGrowth;
      yield* sql`INSERT INTO price_registrations(operation_id,user_id,admission_kind,admission_id,request,price_id,next_check_ms) VALUES (${input.operationId}, ${input.userId}, ${input.admission.kind}, ${admissionId}, ${encoded}, ${row.terms.id},${input.deadlineMs})`;
      yield* preserveStoreAlarm(storage, input.deadlineMs);

      return Response.json({ ...input, price: yield* Schema.encodeEffect(Price)(row.terms) });
    })
  );
});

export const pricingResponse = Effect.fn(function* (
  request: Request,
  storage: DurableObjectStorage,
  hasUserRoute: boolean
) {
  if (ownerCheckRequest(request)) {
    return yield* inspectPricing(storage, hasUserRoute).pipe(withStoreCapacity("required"));
  }

  return yield* pricingCommand(request, storage);
});

const pricingCommand = Effect.fn(function* (request: Request, storage: DurableObjectStorage) {
  const command = request.method + " " + new URL(request.url).pathname;

  if (command === "POST /allow-enrollment") return yield* allowEnrollment(request);

  if (command === "POST /ack") return yield* acknowledgeRequest(request);

  if (command === "GET /offers") return yield* offers;

  if (command === "POST /publish") {
    const input = yield* boundedJsonBody({ request, policy, schema: publication });

    return Option.isNone(input) ? new Response(null, { status: 400 }) : yield* publish(input.value);
  }

  if (command === "POST /register") {
    const input = yield* boundedJsonBody({ request, policy, schema: registration });

    return Option.isNone(input)
      ? new Response(null, { status: 400 })
      : yield* register(input.value, storage);
  }

  return new Response(null, { status: 404 });
});

const RegistrationOutcome = Schema.Struct({
  request: registration,
  outcome: Schema.Literals(["committed", "cancelled"]),
});

const acknowledge = Effect.fn(function* (body: typeof RegistrationOutcome.Type) {
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(registration))(body.request);

  const row =
    yield* sql`UPDATE price_registrations SET outcome=${body.outcome},next_check_ms=NULL WHERE operation_id=${body.request.operationId} AND user_id=${body.request.userId} AND request=${encoded} AND (outcome IS NULL OR outcome=${body.outcome}) RETURNING 1`;

  if (row.length === 1) return new Response(null, { status: 204 });

  const absent =
    yield* sql`SELECT 1 FROM price_registrations WHERE operation_id=${body.request.operationId}`;

  return new Response(null, {
    status: body.outcome === "cancelled" && absent.length === 0 ? noContent : conflict,
  });
});

const firstRegistrationCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [row] =
    yield* sql`SELECT next_check_ms FROM price_registrations WHERE outcome IS NULL ORDER BY next_check_ms LIMIT 1`;

  return row === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(Schema.NullOr(Schema.Int))(row.next_check_ms);
});

const nextRegistrationCheck = Effect.gen(function* () {
  const first = yield* firstRegistrationCheck;

  if (first !== null) return Option.fromUndefinedOr(first);
  const sql = yield* SqlClient.SqlClient;

  const restored =
    yield* sql`UPDATE price_registrations SET next_check_ms=json_extract(request,'$.deadlineMs')
    WHERE operation_id IN (SELECT operation_id FROM price_registrations WHERE outcome IS NULL AND next_check_ms IS NULL LIMIT 16)
    RETURNING next_check_ms`;

  yield* Schema.decodeUnknownEffect(
    Schema.NonEmptyArray(Schema.Struct({ next_check_ms: Schema.Int }))
  )(restored);
  const next = yield* firstRegistrationCheck;

  return Option.some(next ?? (yield* Clock.currentTimeMillis));
});

export const recoverPricing = Effect.fn(function* (
  storage: DurableObjectStorage,
  users: DurableObjectNamespace
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;

  const page = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const due =
        yield* sql`UPDATE price_registrations SET next_check_ms=${now + checkCooldownMs} WHERE operation_id IN(SELECT operation_id FROM price_registrations WHERE outcome IS NULL AND next_check_ms<=${now} ORDER BY next_check_ms LIMIT 16) RETURNING user_id,request,EXISTS(SELECT 1 FROM erasure_barriers e WHERE e.user_id=price_registrations.user_id) AS fenced`;

      const next = yield* nextRegistrationCheck;

      if (Option.isSome(next)) yield* preserveStoreAlarm(storage, next.value);

      return due;
    })
  );

  yield* Effect.forEach(
    page,
    (row) =>
      recoverRegistration(users, { request: row.request, fenced: row.fenced }).pipe(Effect.result),

    { concurrency: 4 }
  );
});

const inspectPricing = Effect.fn(function* (storage: DurableObjectStorage, hasUserRoute: boolean) {
  const next = yield* nextRegistrationCheck;

  if (Option.isNone(next)) return ownerCheckResponse();

  if (!hasUserRoute) return new Response(null, { status: 503 });

  return ownerCheckResponse(yield* preserveStoreAlarm(storage, next.value));
});

const allowEnrollment = Effect.fn(function* (request: Request) {
  const body = yield* boundedJsonBody({
    request,
    policy,
    schema: Schema.Struct({ userId: UserId }),
  });

  if (Option.isNone(body)) return new Response(null, { status: 400 });
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;

  return yield* withStoreCapacity("growth")(
    Effect.gen(function* () {
      yield* sql`DELETE FROM enrollment_allowances WHERE id IN(SELECT id FROM enrollment_allowances WHERE at_ms<=${at - hourlyWindowMs} ORDER BY at_ms LIMIT 32)`;

      const rows =
        yield* sql`INSERT INTO enrollment_allowances(user_id,at_ms) SELECT ${body.value.userId},${at} WHERE NOT EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=${body.value.userId}) AND (SELECT count(*) FROM enrollment_allowances WHERE at_ms>${at - hourlyWindowMs})<10000 AND (SELECT count(*) FROM enrollment_allowances WHERE user_id=${body.value.userId} AND at_ms>${at - hourlyWindowMs})<24 RETURNING id`;

      return new Response(null, { status: rows.length === 1 ? noContent : rateLimited });
    })
  );
});

const acknowledgeRequest = Effect.fn(function* (request: Request) {
  const body = yield* boundedJsonBody({ request, policy, schema: RegistrationOutcome });

  return Option.isNone(body) ? new Response(null, { status: 400 }) : yield* acknowledge(body.value);
});

type RegistrationRow = Readonly<{ request: unknown; fenced: unknown }>;

const recoverRegistration = Effect.fn(function* (
  users: DurableObjectNamespace,
  row: RegistrationRow
) {
  const request = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(registration))(
    row.request
  );

  const fenced = yield* Schema.decodeUnknownEffect(Schema.Literals([0, 1]))(row.fenced);

  const endpoint =
    fenced === 1
      ? "https://user.invalid/billing/registration-cancel"
      : "https://user.invalid/billing/registration-outcome";

  const res = yield* Effect.tryPromise(() =>
    users.getByName(request.userId).fetch(endpoint, {
      method: "POST",
      body: String(row.request),
    })
  );

  if (!res.ok) return;

  const reply = yield* Schema.decodeUnknownEffect(RegistrationOutcome)(
    yield* Effect.tryPromise(() => res.json())
  );

  if (Schema.toEquivalence(registration)(reply.request, request)) yield* acknowledge(reply);
});

export const outstandingPricingRegistrations = (userId: string): OwnedStatement => ({
  sql: "EXISTS(SELECT 1 FROM price_registrations WHERE user_id=? AND outcome IS NULL)",
  params: [userId],
});

const erasurePage = 32;

export const cleanPricingCase = Effect.fn(function* (scope: typeof CleanupCommand.Type) {
  const sql = yield* SqlClient.SqlClient;

  if (
    scope.action !== "clean" ||
    (yield* sql`SELECT 1 FROM price_registrations WHERE user_id=${scope.userId} AND outcome IS NULL LIMIT 1`)
      .length !== 0
  ) {
    return false;
  }

  const removed =
    yield* sql`DELETE FROM price_registrations WHERE operation_id IN(SELECT operation_id FROM price_registrations WHERE user_id=${scope.userId} AND outcome IS NOT NULL LIMIT 32) RETURNING 1`;

  const allowances =
    yield* sql`DELETE FROM enrollment_allowances WHERE id IN(SELECT id FROM enrollment_allowances WHERE user_id=${scope.userId} LIMIT 32) RETURNING 1`;

  return removed.length < erasurePage && allowances.length < erasurePage;
});
