import { deleteTargetEvidence, operationEvidenceSchema } from "../../storage-operations/contract";
import {
  cleanupBarrierColumns,
  deletionWitness,
  erasureBarrierSchema,
} from "../../erasure-store/operations";
import type { StoreHistory } from "../../runtime/sqlite/contract";
import { Schema } from "effect";
import { Price, SubscriptionOffers } from "../../../src/core/subscription/contract";

const initialOffers = Schema.decodeUnknownSync(SubscriptionOffers)(
  [
    { id: "22700000-0000-4000-8000-000000000001", billingPeriod: "weekly", amount: "9900" },
    { id: "22700000-0000-4000-8000-000000000002", billingPeriod: "monthly", amount: "28900" },
    { id: "22700000-0000-4000-8000-000000000003", billingPeriod: "yearly", amount: "289900" },
  ].map(({ id, billingPeriod, amount }) => ({
    id,
    billingPeriod,
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    money: { amount, currency: "COP" },
    renewalTerms: {
      automaticRenewal: true,
      renewalReminder: "none",
      cancellation: "future-renewals-only",
      paidAccessEnds: "paid-period-end",
    },
    paymentMethods: ["card", "nequi", "daviplata"],
  }))
);

export const pricingHistory: StoreHistory = {
  owner: "pricing",
  steps: [
    {
      version: 1,
      id: "initial-prices-and-registrations",
      statements: [
        "CREATE TABLE prices (id TEXT PRIMARY KEY, terms TEXT NOT NULL) STRICT",
        "CREATE TABLE selected_prices (period TEXT PRIMARY KEY, price_id TEXT NOT NULL REFERENCES prices(id)) STRICT",
        `CREATE TABLE price_publications (
      id TEXT PRIMARY KEY, price_id TEXT NOT NULL UNIQUE REFERENCES prices(id), operator_id TEXT NOT NULL, published_at_ms INTEGER NOT NULL
    ) STRICT`,
        `CREATE TABLE price_registrations (
      operation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, admission_kind TEXT NOT NULL, admission_id TEXT NOT NULL,
      request TEXT NOT NULL, price_id TEXT NOT NULL REFERENCES prices(id), UNIQUE(user_id,admission_kind,admission_id)
    ) STRICT`,
        ...initialOffers.flatMap((price) => [
          {
            sql: "INSERT INTO prices VALUES (?,?)",
            bindings: [price.id, Schema.encodeSync(Schema.fromJsonString(Price))(price)],
          },
          {
            sql: "INSERT INTO selected_prices VALUES (?,?)",
            bindings: [price.billingPeriod, price.id],
          },
        ]),
      ],
    },
    {
      version: 2,
      id: "registration-outcomes",
      statements: [
        "ALTER TABLE price_registrations ADD COLUMN outcome TEXT CHECK(outcome IN('committed','cancelled'))",
        "ALTER TABLE price_registrations ADD COLUMN next_check_ms INTEGER",
        "CREATE INDEX pricing_check_due ON price_registrations(next_check_ms) WHERE outcome IS NULL",
        "CREATE TABLE enrollment_allowances(id INTEGER PRIMARY KEY,user_id TEXT NOT NULL,at_ms INTEGER NOT NULL) STRICT",
        "CREATE INDEX enrollment_allowance_time ON enrollment_allowances(at_ms)",
        "CREATE INDEX enrollment_allowance_user ON enrollment_allowances(user_id,at_ms)",
      ],
    },
    {
      version: 3,
      id: "user-erasure-barrier",
      statements: [
        erasureBarrierSchema,
        "CREATE TRIGGER reconcile_erasing_registrations AFTER INSERT ON erasure_barriers BEGIN UPDATE price_registrations SET next_check_ms=NEW.requested_at_ms WHERE user_id=NEW.user_id AND outcome IS NULL; END",
      ],
    },
    {
      version: 4,
      id: "erasure-cleanup-receipts",
      statements: [
        ...cleanupBarrierColumns,
        deletionWitness({
          table: "price_registrations",
          deadline: "json_extract(OLD.request,'$.deadlineMs')",
          owner: "OLD.user_id",
        }),
        deletionWitness({ table: "enrollment_allowances", deadline: "0", owner: "OLD.user_id" }),
      ],
    },
    {
      version: 5,
      id: "exact-operator-evidence",
      statements: [
        ...operationEvidenceSchema,
        deleteTargetEvidence({
          family: "registration",
          table: "price_registrations",
          column: "operation_id",
        }),
        deleteTargetEvidence({ family: "publication", table: "price_publications", column: "id" }),
      ],
    },
  ],
};
