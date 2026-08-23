import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  PriceRevision,
  SubscriptionOffers,
  type SubscriptionOffers as SubscriptionOffersType,
} from "~/core/subscription/model";

const PriceRevisionFlatRow = Schema.Struct({
  id: Schema.toEncoded(PriceRevision.fields.id),
  amount: Money.fields.amount,
  currency: Money.fields.currency,
  billingPeriod: PriceRevision.fields.billingPeriod,
  serviceMarket: PriceRevision.fields.serviceMarket,
  taxTreatment: PriceRevision.fields.taxTreatment,
  automaticRenewal: PriceRevision.fields.renewalTerms.fields.automaticRenewal,
  renewalReminder: PriceRevision.fields.renewalTerms.fields.renewalReminder,
  cancellation: PriceRevision.fields.renewalTerms.fields.cancellation,
  paidAccessEnds: PriceRevision.fields.renewalTerms.fields.paidAccessEnds,
  paymentMethods: PriceRevision.fields.paymentMethods,
});

const priceRevisionColumns = `revision.id, revision.amount, revision.currency,
  revision.billing_period AS "billingPeriod", revision.service_market AS "serviceMarket",
  revision.tax_treatment AS "taxTreatment", revision.automatic_renewal AS "automaticRenewal",
  revision.renewal_reminder AS "renewalReminder", revision.cancellation,
  revision.paid_access_ends AS "paidAccessEnds", revision.payment_methods AS "paymentMethods"`;

const decodePriceRevision = Schema.decodeUnknownEffect(PriceRevision);
const priceRevisionFromRow = Effect.fn("priceRevisionFromRow")(
  (row: typeof PriceRevisionFlatRow.Type) =>
    decodePriceRevision({
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

/** The current authoritative Subscription offers in presentation order. */
export const selectSubscriptionOffers: Effect.Effect<
  SubscriptionOffersType,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: PriceRevisionFlatRow,
    execute: () => sql`
      SELECT ${sql.literal(priceRevisionColumns)}
      FROM published_price_revisions AS publication
      INNER JOIN price_revisions AS revision ON revision.id = publication.price_revision_id
      ORDER BY publication.offer_order
    `,
  })(undefined).pipe(Effect.orDie);
  const revisions = yield* Effect.forEach(rows, priceRevisionFromRow).pipe(Effect.orDie);
  return yield* Schema.decodeUnknownEffect(Schema.toType(SubscriptionOffers))(revisions).pipe(
    Effect.orDie
  );
});
