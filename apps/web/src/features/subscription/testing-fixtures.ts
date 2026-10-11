import { BigDecimal, DateTime, Option } from "effect";
import {
  BillingEmail,
  type EnrollmentAvailability,
  PaymentEnrollmentId,
  type PaymentSubmission,
  PriceId,
  type SubscriptionStatus,
} from "@/transport/client";
import type { SubscriptionOffers } from "./presentation";
import type { PreparedEnrollment } from "./enrollment-gateway";

const renewalTerms = {
  automaticRenewal: true,
  renewalReminder: "none",
  cancellation: "future-renewals-only",
  paidAccessEnds: "paid-period-end",
} as const;
const paymentMethods = ["card", "nequi", "daviplata"] as const;
export const offers: SubscriptionOffers = [
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000001"),
    money: { amount: BigDecimal.fromStringUnsafe("9900"), currency: "COP" },
    billingPeriod: "weekly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000002"),
    money: { amount: BigDecimal.fromStringUnsafe("28900"), currency: "COP" },
    billingPeriod: "monthly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
  {
    id: PriceId.make("22700000-0000-4000-8000-000000000003"),
    money: { amount: BigDecimal.fromStringUnsafe("289900"), currency: "COP" },
    billingPeriod: "yearly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    renewalTerms,
    paymentMethods,
  },
];

const sha256HexCharacters = 64;
export const preparedEnrollment = {
  status: "prepared" as const,
  method: "card" as const,
  enrollmentId: PaymentEnrollmentId.make("22700000-0000-4000-8000-000000000090"),
  price: offers[1],
  billingEmail: BillingEmail.make("verified@example.com"),
  contracts: {
    endUserPolicy: {
      kind: "end-user-policy" as const,
      permalink: new URL("https://wompi.co/end-user"),
      displayedText: "Acepto el reglamento de Wompi.",
      contentSha256: "a".repeat(sha256HexCharacters),
      providerContentHash: "d".repeat(sha256HexCharacters),
      observedAt: DateTime.makeUnsafe("2026-03-01T00:00:00Z"),
    },
    personalDataAuthorization: {
      kind: "personal-data-authorization" as const,
      permalink: new URL("https://wompi.co/personal-data"),
      displayedText: "Autorizo el tratamiento de datos personales de Wompi.",
      contentSha256: "b".repeat(sha256HexCharacters),
      providerContentHash: "e".repeat(sha256HexCharacters),
      observedAt: DateTime.makeUnsafe("2026-03-01T00:00:00Z"),
    },
  },
  recurringDisclosure: {
    revision: "wompi-card-enrollment-v1" as const,
    displayedText: "Autorizo los cobros recurrentes de mi suscripción.",
    contentSha256: "c".repeat(sha256HexCharacters),
  },
  wompiPublicKey: "pub_test_12345678",
  paymentSourceMode: "create" as const,
  expiresAt: DateTime.makeUnsafe("2026-03-01T00:15:00Z"),
};

export const enrollmentGateway = {
  availability: (): Promise<EnrollmentAvailability> =>
    Promise.resolve({ enabledMethods: ["card", "nequi"] as const }),
  startDaviplata: (): Promise<never> => Promise.reject(new Error("DaviPlata unavailable")),
  continue: (): Promise<
    Readonly<{
      status: "source-verifying";
      enrollmentId: typeof preparedEnrollment.enrollmentId;
    }>
  > =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  observeBillingAttempt: (): Promise<PaymentSubmission> =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  prepare: (): Promise<typeof preparedEnrollment> => Promise.resolve(preparedEnrollment),
  resume: (): Promise<Option.Option<never>> => Promise.resolve(Option.none()),
  submit: (): Promise<
    Readonly<{
      status: "source-verifying";
      enrollmentId: typeof preparedEnrollment.enrollmentId;
    }>
  > =>
    Promise.resolve({
      status: "source-verifying",
      enrollmentId: preparedEnrollment.enrollmentId,
    }),
  status: (): Promise<typeof preparedEnrollment> => Promise.resolve(preparedEnrollment),
};

export const daviplataEnrollment: PreparedEnrollment = {
  ...preparedEnrollment,
  method: "daviplata",
  daviplataOtpPolicy: {
    sendUrl: "https://sandbox.wompi.co/synthetic/send",
    confirmUrl: "https://sandbox.wompi.co/synthetic/confirm",
  },
};

const trialPeriod = {
  startedAt: DateTime.makeUnsafe("2026-09-01T12:00:00Z"),
  endsAt: DateTime.makeUnsafe("2026-09-08T12:00:00Z"),
};
export const trialStanding: SubscriptionStatus = {
  accessTier: "free",
  trialPeriod,
  paidSubscription: Option.none(),
  recentAttempts: [],
};
