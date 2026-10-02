import type { BillingAttemptId } from "../../src/core/subscription/contract";
import { Data, type Option } from "effect";
import { type TransactionCaller } from "../canonical-work/contract";

/** Canonical safe observation under the caller's live credential and User. */
export type SubscriptionQueryInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: "subscription.listSubscriptionOffers" | "subscription.getSubscriptionStatus";
}>;

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

export type BillingRuntime = Pick<
  BillingCollectionEnvironment,
  "DB" | "WOMPI_ENVIRONMENT" | "WOMPI_PUBLIC_KEY" | "WOMPI_PRIVATE_KEY" | "WOMPI_INTEGRITY_SECRET"
>;

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
