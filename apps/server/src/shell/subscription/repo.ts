import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  Price,
  SubscriptionOffers,
  type SubscriptionOffers as SubscriptionOffersType,
} from "~/core/subscription/model";

const PriceFlatRow = Schema.Struct({
  id: Schema.toEncoded(Price.fields.id),
  amount: Money.fields.amount,
  currency: Money.fields.currency,
  billingPeriod: Price.fields.billingPeriod,
  serviceMarket: Price.fields.serviceMarket,
  taxTreatment: Price.fields.taxTreatment,
  automaticRenewal: Price.fields.renewalTerms.fields.automaticRenewal,
  renewalReminder: Price.fields.renewalTerms.fields.renewalReminder,
  cancellation: Price.fields.renewalTerms.fields.cancellation,
  paidAccessEnds: Price.fields.renewalTerms.fields.paidAccessEnds,
  paymentMethods: Price.fields.paymentMethods,
});

const priceColumns = `revision.id, revision.amount, revision.currency,
  revision.billing_period AS "billingPeriod", revision.service_market AS "serviceMarket",
  revision.tax_treatment AS "taxTreatment", revision.automatic_renewal AS "automaticRenewal",
  revision.renewal_reminder AS "renewalReminder", revision.cancellation,
  revision.paid_access_ends AS "paidAccessEnds", revision.payment_methods AS "paymentMethods"`;

const decodePrice = Schema.decodeUnknownEffect(Price);
const priceFromRow = Effect.fn("priceFromRow")((row: typeof PriceFlatRow.Type) =>
  decodePrice({
    id: row.id,
    money: { amount: encodeMoneyAmount(row.amount), currency: row.currency },
    billingPeriod: row.billingPeriod,
    serviceMarket: row.serviceMarket,
    taxTreatment: row.taxTreatment,
    renewalTerms: {
      automaticRenewal: row.automaticRenewal,
      renewalReminder: row.renewalReminder,
      cancellation: row.cancellation,
      paidAccessEnds: row.paidAccessEnds,
    },
    paymentMethods: row.paymentMethods,
  })
);

/** Finds one immutable Price by stable identity without treating caller input as terms. */
export const findPrice = Effect.fn("Subscription.findPrice")(function* (priceId: Price["id"]) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: PriceFlatRow,
    execute: () => sql`
      SELECT ${sql.literal(priceColumns)}
      FROM prices AS revision
      WHERE revision.id = ${priceId}
    `,
  })(undefined).pipe(Effect.orDie);
  return yield* Option.match(row, {
    onNone: () => Effect.succeed(Option.none<Price>()),
    onSome: (value) => Effect.map(priceFromRow(value), Option.some).pipe(Effect.orDie),
  });
});

/** The current authoritative Subscription offers in presentation order. */
export const selectSubscriptionOffers: Effect.Effect<
  SubscriptionOffersType,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: PriceFlatRow,
    execute: () => sql`
      SELECT ${sql.literal(priceColumns)}
      FROM published_prices AS publication
      INNER JOIN prices AS revision ON revision.id = publication.price_id
      ORDER BY publication.offer_order
    `,
  })(undefined).pipe(Effect.orDie);
  const revisions = yield* Effect.forEach(rows, priceFromRow).pipe(Effect.orDie);
  return yield* Schema.decodeUnknownEffect(Schema.toType(SubscriptionOffers))(revisions).pipe(
    Effect.orDie
  );
});
