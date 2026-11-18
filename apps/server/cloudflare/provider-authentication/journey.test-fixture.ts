import {
  type Journey,
  legacyCallbackBindings,
  registeredChatDirectory,
} from "./legacy-disclosure.test-fixture";
import { openAiTestKey } from "../openai.test-fixture";
import { Effect, Option, Schema } from "effect";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import publicWorker from "../public-worker";
import coreWorker from "../core-worker";
import { approvedOpenAiModel } from "../../src/shell/hosted-inference/contract";

const databases = isolatedTestDatabases();
const Json = Schema.fromJsonString(Schema.Unknown);
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
type Hosted = Readonly<{
  userId: string;
  coordinatorFetch: (request: Request) => Promise<Response>;
}>;
type JourneyOptions = Readonly<{ sandboxPhoneNumberId: string; hosted: Option.Option<Hosted> }>;
const sendThroughWorkers =
  (db: D1Database, { sandboxPhoneNumberId, hosted }: JourneyOptions): Journey["send"] =>
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
              ...legacyCallbackBindings({
                db,
                identity: Option.map(hosted, (subject) =>
                  registeredChatDirectory({
                    userId: subject.userId,
                    portfolio: "portfolio",
                    bsuid: "CO.Person1",
                  })
                ),
              }),
              OPENAI_API_KEY: openAiTestKey({ run: () => Promise.reject(new Error("unused")) }),
              CONTRACT_DIGEST: "a".repeat(contractDigestLength),
              RELEASE_GIT_SHA: "a".repeat(gitRevisionLength),
              HOSTED_AI_MODEL: approvedOpenAiModel,
              BROWSER_ORIGIN: "https://app.fidyapp.com",
              USER_TRANSACTION_COORDINATOR: {
                getByName: () => ({
                  fetch: Option.isSome(hosted)
                    ? hosted.value.coordinatorFetch
                    : () => Promise.reject(new Error("unused")),
                }),
              },
              KAPSO_API_KEY: "test-kapso-key",
              KAPSO_WEBHOOK_SECRET: "test-kapso-secret",
              WHATSAPP_BUSINESS_PORTFOLIO_ID: "portfolio",
              WHATSAPP_SANDBOX_PHONE_NUMBER_ID: sandboxPhoneNumberId,
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

const setupJourney = (options: JourneyOptions): Promise<Journey> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const send = sendThroughWorkers(db, options);
      return { db, send, sandboxPhoneNumberId: options.sandboxPhoneNumberId };
    })
  );
export const disposeJourneys = (): Promise<void> => databases.dispose();

export const setupWhatsApp = (sandboxPhoneNumberId: string = ""): Promise<Journey> =>
  setupJourney({ sandboxPhoneNumberId, hosted: Option.none() });
export const setupHostedWhatsApp = (
  options: Readonly<{
    userId: string;
    sandboxPhoneNumberId: string;
    coordinatorFetch: (request: Request) => Promise<Response>;
  }>
): Promise<Journey> =>
  setupJourney({
    sandboxPhoneNumberId: options.sandboxPhoneNumberId,
    hosted: Option.some(options),
  });
