import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { putScript } from "@distilled.cloud/cloudflare/workers";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";
import { freeTierWorkerObservability } from "./worker-observability";

const UploadMetadata = Schema.fromJsonString(
  Schema.Struct({
    observability: Schema.Struct({
      enabled: Schema.Boolean,
      redact_query_string: Schema.Boolean,
      logs: Schema.Struct({
        enabled: Schema.Boolean,
        invocation_logs: Schema.Boolean,
        persist: Schema.Boolean,
      }),
    }),
  })
);

it.effect("uploads query-redacted custom logs without automatic request invocations", () =>
  Effect.gen(function* () {
    let captured = false;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        expect(request.method).toBe("PUT");
        if (request.body._tag !== "FormData") return yield* Effect.die("Expected Worker upload");
        const metadata = yield* Schema.decodeUnknownEffect(UploadMetadata)(
          request.body.formData.get("metadata")
        );
        expect(metadata.observability).toEqual({
          enabled: true,
          redact_query_string: true,
          logs: { enabled: true, invocation_logs: false, persist: true },
        });
        captured = true;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ success: true, errors: [], messages: [], result: {} })
        );
      }).pipe(Effect.orDie)
    );
    yield* putScript({
      accountId: "test-account",
      scriptName: "fidy-authentication-test",
      metadata: { mainModule: "index.js", observability: freeTierWorkerObservability },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: "test-only" }))
      )
    );
    expect(captured).toBe(true);
  })
);
