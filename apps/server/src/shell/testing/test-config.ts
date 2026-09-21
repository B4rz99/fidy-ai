import { ConfigProvider } from "effect";

/** Public namespace and provider defaults shared by real-socket test harnesses. */
export const TestPublicNamespace = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromEnv({
      env: {
        PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
        PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
        WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio-test",
        WOMPI_ENVIRONMENT: "sandbox",
      },
    }),
    ConfigProvider.fromEnv()
  )
);
