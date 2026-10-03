import { Context, type Crypto, Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeDisclosureSender, makeEmailStatusSender } from "../../../src/shell/consent/runtime";
import { type ConsentIngressEnvironment } from "./contract";
import { receiveConsentText, recoverDisclosures, sweepExpired } from "./internal/ingress";

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
          }),
          sendEmailStatus: makeEmailStatusSender({
            apiKey: Redacted.make(environment.KAPSO_API_KEY),
            httpClient,
          }),
        });
  const ingress = { DB: environment.DB, onAccepted: environment.onAccepted, delivery };
  return (input) => receiveConsentText({ environment: ingress, input });
};

/** Resume only disclosures that never claimed their irreversible provider-send boundary. */
export const recoverPendingDisclosures = ({
  db,
  apiKey,
}: Readonly<{ db: D1Database; apiKey: string }>): Effect.Effect<void, void> =>
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
              })
            );
      yield* recoverDisclosures({ db, delivery });
    })
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));

/** Expire bounded pre-User decisions and their temporary delivery metadata. */
export const sweepExpiredConsent = (db: D1Database): (() => Effect.Effect<void, void>) =>
  sweepExpired(db);
