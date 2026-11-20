import { approvedOpenAiModel } from "@fidy/server/hosted-inference-contract";
import { it } from "@effect/vitest";
import { Hex } from "effect/encoding";
import { expect } from "vitest";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Cloudflare from "alchemy/Cloudflare";
import { evalStack } from "alchemy/Stack";
import { evaluate } from "alchemy/Output";
import { FetchHttpClient } from "effect/http";
import { ConfigProvider, Effect, Schema } from "effect";
import { nativeApplication } from "./native-application";
import { type NativeBinding, NativeBindings, requireSuccessorCoreBindings } from "./native-graph";
import { requireClosedBindings } from "./storage-installation";

const pinId = "76a38a57-13ac-41e9-9004-0e1e1bf41d98";
const pinFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe(
      "/client/v4/accounts/" + "0".repeat(32) + "/access/identity_providers"
    );
    expect(init?.method).toBe("GET");
    return Promise.resolve(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ name: "Shared account PIN", type: "onetimepin", config: {}, id: pinId }],
      })
    );
  },
  { preconnect: fetch.preconnect }
);
const expectedSigner = (worker: string, enabled: boolean): boolean => worker === "Core" && enabled;
const rehearsalKey = Effect.gen(function* () {
  const pair = yield* Effect.tryPromise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  );
  const spki = yield* Effect.tryPromise(() => crypto.subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = yield* Effect.tryPromise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const digest = yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", spki));
  return {
    fingerprint: Hex.encode(new Uint8Array(digest)),
    secret: Hex.encode(new Uint8Array(pkcs8)),
  };
});
const testSigner = await Effect.runPromise(rehearsalKey);
it.effect.each(["unsigned", "original", "successor"] as const)(
  "declares exactly the requested Core and smoke bindings before resources exist (%s)",
  (mode) => {
    const enabled = mode !== "unsigned";
    const successorPlan = mode === "successor";
    const revision = "1".repeat(40);
    const fingerprint = enabled ? testSigner.fingerprint : "";
    const configuration = ConfigProvider.fromUnknown({
      ...(enabled
        ? {
            NATIVE_FIXTURE_SIGNER_SHA256: fingerprint,
            NATIVE_FIXTURE_SIGNING_KEY: testSigner.secret,
          }
        : {}),
      ...(successorPlan ? { FIXTURE_RELEASE_OPERATION: "plan-fixture-successor" } : {}),
      NATIVE_STORAGE_ADMISSION: "closed",
      RELEASE_GIT_SHA: revision,
      CONTRACT_DIGEST: "2".repeat(64),
      RELEASE_ATTEMPT_ID: "1-1",
      SMOKE_PROOF: "fixture",
      HOSTED_AI_MODEL: approvedOpenAiModel,
      CLOUDFLARE_ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
      RECOVERY_OPERATOR_EMAIL: "operator@example.com",
      BETA_PRO_OPERATOR_EMAIL: "obarboza@fidyapp.com",
      SAMPLE_REVIEWER_EMAIL: "obarboza@fidyapp.com",
    });
    const stack = Alchemy.Stack(
      "NativePlanFixture",
      { providers: Cloudflare.providers(), state: Alchemy.inMemoryState() },
      nativeApplication.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configuration))
    );
    const assertBindings = (
      worker: "Core" | "Smoke",
      observed: ReadonlyArray<NativeBinding>
    ): void => {
      if (successorPlan && worker === "Core") {
        requireSuccessorCoreBindings({ bindings: observed, fingerprint });
      } else requireClosedBindings({ worker, bindings: observed, fingerprint });
    };
    const generation =
      enabled && !successorPlan ? "aa447b8b781cdda48e021c1332f4377eae00f179" : revision;
    return evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          const resources = Object.values(compiled.resources);
          const applications = resources.filter(
            (node) => node.Type === "Cloudflare.Access.Application"
          );
          expect(applications).toHaveLength(4);
          expect(resources.some((node) => node.Type === "Cloudflare.Access.IdentityProvider")).toBe(
            false
          );
          for (const application of applications) {
            const { allowedIdps } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ allowedIdps: Schema.Unknown })
            )(application.Props);
            expect(
              yield* evaluate(allowedIdps, {}).pipe(
                Effect.provideService(FetchHttpClient.Fetch, pinFetch)
              )
            ).toEqual([pinId]);
          }
          const bindings = Schema.Struct({ bindings: Schema.optional(NativeBindings) });
          for (const worker of ["Core", "Smoke"] as const) {
            const id = worker === "Core" ? "Core" : "ReleaseSmoke-" + generation;
            const resource = Object.values(compiled.resources).find(
              (node) => node.LogicalId === id
            );
            if (resource === undefined) throw Error("Missing declared Worker " + worker);
            const rows = compiled.bindings[resource.FQN] ?? [];
            const observed = rows.flatMap(
              (row) => Schema.decodeUnknownSync(bindings)(row.data).bindings ?? []
            );
            expect(observed).toContainEqual(
              expect.objectContaining({ name: "RELEASE_GIT_SHA", text: revision })
            );
            assertBindings(worker, observed);
            expect(observed.some((item) => item.name === "NATIVE_FIXTURE_SIGNING_KEY")).toBe(
              expectedSigner(worker, enabled)
            );
            if (expectedSigner(worker, enabled)) {
              expect(
                observed.find((binding) => binding.name === "ACCEPTANCE_PROVIDER_REVISION")?.text
              ).toBe("8dd3b0d47d655868c1ab4f16b6145a06d99bd721");
              expect(() =>
                requireClosedBindings({ worker, bindings: observed, fingerprint: "" })
              ).toThrow();
              expect(() =>
                requireClosedBindings({ worker, bindings: observed, fingerprint: "0".repeat(64) })
              ).toThrow();
            }
          }
        }),
      { stage: "production" }
    ).pipe(Effect.provide([Alchemist.layer(), Alchemy.inMemoryState()]));
  }
);
