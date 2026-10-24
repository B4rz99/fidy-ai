import { type Cause, Effect, Schema } from "effect";
import { expect, vi } from "vitest";
import type { setup } from "./journey.test-fixture";

const successStatus = 200;
const redirectStatus = 303;
const mockGoogleToken = (authorization: URL): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { generateKeyPair, exportJWK, SignJWT } = yield* Effect.tryPromise(() => import("jose"));
    const keys = yield* Effect.tryPromise(() => generateKeyPair("RS256"));
    const jwk = yield* Effect.tryPromise(() => exportJWK(keys.publicKey));
    const token = yield* Effect.tryPromise(() =>
      new SignJWT({ nonce: authorization.searchParams.get("nonce"), email: "person@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "chat" })
        .setIssuer("https://accounts.google.com")
        .setSubject("chat-provider-user")
        .setAudience("test-client")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
    );
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === "https://oauth2.googleapis.com/token") {
        return Promise.resolve(Response.json({ id_token: token }));
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        return Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "chat", alg: "RS256" }] }));
      }
      if (url.startsWith("https://api.kapso.ai/")) {
        return Promise.resolve(
          Response.json({
            messaging_product: "whatsapp",
            messages: [{ id: "wamid.association-review" }],
          })
        );
      }
      return Promise.reject(new Error("Unexpected external destination"));
    });
  });
export const authenticateChatProvider = Effect.fn(function* (
  journey: Awaited<ReturnType<typeof setup>>,
  reference: string
): Effect.fn.Return<void, Cause.UnknownError | Schema.SchemaError> {
  const disclosureResponse = yield* Effect.tryPromise(() =>
    journey.send("/web/providers/disclosure")
  );
  const disclosure = yield* Schema.decodeUnknownEffect(Schema.Struct({ revision: Schema.String }))(
    yield* Effect.tryPromise(() => disclosureResponse.json())
  );
  const start = yield* Effect.tryPromise(() =>
    journey.send("/web/providers/google/start", {
      ...journey.pairing,
      intent: "signup",
      consentRevision: disclosure.revision,
      ...(reference === "" ? {} : { handoffReference: reference }),
    })
  );
  expect(start.status).toBe(successStatus);
  const result = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ authorizationUrl: Schema.String })
  )(yield* Effect.tryPromise(() => start.json()));
  const authorization = new URL(result.authorizationUrl);
  yield* mockGoogleToken(authorization);
  expect(
    (yield* Effect.tryPromise(() =>
      journey.send(
        `/providers/google/callback?state=${authorization.searchParams.get("state")}&code=fixture`,
        undefined,
        { cookie: start.headers.get("set-cookie")?.split(";")[0] ?? "" }
      )
    )).status
  ).toBe(redirectStatus);
});
