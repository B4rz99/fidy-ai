import { approvedOpenAiModel } from "@fidy/server/hosted-inference-contract";
import { it } from "@effect/vitest";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { evalStack } from "alchemy/Stack";
import { ConfigProvider, Effect, Schema } from "effect";
import { nativeApplication } from "./native-application";
import { NativeBindings } from "./native-graph";
import { requireClosedBindings } from "./storage-installation";

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
        Effect.sync(() => {
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
    );
  }
);
