import { Digest } from "effect/crypto";
import { openAiHttp } from "~/shell/outbound-http/internal/openai-http";
import { bancolombiaSandboxHttp } from "~/shell/outbound-http/internal/bancolombia-http";
import { cliReleaseHttp } from "~/shell/outbound-http/internal/cli-release-http";
import { oidcHttp } from "~/shell/outbound-http/internal/oidc-http";
import { type DaviplataOtpPolicy } from "~/core/subscription/contract";
import { WompiEnvironment } from "~/shell/secret-material/contract";
import { Config, Context, Effect, Layer, Option, type Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import {
  loadResendEmailDeliveryApiKey,
  loadWompiIntegritySecret,
  loadWompiPrivateKey,
} from "~/shell/secret-material/operations";
import {
  makeCloudflareAccessSigningKeysHttp,
  makeOutboundHttp,
} from "~/shell/outbound-http/internal/outbound-http";
import type {
  BancolombiaSandboxHttpService,
  CliReleaseHttpService,
  OpenAiHttpService,
  OutboundHttpFailure,
  OutboundHttpRequest,
  OutboundHttpResponse,
  ProviderOidcHttpService,
} from "./contract";

const WompiPublicKey = Schema.String.check(
  Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
);

export type OutboundHttpService = Readonly<{
  readonly execute: (
    request: OutboundHttpRequest
  ) => Effect.Effect<OutboundHttpResponse, OutboundHttpFailure>;
}>;

export const makeAccessSigningKeysOutboundHttp = (
  input: Readonly<{
    issuer: string;
    httpClient: HttpClient.HttpClient;
  }>
): OutboundHttpService => makeCloudflareAccessSigningKeysHttp(input);

export const accessSigningKeysOutboundHttp = Effect.fn(function* (issuer: string) {
  const httpClient = yield* HttpClient.HttpClient;

  return makeAccessSigningKeysOutboundHttp({ issuer, httpClient });
});

export const makeKapsoOutboundHttp = (
  input: Readonly<{
    readonly apiKey: Redacted.Redacted<string>;
    readonly httpClient: HttpClient.HttpClient;
  }>
): OutboundHttpService =>
  makeOutboundHttp({
    kapsoApiKey: Option.some(input.apiKey),
    resendEmailDeliveryApiKey: Option.none(),
    wompi: Option.none(),
    httpClient: input.httpClient,
    digest: Option.none(),
  });

export const makeResendOutboundHttp = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
  }>
): OutboundHttpService =>
  makeOutboundHttp({
    kapsoApiKey: Option.none(),
    resendEmailDeliveryApiKey: Option.some(input.apiKey),
    wompi: Option.none(),
    httpClient: input.httpClient,
    digest: Option.none(),
  });

export const makeWompiOutboundHttp = (
  input: Readonly<{
    environment: WompiEnvironment;
    publicKey: string;
    privateKey: Redacted.Redacted<string>;
    integritySecret: Redacted.Redacted<string>;
    httpClient: HttpClient.HttpClient;
    digest: Digest.Digest["Service"];
  }> &
    Partial<Readonly<{ daviplataSandboxPolicy: Option.Option<DaviplataOtpPolicy> }>>
): OutboundHttpService =>
  makeOutboundHttp({
    kapsoApiKey: Option.none(),
    resendEmailDeliveryApiKey: Option.none(),
    wompi: Option.some({
      ...input,
      daviplataSandboxPolicy: input.daviplataSandboxPolicy ?? Option.none(),
    }),
    httpClient: input.httpClient,
    digest: Option.some(input.digest),
  });

