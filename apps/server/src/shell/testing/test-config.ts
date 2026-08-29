import { ConfigProvider } from "effect";

export const testResendWebhookSecret = `whsec_${btoa("test_resend_webhook_secret")}`;

/** Public namespace and provider defaults shared by real-socket test harnesses. */
export const TestPublicNamespace = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromEnv({
      env: {
        PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
        PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
        INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
        KAPSO_WEBHOOK_SECRET: "test-webhook-secret-32-characters",
        RESEND_WEBHOOK_SECRET: testResendWebhookSecret,
        EMAIL_INGEST_RETENTION_DAYS: "90",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
      },
    }),
    ConfigProvider.fromEnv()
  )
);
