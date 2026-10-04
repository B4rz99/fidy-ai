import type { SmokeEnvironment } from "../runtime/release-smoke/contract";

/** Private HTTP binding boundary; no model execution or scheduled maintenance authority. */
export type CoreHttpEnvironment = Readonly<{
  DB: D1Database;
  RELEASE_GIT_SHA: string;
  CONTRACT_DIGEST: string;
  USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  KAPSO_API_KEY: string;
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
      BILLING_SUPPORT_AUDIENCE: string;
      WOMPI_DAVIPLATA_ACTIVATED: string;
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
      ONBOARDING_EMAIL_QUEUE: Queue;
      BROWSER_PAIRING_EMAIL_QUEUE: Queue;
      EMAIL_REPLACEMENT_QUEUE: Queue;
      BILLING_COLLECTION_QUEUE: Queue;
      HOSTED_WHATSAPP_QUEUE: Queue;
      STATEMENT_STAGING_BUCKET: R2Bucket;
    }>
  >;

/** One private request, including an optional bounded post-commit publication lifetime. */
export type CoreHttpHandler = (
  request: Request,
  environment: CoreHttpEnvironment,
  context?: Pick<ExecutionContext, "waitUntil">
) => Promise<Response>;
