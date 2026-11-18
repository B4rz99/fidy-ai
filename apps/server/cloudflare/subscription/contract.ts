import type { ExternalEventBindings } from "../directory/contract";
import { type WompiEnvironment } from "../../src/shell/secret-material/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  BillingAttemptId,
  BillingPeriod,
  PaymentEnrollmentId,
  Price,
  PriceId,
  type RefundAttemptId,
  StartRefundInput,
} from "../../src/core/subscription/contract";
import { Data, type Option, Schema } from "effect";
import { type WorkflowStepConfig } from "cloudflare:workers";
import { type QueryCaller } from "../canonical-work/contract";

/** Constructed only after origin-side verification against the separate billing-support Access app. */
export type RefundAuthority = typeof RefundSupportAdmission.fields.authority.Type;

/** Money and dates cross the native request boundary through their canonical codecs. */
export type RefundStartCall = Readonly<{
  db: D1Database;
  environment: string;
  authority: RefundAuthority;
  input: typeof StartRefundInput.Encoded;
}>;
export type RefundReadCall = Readonly<{
  db: D1Database;
  authority: RefundAuthority;
  userId: string;
  refundAttemptId: string;
}>;
export const maximumRefundOperatorIdLength = 128;
export const refundSupportBasePath = "/internal/support/billing-refunds";
export const refundSupportReadPath =
  /^\/internal\/support\/billing-refunds\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;

/** Private Core-to-User coordinator admission; neither ingress nor PATs can construct this route. */
export const RefundSupportAdmission = Schema.TaggedStruct("BillingRefundSupport", {
  authority: Schema.Struct({
    operatorId: Schema.String.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(maximumRefundOperatorIdLength)
    ),
    expiresAtMs: Schema.Int,
    permission: Schema.Literal("billing.refund"),
  }),
  input: Schema.toEncoded(StartRefundInput),
});

/** Origin-verified support transport has a separate Access application audience. */
export type RefundSupportEnvironment = Readonly<{
  DB: D1Database;
  WOMPI_ENVIRONMENT: string;
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
  USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}> &
  Partial<Readonly<{ BILLING_SUPPORT_AUDIENCE: string }>>;

/** Canonical safe observation under the caller's live credential and User. */
export type SubscriptionQueryInput = Readonly<{
  db: D1Database;
  subject: QueryCaller;
}> &
  (
    | Readonly<{
        operation: "subscription.listSubscriptionOffers" | "subscription.getSubscriptionStatus";
      }>
    | Readonly<{ operation: "subscription.getUpgradeUrl"; browserOrigin: Option.Option<string> }>
  );

/** Explicit native bindings for direct browser enrollment and accepted-work notification. */
export type EnrollmentEnvironment = Readonly<{
  DB: D1Database;
  /** Offers already durable BillingAttempt work; pending submission replay may repeat the offer.
   * Receivers must tolerate duplicate notification. This does not establish collection or paid access.
   */
  onAccepted: (id: string) => void;
}> &
  Partial<
    Readonly<{
      BROWSER_ORIGIN: string;
      WOMPI_ENVIRONMENT: string;
      WOMPI_PUBLIC_KEY: string;
      WOMPI_PRIVATE_KEY: string;
      WOMPI_INTEGRITY_SECRET: string;
      WOMPI_DAVIPLATA_ACTIVATED: string;
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
    }>
  >;

export type BillingCollectionEnvironment = Readonly<{
  DB: D1Database;
  BILLING_COLLECTION_QUEUE: Queue;
  BILLING_COLLECTION_WORKFLOW: Workflow;
  WOMPI_ENVIRONMENT: string;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
  WOMPI_EVENT_SECRET: string;
}>;

export type RefundWorkflowExecution = Readonly<{
  environment: BillingRuntime;
  payload: unknown;
  activity: (name: string, options: WorkflowStepConfig, run: () => Promise<void>) => Promise<void>;
}>;
export type RefundDispatchInput = Readonly<{
  DB: D1Database;
  BILLING_COLLECTION_QUEUE: Readonly<{
    send: (
      work:
        | Readonly<{ version: 1; kind: "refund"; refundAttemptId: RefundAttemptId }>
        | Readonly<{
            version: 1;
            kind: "refund-void-verification";
            refundAttemptId: RefundAttemptId;
            verification: number;
          }>
    ) => Promise<unknown>;
  }>;
}>;
export type RefundReceiveInput = Readonly<{
  environment: Readonly<{ BILLING_REFUND_WORKFLOW: BillingWorkflowStarter }>;
  batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
}>;

export type BillingRuntime = BillingWorkRouting &
  Partial<ExternalEventBindings> &
  Pick<
    BillingCollectionEnvironment,
    "DB" | "WOMPI_ENVIRONMENT" | "WOMPI_PUBLIC_KEY" | "WOMPI_PRIVATE_KEY" | "WOMPI_INTEGRITY_SECRET"
  >;

