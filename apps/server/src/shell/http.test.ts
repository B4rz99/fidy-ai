import { expect, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http";
import { ApiHarness } from "~/shell/testing/api-harness";
import { ExactOriginCorsLive } from "./http";

const invalidPublicNamespace = (webOrigin?: string): ConfigProvider.ConfigProvider =>
  ConfigProvider.fromEnv({
    env: {
      ...(webOrigin === undefined ? {} : { PUBLIC_WEB_ORIGIN: webOrigin }),
      PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
      INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
    },
  });

for (const [description, webOrigin] of [
  ["missing", undefined],
  ["invalid", "https://fidyapp.com/path"],
] as const) {
  it.effect(`fails the HTTP layer closed when PUBLIC_WEB_ORIGIN is ${description}`, () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(Layer.build(ExactOriginCorsLive.pipe(Layer.provide(HttpRouter.layer)))).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, invalidPublicNamespace(webOrigin))
        )
      );

      expect(Exit.isFailure(exit)).toBe(true);
    })
  );
}

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "public service routes",
  (it) => {
    it.effect("reports the running release identity without caller credentials", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/health");

        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(
          '{"status":"ok","gitRevision":"development","contractDigest":"development"}'
        );
      })
    );

    it.effect("serves interactive canonical API documentation without caller credentials", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/docs");

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/html");
        expect(yield* response.text).toContain("fidy-ai canonical API");
      })
    );

    it.effect("does not serve web routes from the API process", () =>
      Effect.gen(function* () {
        const root = yield* HttpClient.get("/");
        const policy = yield* HttpClient.get("/politica");

        expect(root.status).toBe(404);
        expect(policy.status).toBe(404);
      })
    );

    it.effect("processes requests without Origin and emits no CORS grant", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/user");

        expect(response.status).toBe(401);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      })
    );

    it.effect("grants credentials only to the exact configured web origin", () =>
      Effect.gen(function* () {
        const response = yield* HttpClientRequest.get("/user").pipe(
          HttpClientRequest.setHeader("origin", "https://fidyapp.com"),
          HttpClient.execute
        );

        expect(response.status).toBe(401);
        expect(response.headers["access-control-allow-origin"]).toBe("https://fidyapp.com");
        expect(response.headers["access-control-allow-credentials"]).toBe("true");
        expect(response.headers.vary).toBe("Origin");
      })
    );

    for (const origin of [
      "null",
      "not an origin",
      "https://unconfigured.example",
      "https://fidyapp.com.attacker.example",
    ]) {
      it.effect(`rejects supplied origin ${origin} before canonical behavior`, () =>
        Effect.gen(function* () {
          const response = yield* HttpClientRequest.get("/user").pipe(
            HttpClientRequest.setHeader("origin", origin),
            HttpClient.execute
          );

          expect(response.status).toBe(403);
          expect(response.headers["access-control-allow-origin"]).toBeUndefined();
          expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
        })
      );
    }

    it.effect("accepts only an explicitly supported canonical preflight", () =>
      Effect.gen(function* () {
        const response = yield* HttpClientRequest.options("/user", {
          headers: {
            origin: "https://fidyapp.com",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization, content-type",
          },
        }).pipe(HttpClient.execute);

        expect(response.status).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("https://fidyapp.com");
        expect(response.headers["access-control-allow-credentials"]).toBe("true");
        expect(response.headers["access-control-allow-methods"]).toContain("GET");
        expect(response.headers["access-control-allow-headers"]).toBe(
          "authorization, content-type"
        );
        expect(response.headers.vary).toContain("Origin");
        expect(response.headers.vary).toContain("Access-Control-Request-Method");
        expect(response.headers.vary).toContain("Access-Control-Request-Headers");
      })
    );

    it.effect("rejects unsupported preflight methods and headers", () =>
      Effect.gen(function* () {
        const unsupportedMethod = yield* HttpClientRequest.options("/user", {
          headers: {
            origin: "https://fidyapp.com",
            "access-control-request-method": "TRACE",
          },
        }).pipe(HttpClient.execute);
        const unsupportedHeader = yield* HttpClientRequest.options("/user", {
          headers: {
            origin: "https://fidyapp.com",
            "access-control-request-method": "GET",
            "access-control-request-headers": "x-private-header",
          },
        }).pipe(HttpClient.execute);

        expect(unsupportedMethod.status).toBe(403);
        expect(unsupportedHeader.status).toBe(403);
      })
    );
  }
);
