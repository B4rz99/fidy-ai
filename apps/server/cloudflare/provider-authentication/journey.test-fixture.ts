import { Effect, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
const Json = Schema.fromJsonString(Schema.Unknown);
const Pairing = Schema.Struct({ pairingId: Schema.String, privateVerifier: Schema.String });
export type Journey = Readonly<{
  db: D1Database;
  send: (
    path: string,
    body?: unknown,
    headers?: Readonly<Record<string, string>> | Headers
  ) => Promise<Response>;
  pairing: typeof Pairing.Type;
}>;
const gitRevisionLength = 40;
const admissionKeyLength = 43;
const contractDigestLength = 64;
const requestHeaders = (overrides: Readonly<Record<string, string>>): Headers => {
  const headers = new Headers({
    origin: "https://app.fidyapp.com",
    "cf-connecting-ip": "127.0.0.1",
    "content-type": "application/json",
  });
  for (const [name, value] of Object.entries(overrides)) headers.set(name, value);
  return headers;
};
const sendThroughWorkers =
  (db: D1Database): Journey["send"] =>
  (
    path: string,
    body?: unknown,
    headers: Readonly<Record<string, string>> | Headers = {}
  ): Promise<Response> =>
    publicWorker.fetch(
      new Request(`https://api.fidyapp.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: headers instanceof Headers ? headers : requestHeaders(headers),
        ...(body === undefined ? {} : { body: Schema.encodeSync(Json)(body) }),
      }),
      {
        RELEASE_GIT_SHA: "a".repeat(gitRevisionLength),
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        LOCAL_CANONICAL_READ_BEARER: "",
        PAT_ADMISSION_KEY: "a".repeat(admissionKeyLength),
        CORE: {
          fetch: (request): Promise<Response> =>
            coreWorker.fetch(new Request(request), {
              DB: db,
              AI: { run: () => Promise.reject(new Error("unused")) },
              CONTRACT_DIGEST: "a".repeat(contractDigestLength),
              RELEASE_GIT_SHA: "a".repeat(gitRevisionLength),
              HOSTED_AI_MODEL: approvedWorkersAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              MICROSOFT_CLIENT_ID: "test-client",
              MICROSOFT_CLIENT_SECRET: "test-secret",
              MICROSOFT_REDIRECT_URI: "https://api.fidyapp.com/providers/microsoft/callback",
              GOOGLE_CLIENT_ID: "test-client",
              GOOGLE_CLIENT_SECRET: "test-secret",
              GOOGLE_REDIRECT_URI: "https://api.fidyapp.com/providers/google/callback",
              USER_TRANSACTION_COORDINATOR: {
                getByName: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
              },
              KAPSO_API_KEY: "test-kapso-key",
              KAPSO_WEBHOOK_SECRET: "test-kapso-secret",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              CLOUDFLARE_ACCESS_ISSUER: "https://test.cloudflareaccess.com",
              CLOUDFLARE_ACCESS_AUDIENCE: "support",
              WOMPI_ENVIRONMENT: "sandbox",
              WOMPI_PUBLIC_KEY: "",
              WOMPI_PRIVATE_KEY: "",
              WOMPI_INTEGRITY_SECRET: "",
            }),
        },
      }
    );

const setupJourney = (options: Readonly<{ whatsapp: boolean }>): Promise<Journey> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() =>
        installTestSchema({
          db,
          sources:
            options.whatsapp === true
              ? Array.from(
                  new Bun.Glob("*.sql").scanSync({
                    cwd: new URL("../migrations/", import.meta.url).pathname,
                  })
                )
                  .sort()
                  .map((name) => new URL(`../migrations/${name}`, import.meta.url))
              : [
                  "0003_pending_consent",
                  "0004_onboarding_email",
                  "0005_verified_onboarding",
                  "0006_browser_login",
                  "0066_provider_authentication",
                  "0067_microsoft_authentication",
                  "0068_whatsapp_provider_handoff",
                  "0069_retire_email_code_signup",
                ].map((name) => new URL(`../migrations/${name}.sql`, import.meta.url)),
        })
      );
      const send = sendThroughWorkers(db);
      const response = yield* Effect.tryPromise(() => send("/web/pairings", {}));
      const pairing = yield* Schema.decodeUnknownEffect(Pairing)(
        yield* Effect.tryPromise(() => response.json())
      );
      return { db, send, pairing };
    })
  );
export const disposeJourneys = (): Promise<void> => databases.dispose();

export const setup = (): Promise<Journey> => setupJourney({ whatsapp: false });
export const setupWhatsApp = (): Promise<Journey> => setupJourney({ whatsapp: true });
