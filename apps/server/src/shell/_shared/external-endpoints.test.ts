import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit } from "effect";
import { externalEndpoints } from "./external-endpoints";

const configuredNamespace = (webOrigin: string): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnv({
    env: {
      PUBLIC_WEB_ORIGIN: webOrigin,
      PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
      INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
    },
  });

it.effect("loads exact HTTP origins for the public namespace", () =>
  Effect.gen(function* () {
    const endpoints = yield* externalEndpoints.parse(configuredNamespace("https://fidyapp.com"));

    expect(endpoints.webOrigin).toBe("https://fidyapp.com");
    expect(endpoints.policyUrl).toBe("https://fidyapp.com/politica");
  })
);

it.effect("fails closed when the configured web origin is invalid", () =>
  Effect.gen(function* () {
    for (const origin of [
      "not a url",
      "ftp://fidyapp.com",
      "https://user@fidyapp.com",
      "https://fidyapp.com/path",
      "https://fidyapp.com?preview=true",
    ]) {
      const exit = yield* Effect.exit(externalEndpoints.parse(configuredNamespace(origin)));
      expect(Exit.isFailure(exit)).toBe(true);
    }
  })
);

it.effect("fails closed when the configured web origin is missing", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromEnv({
      env: {
        PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
        INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
      },
    });
    const exit = yield* Effect.exit(externalEndpoints.parse(provider));

    expect(Exit.isFailure(exit)).toBe(true);
  })
);
