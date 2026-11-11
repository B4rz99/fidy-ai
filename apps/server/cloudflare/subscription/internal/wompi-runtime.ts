import { Digest, SecureRandom } from "effect/crypto";
import { DaviplataOtpPolicy } from "../../../src/core/subscription/contract";
import { type WompiBindings } from "../contract";

import { makeWompiOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { Effect, Option, Redacted, Schema } from "effect";
import { type HttpClient } from "effect/http";

export const workerSecureRandom = SecureRandom.make((size) =>
  crypto.getRandomValues(new Uint8Array(size))
);
export const workerDigest = Effect.runSync(
  Digest.Digest.pipe(Effect.provide(Digest.layerWebCrypto))
);

export type WompiTransportFactory = (
  environment: WompiBindings
) => Effect.Effect<ReturnType<typeof makeWompiOutboundHttp>>;

export const makeWompiTransport = ({
  environment,
  httpClient,
}: Readonly<{ environment: WompiBindings; httpClient: HttpClient.HttpClient }>): ReturnType<
  typeof makeWompiOutboundHttp
> =>
  makeWompiOutboundHttp({
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
