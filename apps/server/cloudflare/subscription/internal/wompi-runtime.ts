import { Digest } from "effect/crypto";
import { DaviplataOtpPolicy } from "../../../src/core/subscription/contract";
import { type WompiBindings } from "../contract";

import {
  OutboundHttp,
  type OutboundHttpService,
} from "../../../src/shell/outbound-http/operations";
import { OutboundHttpLive, installedProviderFetch } from "../../outbound-http/runtime";
import { cloudflareWorkerTelemetry } from "../../runtime/telemetry/operations";
import { Context, Effect, Layer, ManagedRuntime, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const digestRuntime = ManagedRuntime.make(Digest.layerWebCrypto);

export const workerDigest = digestRuntime.runSync(Digest.Digest);

export type WompiTransportFactory = (
  environment: WompiBindings
) => Effect.Effect<OutboundHttpService>;

const wompiTransport = ({
  environment,
  httpClient,
}: Readonly<{
  environment: WompiBindings;
  httpClient: HttpClient.HttpClient;
}>): OutboundHttpService =>
  OutboundHttp.wompi({
    environment: environment.WOMPI_ENVIRONMENT,
    publicKey: environment.WOMPI_PUBLIC_KEY,
    privateKey: Redacted.make(environment.WOMPI_PRIVATE_KEY),
    integritySecret: Redacted.make(environment.WOMPI_INTEGRITY_SECRET),
    httpClient,
    digest: workerDigest,
    daviplataSandboxPolicy:
      environment.WOMPI_ENVIRONMENT === "sandbox"
        ? Schema.decodeUnknownOption(DaviplataOtpPolicy)({
            sendUrl: environment.WOMPI_DAVIPLATA_OTP_SEND_URL,
            confirmUrl: environment.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
          })
        : Option.none(),
  });

export const wompiOutboundHttp = (environment: WompiBindings): Effect.Effect<OutboundHttpService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fetcher = yield* installedProviderFetch({
        provider: "wompi",
        environment,
        telemetry: cloudflareWorkerTelemetry,
      });

      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetcher)
      );

      return wompiTransport({
        environment,
        httpClient: Context.get(clients, HttpClient.HttpClient),
      });
    })
  );
