import { ConfigProvider } from "effect";

/** Public namespace and provider defaults shared by real-socket test harnesses. */
export const TestPublicNamespace = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromEnv({
      env: {
        PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
        PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
        INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
        KAPSO_WEBHOOK_SECRET: "test-webhook-secret-32-characters",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
      },
    }),
    ConfigProvider.fromEnv()
  )
);