/** Closed correction-work failure; Queue redelivery remains possible without publishing platform diagnostics. */
export class RefundWorkFailure extends Data.TaggedError("RefundWorkFailure")<{
  readonly reason: "unavailable" | "invalid-work";
}> {}

/** Closed internal-workflow failure; raw causes never cross browser or canonical response boundaries. */
export class BillingCollectionFailure extends Data.TaggedError("BillingCollectionFailure")<{
  readonly cause: Option.Option<unknown>;
}> {}

/** Queue publication consumes only a versioned Fidy BillingAttempt identity. */
export type BillingQueuePublisher = Readonly<{
  send: (work: typeof LocalBillingCollection.Type) => Promise<unknown>;
}>;

/** Native Workflow handoff accepts opaque versioned work; its payload is validated by the owner. */
export type BillingWorkflowStarter = Readonly<{
  create: (
    input: Readonly<{
      id: string;
      params: unknown;
      retention: Readonly<{ successRetention: "3 days"; errorRetention: "3 days" }>;
    }>
  ) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
}>;

export type BillingObservationWorkflow = Pick<BillingWorkflowStarter, "create"> &
  Readonly<{
    get: (id: string) => Promise<Pick<WorkflowInstance, "status" | "restart">>;
  }>;

/** Private same-User admission; a queued identity never authorizes a charge by itself. */
export const SubscriptionRenewalAdmission = Schema.TaggedStruct("SubscriptionRenewal", {
  userId: UserId,
  previousPaidAttemptId: BillingAttemptId,
});
export type SubscriptionRenewalDispatchInput = Readonly<{
  DB: D1Database;
  WOMPI_ENVIRONMENT: string;
  USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;

/** Cancellation work contains only the User whose retained intent must be rechecked. */
export const SubscriptionCancellationWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  kind: Schema.Literal("source-cancellation"),
  userId: UserId,
});
export type SubscriptionCancellationDispatchInput = Readonly<{
  DB: D1Database;
  BILLING_COLLECTION_QUEUE: Readonly<{
    send: (work: typeof SubscriptionCancellationWork.Type) => Promise<unknown>;
  }>;
}>;

/** Validated provider settings consumed only by the Subscription runtime constructor. */
export type WompiBindings = Readonly<{
  WOMPI_ENVIRONMENT: WompiEnvironment;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
}> &
  Partial<
    Readonly<{
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
    }>
  >;

export const pricingName = "pricing";
export const pricePublicationPath = "/internal/support/prices";
export const PricePublication = Schema.Struct({
  publicationId: Schema.String.check(Schema.isUUID()),
  price: Price,
});
const maximumPricingOperatorIdLength = 256;
export const AdmittedPricePublication = Schema.Struct({
  ...PricePublication.fields,
  authority: Schema.Struct({
    permission: Schema.Literal("pricing.publish"),
    operatorId: Schema.NonEmptyString.check(Schema.isMaxLength(maximumPricingOperatorIdLength)),
    expiresAtMs: Schema.Int,
  }),
});
export type PricingEnvironment = Readonly<{
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}> &
  Partial<
    Readonly<{
      ERASURE_SUPPORT_AUDIENCE: string;
      BILLING_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      PRICING: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
    }>
  >;

/** Exact accepted paid period; a transport redelivery carries no independent billing authority. */
export const LocalSourceCancellationWork = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal("source-cancellation"),
  userId: UserId,
  paidAttemptId: BillingAttemptId,
});

export type BillingWorkRouting = Partial<
  Readonly<{ USER_STORE: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }> }>
>;

/** A value returned by a named billing activity is durable across Workflow reconstruction. */
export type BillingWorkflowActivity<Value extends boolean | void = void> = (
  name: string,
  options: WorkflowStepConfig,
  run: () => Promise<Value>
) => Promise<Value>;

const maximumProviderIdentity = 128;
const maximumEventStatus = 64;
export const WompiBillingEvent = Schema.TaggedStruct("WompiBillingEvent", {
  environment: Schema.Literals(["sandbox", "production"]),
  transactionId: Schema.NonEmptyString.check(Schema.isMaxLength(maximumProviderIdentity)),
  signedAt: Schema.Int,
  signedStatus: Schema.NonEmptyString.check(Schema.isMaxLength(maximumEventStatus)),
});
export type WompiEventEnvironment = Readonly<{
  WOMPI_ENVIRONMENT: string;
  WOMPI_EVENT_SECRET: string;
}> &
  Partial<
    Readonly<{
      BILLING_COLLECTION_QUEUE: Readonly<{
        send: (event: typeof WompiBillingEvent.Type) => Promise<unknown>;
      }>;
    }>
  >;
export const LocalBillingCollection = Schema.TaggedStruct("CollectUserBillingAttempt", {
  userId: UserId,
  attemptId: BillingAttemptId,
});
export const collectUserBillingUrl = "https://user.invalid/work/billing/collect";
export const settleUserBillingUrl = "https://user.invalid/work/billing/observe";

export const BillingRegistration = Schema.Struct({
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
