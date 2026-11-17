import { withStoreAdmission } from "../../runtime/sqlite/operations";
import { StoreCapacity, type StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { UserId } from "../../../src/core/identity/contract";
import {
  BillingAttemptId,
  BillingPeriod,
  PaymentEnrollmentId,
  Price,
  PriceId,
  SubscriptionOffers,
} from "../../../src/core/subscription/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";

import { AdmittedPricePublication as publication } from "../contract";

const registration = Schema.Struct({
  userId: UserId,
  operationId: Schema.String.check(Schema.isUUID()),
  admission: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("renewal"), previousPaidAttemptId: BillingAttemptId }),
    Schema.Struct({
      kind: Schema.Literal("enrollment"),
      enrollmentId: PaymentEnrollmentId,
      acceptedPriceId: PriceId,
    }),
  ]),
  inputsDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  billingPeriod: BillingPeriod,
  deadlineMs: Schema.Int,
});
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

const register = (input: typeof registration.Type): PricingResult =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(registration))(input);
    const admissionId =
      input.admission.kind === "renewal"
        ? input.admission.previousPaidAttemptId
        : input.admission.enrollmentId;
    return yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        if (input.deadlineMs <= (yield* Clock.currentTimeMillis)) {
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
        yield* sql`INSERT INTO price_registrations VALUES (${input.operationId}, ${input.userId}, ${input.admission.kind}, ${admissionId}, ${encoded}, ${row.terms.id})`;
        return Response.json({ ...input, price: yield* Schema.encodeEffect(Price)(row.terms) });
      })
    );
  });

export const pricingResponse = (request: Request): PricingResult =>
  Effect.gen(function* () {
    const command = request.method + " " + new URL(request.url).pathname;
    if (command === "GET /offers") return yield* offers;
    if (command === "POST /publish") {
      const input = yield* boundedJsonBody({ request, policy, schema: publication });
      return Option.isNone(input)
        ? new Response(null, { status: 400 })
        : yield* publish(input.value);
    }
    if (command === "POST /register") {
      const input = yield* boundedJsonBody({ request, policy, schema: registration });
      return Option.isNone(input)
        ? new Response(null, { status: 400 })
        : yield* register(input.value);
    }
    return new Response(null, { status: 404 });
  });
