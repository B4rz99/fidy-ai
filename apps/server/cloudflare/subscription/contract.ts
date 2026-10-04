import {
  type BillingAttemptId,
  type RefundAttemptId,
  StartRefundInput,
} from "../../src/core/subscription/contract";
import { Data, type Option, Schema } from "effect";
import { type WorkflowStepConfig } from "cloudflare:workers";
import { type TransactionCaller } from "../canonical-work/contract";

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
  subject: TransactionCaller;
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

export type BillingRuntime = Pick<
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
  send: (work: Readonly<{ version: 1; attemptId: BillingAttemptId }>) => Promise<unknown>;
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
