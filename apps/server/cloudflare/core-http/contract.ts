import type { SharedBindings } from "../storage-bootstrap/contract";
import type { UserStoreBindings } from "../directory/contract";
import type { ErasureRegistry } from "../erasure/contract";
import type { ProviderEnvironment } from "../provider-authentication/contract";
import type { SmokeEnvironment } from "../runtime/release-smoke/contract";

/** Private HTTP binding boundary; no model execution or scheduled maintenance authority. */
export type CoreHttpEnvironment = ProviderEnvironment &
  Partial<UserStoreBindings> &
  SharedBindings &
  Readonly<{
    DB: D1Database;
    RELEASE_GIT_SHA: string;
    CONTRACT_DIGEST: string;
    USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
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
  Partial<SmokeEnvironment> &
  Partial<
    Readonly<{
      RECOVERY_ISOLATION: string;
      NATIVE_STORAGE_ADMISSION: string;
      SQLITE_STORAGE_RELEASE: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      SAMPLE_REVIEWER_EMAIL: string;
      SAMPLE_BUCKET: R2Bucket;
      BILLING_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      PRICING: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
      ERASURE_SUPPORT_AUDIENCE: string;
      ERASURE_BUCKET: R2Bucket;
      ERASURE_REGISTRY: ErasureRegistry;
      ERASURE_REQUIRED: string;
      WOMPI_DAVIPLATA_ACTIVATED: string;
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
      BROWSER_PAIRING_EMAIL_QUEUE: Queue;
      EMAIL_REPLACEMENT_QUEUE: Queue;
      BILLING_COLLECTION_QUEUE: Queue;
      HOSTED_WHATSAPP_QUEUE: Readonly<{ send: (body: unknown) => Promise<unknown> }>;
      STATEMENT_STAGING_BUCKET: R2Bucket;
      EMAIL_BUCKET: R2Bucket;
    }>
  >;

/** One private request, including an optional bounded post-commit publication lifetime. */
export type CoreHttpHandler = (
  request: Request,
  environment: CoreHttpEnvironment,
  context?: Pick<ExecutionContext, "waitUntil">
) => Promise<Response>;
