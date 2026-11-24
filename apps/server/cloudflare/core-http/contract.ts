import type { SharedBindings } from "../storage-bootstrap/contract";
import type { UserStoreBindings } from "../directory/contract";
import type { ProviderConfiguration } from "../provider-authentication/contract";
import type { BancolombiaSandboxEnvironment } from "../bancolombia-authentication/contract";

export type CoreHttpEnvironment = ProviderConfiguration &
  Partial<UserStoreBindings> &
  SharedBindings &
  Readonly<{
    RELEASE_GIT_SHA: string;
    CONTRACT_DIGEST: string;
    KAPSO_API_KEY: string;
    WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
    KAPSO_WEBHOOK_SECRET: string;
    WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
    CLOUDFLARE_ACCESS_ISSUER: string;
    CLOUDFLARE_ACCESS_AUDIENCE: string;
    BROWSER_ORIGIN: string;
    WOMPI_ENVIRONMENT: string;
    WOMPI_PUBLIC_KEY: string;
    WOMPI_PRIVATE_KEY: string;
    WOMPI_INTEGRITY_SECRET: string;
  }> &
  BancolombiaSandboxEnvironment &
  Partial<
    Readonly<{
      CF_VERSION_METADATA: { id: string };
      RESEND_API_KEY: string;
      WOMPI_EVENT_SECRET: string;
      BETA_PRO_OPERATOR_EMAIL: string;
      BETA_PRO_AUDIENCE: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      SAMPLE_REVIEWER_EMAIL: string;
      SAMPLE_BUCKET: R2Bucket;
      BILLING_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      PRICING: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
      ERASURE_SUPPORT_AUDIENCE: string;
      WOMPI_DAVIPLATA_ACTIVATED: string;
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
      BROWSER_PAIRING_EMAIL_QUEUE: Queue;
      BILLING_COLLECTION_QUEUE: Queue;
      HOSTED_WHATSAPP_QUEUE: Pick<Queue, "send">;
      STATEMENT_STAGING_BUCKET: R2Bucket;
      EMAIL_BUCKET: R2Bucket;
    }>
  >;

export type CoreHttpHandler = (
  request: Request,
  environment: CoreHttpEnvironment,
  context?: Pick<ExecutionContext, "waitUntil">
) => Promise<Response>;
