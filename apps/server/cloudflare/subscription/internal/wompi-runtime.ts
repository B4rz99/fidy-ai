import { Digest } from "effect/crypto";
import { DaviplataOtpPolicy } from "../../../src/core/subscription/contract";
import { type WompiBindings } from "../contract";

import {
  OutboundHttp,
  type OutboundHttpService,
} from "../../../src/shell/outbound-http/operations";
import { type Effect, ManagedRuntime, Option, Redacted, Schema } from "effect";
import type { HttpClient } from "effect/http";

const digestRuntime = ManagedRuntime.make(Digest.layerWebCrypto);

export const workerDigest = digestRuntime.runSync(Digest.Digest);

export type WompiTransportFactory = (
  environment: WompiBindings
) => Effect.Effect<OutboundHttpService>;

export const wompiTransport = ({
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
