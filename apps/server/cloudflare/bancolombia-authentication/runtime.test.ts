import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { verifyBancolombiaSandboxAuthentication } from "./runtime";

it.effect(
  "refuses absent certificate or incomplete client configuration without a network fallback",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const binding = {
        fetch: (): Promise<Response> => {
          calls += 1;
          return Promise.resolve(Response.json({}));
        },
      };
      for (const environment of [
        {},
        {
          BANCOLOMBIA_SANDBOX_CLIENT_ID: "10000000-0000-4000-8000-000000000001",
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
        { BANCOLOMBIA_SANDBOX_MTLS: binding },
        {
          BANCOLOMBIA_SANDBOX_MTLS: binding,
          BANCOLOMBIA_SANDBOX_CLIENT_ID: "invalid",
          BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM: "synthetic-key",
        },
      ]) {
        const result = yield* verifyBancolombiaSandboxAuthentication(environment).pipe(
          Effect.result
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.stage).toBe("bancolombia_configuration");
        }
      }
      expect(calls).toBe(0);
    })
);
