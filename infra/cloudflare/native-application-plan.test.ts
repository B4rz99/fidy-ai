import { approvedOpenAiModel } from "@fidy/server/hosted-inference-contract";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Cloudflare from "alchemy/Cloudflare";
import { evalStack } from "alchemy/Stack";
import { evaluate } from "alchemy/Output";
import { FetchHttpClient } from "effect/http";
import { ConfigProvider, Effect, Schema } from "effect";
import { nativeApplication } from "./native-application";
import { NativeBindings } from "./native-graph";
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
it.effect(
  "declares every Core and smoke binding before a fresh Access application or queue exists",
  () => {
    const revision = "1".repeat(40);
    const configuration = ConfigProvider.fromUnknown({
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
            const id = worker === "Core" ? "Core" : "ReleaseSmoke-" + revision;
            const resource = Object.values(compiled.resources).find(
              (node) => node.LogicalId === id
            );
            if (resource === undefined) throw Error("Missing declared Worker " + worker);
            const rows = compiled.bindings[resource.FQN] ?? [];
            requireClosedBindings({
              worker,
              bindings: rows.flatMap(
                (row) => Schema.decodeUnknownSync(bindings)(row.data).bindings ?? []
              ),
            });
          }
        }),
      { stage: "production" }
    ).pipe(Effect.provide([Alchemist.layer(), Alchemy.inMemoryState()]));
  }
);