export class OutboundHttp extends Context.Service<OutboundHttp, OutboundHttpService>()(
  "@fidy/server/shell/outbound-http/operations/OutboundHttp"
) {
  static readonly make = Effect.gen(function* () {
    const kapsoApiKey = yield* Config.Redacted("KAPSO_API_KEY").pipe(Config.option);
    const resendEmailDeliveryApiKey = yield* loadResendEmailDeliveryApiKey;
    const wompiEnvironment = yield* Config.schema(WompiEnvironment, "WOMPI_ENVIRONMENT");
    const environmentPrefix = wompiEnvironment === "sandbox" ? "test" : "prod";

    const wompiPublicKey = yield* Config.schema(
      WompiPublicKey.check(Schema.isStartingWith(`pub_${environmentPrefix}_`)),
      "WOMPI_PUBLIC_KEY"
    );

    const wompiPrivateKey = yield* loadWompiPrivateKey(wompiEnvironment);
    const wompiIntegritySecret = yield* loadWompiIntegritySecret(wompiEnvironment);
    const httpClient = yield* HttpClient.HttpClient;
    const digest = yield* Digest.Digest;

    return makeOutboundHttp({
      kapsoApiKey,
      resendEmailDeliveryApiKey: Option.some(resendEmailDeliveryApiKey),
      wompi: Option.some({
        environment: wompiEnvironment,
        publicKey: wompiPublicKey,
        privateKey: wompiPrivateKey,
        integritySecret: wompiIntegritySecret,
        daviplataSandboxPolicy: Option.none(),
      }),
      httpClient,
      digest: Option.some(digest),
    });
  });

  static readonly layer = Layer.effect(this, this.make);

  static readonly accessSigningKeys = makeAccessSigningKeysOutboundHttp;

  static readonly kapso = makeKapsoOutboundHttp;

  static readonly wompi = makeWompiOutboundHttp;

  static readonly kapsoLayer = (
    apiKey: Redacted.Redacted<string>
  ): Layer.Layer<OutboundHttp, never, HttpClient.HttpClient> =>
    Layer.effect(
      OutboundHttp,
      Effect.map(Effect.service(HttpClient.HttpClient), (httpClient) =>
        makeKapsoOutboundHttp({ apiKey, httpClient })
      )
    );

  static readonly resendLayer = (
    apiKey: Redacted.Redacted<string>
  ): Layer.Layer<OutboundHttp, never, HttpClient.HttpClient> =>
    Layer.effect(
      OutboundHttp,
      Effect.map(Effect.service(HttpClient.HttpClient), (httpClient) =>
        makeResendOutboundHttp({ apiKey, httpClient })
      )
    );
}

export const makeGoogleOutboundHttp = (
  input: Readonly<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
    redirectUri: string;
    httpClient: HttpClient.HttpClient;
  }>
): ProviderOidcHttpService => oidcHttp({ ...input, provider: "google" });

export const makeMicrosoftOutboundHttp = (
  input: Readonly<{
    clientId: string;
    clientSecret: Redacted.Redacted<string>;
    redirectUri: string;
    httpClient: HttpClient.HttpClient;
  }>
): ProviderOidcHttpService => oidcHttp({ ...input, provider: "microsoft" });

export class AccessSigningKeysHttp extends Context.Service<
  AccessSigningKeysHttp,
  Readonly<{ forIssuer: (issuer: string) => OutboundHttpService }>
>()("@fidy/server/shell/outbound-http/operations/AccessSigningKeysHttp") {
  static readonly make = Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;

    return {
      forIssuer: (issuer: string): OutboundHttpService =>
        makeCloudflareAccessSigningKeysHttp({ issuer, httpClient }),
    };
  });

  static readonly layer = Layer.effect(this, this.make);
}

export class CliReleaseHttp extends Context.Service<CliReleaseHttp, CliReleaseHttpService>()(
  "@fidy/server/shell/outbound-http/operations/CliReleaseHttp"
) {
  static readonly make = Effect.gen(function* () {
    return cliReleaseHttp(yield* HttpClient.HttpClient);
  });

  static readonly layer = Layer.effect(this, this.make);
}

export class BancolombiaSandboxHttp extends Context.Service<
  BancolombiaSandboxHttp,
  BancolombiaSandboxHttpService
>()("@fidy/server/shell/outbound-http/operations/BancolombiaSandboxHttp") {
  static readonly make = Effect.gen(function* () {
    return bancolombiaSandboxHttp(yield* HttpClient.HttpClient);
  });

  static readonly layer = Layer.effect(this, this.make);
}

export const openAiOutboundHttp = (
  input: Readonly<{
    apiKey: Redacted.Redacted<string>;
    client: HttpClient.HttpClient;
  }>
): OpenAiHttpService => openAiHttp(input);

export class ProviderOidcHttp extends Context.Service<ProviderOidcHttp, ProviderOidcHttpService>()(
  "@fidy/server/shell/outbound-http/operations/ProviderOidcHttp"
) {
  static readonly make = (
    input: Readonly<{
      provider: "google" | "microsoft";
      clientId: string;
      clientSecret: Redacted.Redacted<string>;
      redirectUri: string;
    }>
  ): Effect.Effect<ProviderOidcHttpService, never, HttpClient.HttpClient> =>
    Effect.map(Effect.service(HttpClient.HttpClient), (httpClient) =>
      oidcHttp({ ...input, httpClient })
    );

  static readonly layer = (
    input: Parameters<typeof ProviderOidcHttp.make>[0]
  ): Layer.Layer<ProviderOidcHttp, never, HttpClient.HttpClient> =>
    Layer.effect(ProviderOidcHttp, ProviderOidcHttp.make(input));
}
