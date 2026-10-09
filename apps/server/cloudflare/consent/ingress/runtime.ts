import { Context, type Crypto, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeDisclosureSender } from "../../../src/shell/consent/runtime";
import { type ConsentIngressEnvironment } from "./contract";
import { receiveConsentText, recoverDisclosures, sweepExpired } from "./internal/ingress";
import { recordConsentDelivery } from "./operations";
import { reconcileSandboxDelivery } from "./internal/reconcile-delivery";
import { makeDeliveryVerifier } from "../../../src/shell/channels/whatsapp/runtime";

/** Construct pre-User Consent handling for authenticated typed text and exact-body replay evidence. */
export const makeConsentIngress = ({
  environment,
  httpClient,
}: Readonly<{
  environment: ConsentIngressEnvironment;
  httpClient: HttpClient.HttpClient;
}>): ((
  input: Parameters<typeof receiveConsentText>[0]["input"]
) => Effect.Effect<Response, void, Crypto.Crypto>) => {
  const delivery =
    environment.KAPSO_API_KEY.length === 0
      ? Option.none()
      : Option.some({
          sendDisclosure: makeDisclosureSender({
            apiKey: Redacted.make(environment.KAPSO_API_KEY),
            httpClient,
            sandboxPhoneNumberId: Option.fromNullishOr(
              environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID
            ),
          }),
        });
  const ingress = {
    DB: environment.DB,
    delivery,
    sandboxPhoneNumberId: Option.fromNullishOr(environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID),
  };
  const verify = makeDeliveryVerifier({
    apiKey: Redacted.make(environment.KAPSO_API_KEY),
    httpClient,
  });
  return (input) =>
    Effect.gen(function* () {
      yield* reconcileSandboxDelivery({
        db: environment.DB,
        sandboxPhoneNumberId: ingress.sandboxPhoneNumberId,
        inbound: input,
        verify,
        recordDelivery: (deliveryInput) =>
          recordConsentDelivery({ db: environment.DB, input: deliveryInput }),
      });
      return yield* receiveConsentText({ environment: ingress, input });
    });
};

/** Resume only disclosures that never claimed their irreversible provider-send boundary. */
export const recoverPendingDisclosures = ({
  db,
  apiKey,
  sandboxPhoneNumberId,
}: Readonly<{
  db: D1Database;
  apiKey: string;
  sandboxPhoneNumberId: Option.Option<string>;
}>): Effect.Effect<void, void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const clients = yield* Layer.build(FetchHttpClient.layer);
      const delivery =
        apiKey.length === 0
          ? Option.none()
          : Option.some(
              makeDisclosureSender({
                apiKey: Redacted.make(apiKey),
                httpClient: Context.get(clients, HttpClient.HttpClient),
                sandboxPhoneNumberId,
              })
            );
      yield* recoverDisclosures({ db, delivery });
    })
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));

/** Expire bounded pre-User decisions and their temporary delivery metadata. */
export const sweepExpiredConsent = (db: D1Database): (() => Effect.Effect<void, void>) =>
  sweepExpired(db);
