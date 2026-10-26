import type { Page, Route } from "@playwright/test";
import { Effect, Schema } from "effect";
import {
  EnrollmentAvailability,
  PriceId,
  type SubscriptionOffers,
  type SubscriptionStatus,
} from "@fidy/server/client";
import { apiOrigin, installUser, makeUser, response } from "./http-fixtures";

const successStatus = 200;
const missingStatus = 404;
const unavailableStatus = 503;
const appOrigin = "https://127.0.0.1:4173";
const enrollmentPath = "/web/subscription/payment-enrollments";
const enrollmentId = "15520000-0000-4000-8000-000000000001";
const attemptId = "15520000-0000-4000-8000-000000000002";
const monthlyId = "15520000-0000-4000-8000-000000000011";
const otpEndpoint = "https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox";
const daviplataToken = "daviplata_devtest_visual";
const providerOrigin = "https://sandbox.wompi.co";
const providerHeaders = {
  "access-control-allow-origin": appOrigin,
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
type Offer = (typeof SubscriptionOffers.Encoded)[number];
type BillingAttempt = (typeof SubscriptionStatus.Encoded)["recentAttempts"][number];
const offer = (id: string, billingPeriod: Offer["billingPeriod"], amount: string): Offer => ({
  id,
  billingPeriod,
  money: { amount, currency: "COP" },
  serviceMarket: "CO",
  taxTreatment: "not-taxable",
  renewalTerms: {
    automaticRenewal: true,
    renewalReminder: "none",
    cancellation: "future-renewals-only",
    paidAccessEnds: "paid-period-end",
  },
  paymentMethods: ["card", "nequi", "daviplata"],
});
const offers = [
  offer("15520000-0000-4000-8000-000000000010", "weekly", "9900"),
  offer(monthlyId, "monthly", "28900"),
  offer("15520000-0000-4000-8000-000000000012", "yearly", "289900"),
];
const attemptSnapshot = {
  id: attemptId,
  priceId: monthlyId,
  money: { amount: "28900", currency: "COP" },
  billingPeriod: "monthly",
  serviceMarket: "CO",
  taxTreatment: "not-taxable",
  timeZone: "America/Bogota",
  createdAt: "2026-10-25T14:00:00Z",
} as const;
const billingAttempt = (status: BillingAttempt["status"]): BillingAttempt => {
  if (status === "failed") return { ...attemptSnapshot, status, failedAt: "2026-10-25T14:03:00Z" };
  if (status === "succeeded") {
    return {
      ...attemptSnapshot,
      status,
      finalizedAt: "2026-10-25T14:01:00Z",
      paidPeriodEndsAt: "2026-11-25T14:00:00Z",
      renewalAnchor: "2026-10-25T14:00:00Z",
    };
  }
  return { ...attemptSnapshot, status };
};
const freeStanding = {
  accessTier: "free",
  trialPeriod: makeUser().trialPeriod,
  paidSubscription: null,
  recentAttempts: [],
};
const paidStanding = {
  ...freeStanding,
  accessTier: "pro",
  paidSubscription: {
    priceId: monthlyId,
    money: { amount: "28900", currency: "COP" },
    billingPeriod: "monthly",
    serviceMarket: "CO",
    taxTreatment: "not-taxable",
    startsAt: "2026-10-25T14:00:00Z",
    endsAt: "2026-11-25T14:00:00Z",
    renewalAnchor: "2026-10-25T14:00:00Z",
  },
  recentAttempts: [
    billingAttempt("succeeded"),
    {
      ...billingAttempt("failed"),
      id: "15520000-0000-4000-8000-000000000003",
      createdAt: "2026-10-24T14:00:00Z",
      failedAt: "2026-10-24T14:03:00Z",
    },
    {
      ...billingAttempt("succeeded"),
      id: "15520000-0000-4000-8000-000000000004",
      createdAt: "2026-09-25T14:00:00Z",
      finalizedAt: "2026-09-25T14:01:00Z",
      paidPeriodEndsAt: "2026-10-25T14:00:00Z",
      renewalAnchor: "2026-09-25T14:00:00Z",
    },
  ],
};
const sha256Length = 64;
const contract = (kind: "end-user-policy" | "personal-data-authorization"): unknown => ({
  kind,
  permalink: `https://wompi.co/${kind}`,
  displayedText: kind,
  contentSha256: "a".repeat(sha256Length),
  providerContentHash: "b".repeat(sha256Length),
  observedAt: "2026-10-25T14:00:00Z",
});
const methodSchema = EnrollmentAvailability.fields.enabledMethods.value;
type PaymentMethod = typeof methodSchema.Type;
const preparePayload = Schema.Struct({ priceId: PriceId, method: methodSchema });
export type SubscriptionFixtureState =
  | "form"
  | "pending"
  | "approved"
  | "declined"
  | "source-available"
  | "source-verifying"
  | "expired"
  | "refused"
  | "uncertain"
  | "paid"
  | "unavailable"
  | "offers-unavailable";
const preparedEnrollment = (
  method: PaymentMethod,
  priceId: string,
  state: SubscriptionFixtureState
): unknown => ({
  status: "prepared",
  method,
  enrollmentId,
  price: offers.find((current) => current.id === priceId),
  billingEmail: "",
  paymentSourceMode:
    method === "card" && ["pending", "approved", "declined", "source-verifying"].includes(state)
      ? "reuse"
      : "create",
  wompiPublicKey: "pub_test_synthetic_visual",
  expiresAt: "2099-01-01T00:00:00Z",
  contracts: {
    endUserPolicy: contract("end-user-policy"),
    personalDataAuthorization: contract("personal-data-authorization"),
  },
  recurringDisclosure: {
    revision: `wompi-${method}-enrollment-v1`,
    displayedText: "Cobros recurrentes",
    contentSha256: "c".repeat(sha256Length),
  },
  ...(method === "daviplata"
    ? { daviplataOtpPolicy: { sendUrl: otpEndpoint, confirmUrl: otpEndpoint } }
    : {}),
});
const paymentStatus = (state: SubscriptionFixtureState): BillingAttempt["status"] => {
  if (state === "approved") return "succeeded";
  if (state === "declined") return "failed";
  return "pending";
};
const submission = (state: SubscriptionFixtureState): unknown =>
  state === "source-verifying"
    ? { status: "source-verifying", enrollmentId }
    : {
        status: "payment-pending",
        enrollmentId,
        billingAttempt: billingAttempt(paymentStatus(state)),
      };
const enrollmentStatus = (
  state: SubscriptionFixtureState,
  method: PaymentMethod,
  priceId: string
): unknown => ({
  status: state === "source-available" ? "available" : state,
  enrollmentId,
  method,
  priceId,
  ...(state === "refused" ? { reason: "provider-declined" } : {}),
});
const fulfillJson = (route: Route, value: unknown, status = successStatus): Promise<void> =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

const providerReply = (url: URL): unknown => {
  if (url.pathname.startsWith("/v1/tokens/nequi")) {
    return { data: { id: "nequi_test_synthetic_visual", status: "PENDING" } };
  }
  if (url.pathname === "/v1/tokens/daviplata") {
    return {
      data: {
        id: daviplataToken,
        status: "PENDING",
        url_services: {
          token: "synthetic-visual-initial",
          code_otp_send: `${otpEndpoint}?token=${daviplataToken}&operation=RESEND_OTP`,
          code_otp_validate: `${otpEndpoint}?token=${daviplataToken}&operation=VALIDATE_OTP_API`,
        },
      },
    };
  }
  return {
    data: {
      subscription: { PK: daviplataToken, status: "PENDING" },
      authorization: { access_token: "synthetic-visual-sent" },
      attempts: {
        currentSendCode: 1,
        limitSendCode: 2,
        currentValidateCode: 0,
        limitValidateCode: 2,
      },
    },
  };
};

type Observation = Readonly<{
  unexpectedRequests: Array<string>;
  preparations: Array<PaymentMethod>;
  submissions: Array<string>;
  providerCalls: Array<string>;
}>;
type Fixture = Readonly<{
  state: SubscriptionFixtureState;
  enabledMethods: ReadonlyArray<PaymentMethod>;
  observed: Observation;
}>;
const fixtureReads = (fixture: Fixture): Map<string, string> =>
  new Map([
    ["/web/session/binding", JSON.stringify({ binding: "15520000-0000-4000-8000-000000000005" })],
    ["/subscription/offers", response(offers)],
    [
      "/subscription/status",
      response(
        ["paid", "offers-unavailable"].includes(fixture.state) ? paidStanding : freeStanding
      ),
    ],
    ["/ingestion/review-workspace", response({ pendingCount: 0, total: 0, items: [] })],
    [`${enrollmentPath}/availability`, JSON.stringify({ enabledMethods: fixture.enabledMethods })],
    [
      `/web/subscription/billing-attempts/${attemptId}`,
      JSON.stringify(billingAttempt(paymentStatus(fixture.state))),
    ],
  ]);
const apiMutation = (route: Route, fixture: Fixture): Promise<void> => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  if (request.method() === "POST" && path === `${enrollmentPath}/prepare`) {
    const payload: unknown = request.postDataJSON();
    const { method, priceId } = Schema.decodeUnknownSync(preparePayload)(payload);
    fixture.observed.preparations.push(method);
    return fulfillJson(
      route,
      ["source-available", "expired", "refused"].includes(fixture.state)
        ? enrollmentStatus(fixture.state, method, priceId)
        : preparedEnrollment(method, priceId, fixture.state)
    );
  }
  if (request.method() === "POST" && path === `${enrollmentPath}/submit`) {
    fixture.observed.submissions.push(request.postData() ?? "");
    return fulfillJson(route, submission(fixture.state));
  }
  fixture.observed.unexpectedRequests.push(`${request.method()} ${path}`);
  return fulfillJson(route, {}, missingStatus);
};
const installApiFixture = Effect.fnUntraced(function* (page: Page, fixture: Fixture) {
  const reads = fixtureReads(fixture);
  yield* Effect.tryPromise(() =>
    page.route(`${apiOrigin}/**`, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== "GET") return apiMutation(route, fixture);
      if (fixture.state === "offers-unavailable" && path === "/subscription/offers") {
        return fulfillJson(route, {}, unavailableStatus);
      }
      if (fixture.state === "unavailable" && path === "/subscription/status") {
        return fulfillJson(route, {}, unavailableStatus);
      }
      const body = reads.get(path);
      if (body === undefined) {
        fixture.observed.unexpectedRequests.push(`GET ${path}`);
        return fulfillJson(route, {}, missingStatus);
      }
      return route.fulfill({ status: successStatus, contentType: "application/json", body });
    })
  );
});
const providerRoute = (route: Route, fixture: Fixture): Promise<void> => {
  const url = new URL(route.request().url());
  if (route.request().method() === "OPTIONS") {
    return route.fulfill({ status: successStatus, headers: providerHeaders });
  }
  const known =
    url.pathname.startsWith("/v1/tokens/nequi") ||
    url.pathname === "/v1/tokens/daviplata" ||
    url.pathname === new URL(otpEndpoint).pathname;
  if (!known) {
    fixture.observed.unexpectedRequests.push(`provider ${url.pathname}`);
    return route.abort("blockedbyclient");
  }
  const operation = url.searchParams.get("operation");
  fixture.observed.providerCalls.push(operation ?? url.pathname);
  if (fixture.state === "uncertain" && operation === "VALIDATE_OTP_API") {
    return route.abort("failed");
  }
  return route.fulfill({
    status: successStatus,
    headers: providerHeaders,
    contentType: "application/json",
    body: JSON.stringify(providerReply(url)),
  });
};

/** Every non-app request is fulfilled synthetically or refused; captures cannot reach a provider. */
export const installSubscriptionFixture = Effect.fnUntraced(function* (
  page: Page,
  state: SubscriptionFixtureState = "form",
  enabledMethods: ReadonlyArray<PaymentMethod> = ["card", "nequi", "daviplata"]
) {
  const observed: Observation = {
    unexpectedRequests: [],
    preparations: [],
    submissions: [],
    providerCalls: [],
  };
  const fixture = { state, enabledMethods, observed };
  yield* Effect.tryPromise(() =>
    page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin === appOrigin) return route.continue();
      observed.unexpectedRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort("blockedbyclient");
    })
  );
  yield* installApiFixture(page, fixture);
  yield* Effect.tryPromise(() => installUser(page));
  for (const origin of [providerOrigin, "https://api-sandbox.wompi.co"]) {
    yield* Effect.tryPromise(() =>
      page.route(`${origin}/**`, (route) => providerRoute(route, fixture))
    );
  }
  return observed;
});
