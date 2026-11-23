import type { ExternalEventBindings } from "../directory/contract";
import { type WompiEnvironment } from "../../src/shell/secret-material/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  BillingAttemptId,
  BillingPeriod,
  PaymentEnrollmentId,
  Price,
  PriceId,
  RefundAttemptId,
  StartRefundInput,
} from "../../src/core/subscription/contract";
import { Data, type Option, Schema } from "effect";
import { type WorkflowStepConfig } from "cloudflare:workers";

export type RefundAuthority = typeof RefundSupportAdmission.fields.authority.Type;

export const maximumRefundOperatorIdLength = 128;

export const refundSupportBasePath = "/internal/support/billing-refunds";

export const refundSupportReadPath =
  /^\/internal\/support\/billing-refunds\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;

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

export const RefundRead = Schema.TaggedStruct("ReadBillingRefund", {
  authority: RefundSupportAdmission.fields.authority,
  userId: UserId,
  refundAttemptId: RefundAttemptId,
});

export const LocalRefundWork = Schema.TaggedStruct("RunUserRefund", {
  userId: UserId,
  refundAttemptId: RefundAttemptId,
  verification: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
});

export type RefundSupportEnvironment = Readonly<{
  WOMPI_ENVIRONMENT: string;
  CLOUDFLARE_ACCESS_ISSUER: string;
  CLOUDFLARE_ACCESS_AUDIENCE: string;
}> &
  Partial<
    Readonly<{
      BILLING_SUPPORT_AUDIENCE: string;
      BETA_PRO_AUDIENCE: string;
      ERASURE_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      USER_STORE: {
        getByName: (name: string) => Pick<Fetcher, "fetch">;
      };
    }>
  >;

export type RefundReceiveInput = Readonly<{
  environment: Readonly<{ BILLING_REFUND_WORKFLOW: BillingWorkflowStarter }>;
  batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
}>;

export type BillingWorkflowEnvironment = BillingWorkRouting &
  Partial<ExternalEventBindings> &
  Readonly<{
    WOMPI_ENVIRONMENT: string;
    WOMPI_PUBLIC_KEY: string;
    WOMPI_PRIVATE_KEY: string;
    WOMPI_INTEGRITY_SECRET: string;
  }>;

export class RefundWorkFailure extends Data.TaggedError("RefundWorkFailure")<{
  readonly reason: "unavailable" | "invalid-work";
}> {}

export class BillingCollectionFailure extends Data.TaggedError("BillingCollectionFailure")<{
  readonly cause: Option.Option<unknown>;
}> {}

export type BillingWorkflowStarter = Readonly<{
  create: (
    input: Readonly<{
      id: string;
      params: unknown;
      retention: Readonly<{ successRetention: "3 days"; errorRetention: "3 days" }>;
    }>
  ) => Promise<WorkflowInstance | void>;
  get: (id: string) => Promise<WorkflowInstance>;
}>;

export type BillingObservationWorkflow = Pick<BillingWorkflowStarter, "create"> &
  Readonly<{
    get: (id: string) => Promise<Pick<WorkflowInstance, "status" | "restart">>;
  }>;

export const SubscriptionCancellationWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  kind: Schema.Literal("source-cancellation"),
  userId: UserId,
});

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
      BETA_PRO_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      PRICING: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
    }>
  >;

export const LocalSourceCancellationWork = Schema.Struct({
  version: Schema.Literal(3),
  kind: Schema.Literal("source-cancellation"),
  userId: UserId,
  paidAttemptId: BillingAttemptId,
});

export type BillingWorkRouting = Partial<
  Readonly<{ USER_STORE: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }> }>
>;

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
        send: (event: typeof WompiBillingEvent.Type) => Promise<QueueSendResponse | void>;
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
