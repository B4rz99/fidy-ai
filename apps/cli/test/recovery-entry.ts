import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { apiOrigin } from "../src/credential/contract";
import { readOperationInput } from "../src/canonical/runtime";
import { RecoveryFailure } from "../src/support-recovery/contract";
import { runSupportRecovery } from "../src/support-recovery/operations";
import { makeRecoveryClient } from "../src/support-recovery/runtime";

// Only terminal entry and external Access edge authentication are substituted. The command's
// encoded request crosses real public/Core Workers and D1, on the existing browser topology.
const Premise = Schema.fromJsonString(
  Schema.Struct({
    pairingCode: Schema.String,
    backupRecoveryCode: Schema.String,
    assertion: Schema.String,
  })
);
await Effect.runPromise(
  Effect.gen(function* () {
    const premise = yield* Schema.decodeEffect(Premise)(yield* readOperationInput("-"));
    const original = yield* FetchHttpClient.Fetch;
    const loopback = Object.assign(
      (input: Parameters<typeof original>[0], init?: RequestInit): Promise<Response> => {
        const source = input instanceof Request ? input.url : input.toString();
        if (source !== `${apiOrigin}/internal/support-recovery`) {
          return Promise.reject(new RecoveryFailure({ reason: "InvalidInput" }));
        }
        const headers = new Headers(init?.headers);
        headers.set("cf-access-jwt-assertion", headers.get("cf-access-token") ?? "");
        headers.delete("cf-access-token");
        return original("https://127.0.0.1:4174/internal/support-recovery", {
          ...init,
          headers,
          tls: { rejectUnauthorized: false },
        });
      },
      { preconnect: original.preconnect }
    );
    const http = yield* HttpClient.HttpClient;
    const failed = yield* runSupportRecovery(["support-recovery"], {
      interactive: true,
      authenticate: Effect.succeed(Redacted.make(premise.assertion)),
      readPairing: Effect.succeed(premise.pairingCode),
      readCode: Effect.succeed(Redacted.make(premise.backupRecoveryCode)),
      submit: makeRecoveryClient(http),
      write: (text) =>
        Effect.sync(() => {
          process.stdout.write(text);
        }),
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, loopback));
    process.exitCode = failed ? 1 : 0;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer))
);
