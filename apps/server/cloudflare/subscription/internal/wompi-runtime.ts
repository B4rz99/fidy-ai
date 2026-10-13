import { DaviplataOtpPolicy } from "../../../src/core/subscription/contract";
import { type WompiBindings } from "../contract";

import { makeWompiOutboundHttp } from "../../../src/shell/outbound-http/operations";
import { Crypto, Effect, Option, Redacted, Schema } from "effect";
import { type HttpClient } from "effect/http";

export const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, new Uint8Array(bytes))
          .then((value) => new Uint8Array(value)),
      catch: () => undefined,
    }).pipe(Effect.orDie),
});

export type WompiTransportFactory = (
  environment: WompiBindings
) => Effect.Effect<ReturnType<typeof makeWompiOutboundHttp>>;

/** Adapt the transport supplied by the Subscription runtime composition. */
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
    crypto: workerCrypto,
    daviplataSandboxPolicy:
      environment.WOMPI_ENVIRONMENT === "sandbox"
        ? Schema.decodeUnknownOption(DaviplataOtpPolicy)({
            sendUrl: environment.WOMPI_DAVIPLATA_OTP_SEND_URL,
            confirmUrl: environment.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
          })
        : Option.none(),
  });
