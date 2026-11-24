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

const pinId = "76a38a57-13ac-41e9-9004-0e1e1bf41d98";

const pinFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input).url);
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

const configuration = ConfigProvider.fromUnknown({
  RELEASE_GIT_SHA: "1".repeat(40),
  CONTRACT_DIGEST: "2".repeat(64),
  HOSTED_AI_MODEL: approvedOpenAiModel,
  CLOUDFLARE_ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
  RECOVERY_OPERATOR_EMAIL: "operator@example.com",
  BETA_PRO_OPERATOR_EMAIL: "obarboza@fidyapp.com",
  SAMPLE_REVIEWER_EMAIL: "obarboza@fidyapp.com",
  PAT_ADMISSION_KEY: "fixture-admission-key",
  OPENAI_API_KEY: "fixture",
  KAPSO_API_KEY: "fixture",
  KAPSO_WEBHOOK_SECRET: "fixture",
  RESEND_API_KEY: "fixture",
  GOOGLE_CLIENT_ID: "fixture-google",
  GOOGLE_CLIENT_SECRET: "fixture",
  MICROSOFT_CLIENT_ID: "fixture-microsoft",
  MICROSOFT_CLIENT_SECRET: "fixture",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_fixture",
  WOMPI_PRIVATE_KEY: "prv_test_fixture",
  WOMPI_INTEGRITY_SECRET: "test_integrity_fixture",
  WOMPI_EVENT_SECRET: "test_events_fixture",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "123456789012345",
});

const Environment = Schema.Struct({
  env: Schema.Struct({
    BROWSER_ORIGIN: Schema.String,
    GOOGLE_CLIENT_ID: Schema.String,
    GOOGLE_REDIRECT_URI: Schema.String,
  }),
});

const destinationHost = ({ uri }: { readonly uri: string }): string =>
  new URL("https://" + uri).host;

const Domain = Schema.Struct({ domain: Schema.optional(Schema.Unknown) });

it.effect("plans the production application on its canonical hosts with live providers", () => {
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

        yield* Effect.forEach(
          applications,
          Effect.fnUntraced(function* (application) {
            const { allowedIdps, destinations } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                allowedIdps: Schema.Unknown,
                destinations: Schema.Array(Schema.Struct({ uri: Schema.String })),
              })
            )(application.Props);

            expect(
              yield* evaluate(allowedIdps, {}).pipe(
                Effect.provideService(FetchHttpClient.Fetch, pinFetch)
              )
            ).toEqual([pinId]);
            expect(destinations.map(destinationHost)).toEqual(["api.fidyapp.com"]);
          }),
          { discard: true }
        );

        const worker = (id: string): (typeof resources)[number] => {
          const resource = resources.find((node) => node.LogicalId === id);

          if (resource === undefined) throw Error("Missing declared Worker " + id);

          return resource;
        };

        const ingress = yield* Schema.decodeUnknownEffect(Domain)(worker("Ingress").Props);
        const web = yield* Schema.decodeUnknownEffect(Domain)(worker("Web").Props);

        expect(ingress.domain).toBe("api.fidyapp.com");
        expect(web.domain).toBe("app.fidyapp.com");

        const { env: core } = yield* Schema.decodeUnknownEffect(Environment)(worker("Core").Props);

        expect(core.BROWSER_ORIGIN).toBe("https://app.fidyapp.com");
        expect(core.GOOGLE_CLIENT_ID).toBe("fixture-google");
        expect(core.GOOGLE_REDIRECT_URI).toBe("https://api.fidyapp.com/providers/google/callback");
        expect(resources.some((node) => node.LogicalId.startsWith("ReleaseSmoke"))).toBe(false);
      }),
    { stage: "production" }
  ).pipe(Effect.provide([Alchemist.layer(), Alchemy.inMemoryState()]));
});
