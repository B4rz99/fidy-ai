import { isDeepStrictEqual } from "node:util";
import { installedOrigins } from "@fidy/server/browser-transport";
import { WhatsAppBusinessPhoneNumberId } from "@fidy/server/whatsapp-contract";
import { Effect, Option, Schema } from "effect";
import { HttpBody, type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";
import { webSignupDisclosure } from "../../apps/server/src/shell/consent/operations";

const sharedChanges = [
  "NATIVE_STORAGE_ADMISSION",
  "RECOVERY_ISOLATION",
  "BROWSER_ORIGIN",
  "RELEASE_GIT_SHA",
  "SQLITE_STORAGE_RELEASE",
];
const coreChanges = [
  "ACCEPTANCE_PROVIDER_REVISION",
  "NATIVE_FIXTURE_MEMBER",
  "NATIVE_FIXTURE_SIGNING_KEY",
  "NATIVE_FIXTURE_SIGNER_SHA256",
  "GOOGLE_REDIRECT_URI",
  "MICROSOFT_REDIRECT_URI",
  "GOOGLE_CLIENT_ID",
  "MICROSOFT_CLIENT_ID",
  "WOMPI_PUBLIC_KEY",
  "WHATSAPP_BUSINESS_PORTFOLIO_ID",
  "WHATSAPP_SANDBOX_PHONE_NUMBER_ID",
];
const ordinaryProviderSecrets = [
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
  "OPENAI_API_KEY",
  "KAPSO_API_KEY",
  "KAPSO_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "WOMPI_PRIVATE_KEY",
  "WOMPI_INTEGRITY_SECRET",
  "WOMPI_EVENT_SECRET",
];
const plainText = Schema.Struct({
  type: Schema.Literal("plain_text"),
  text: Schema.NonEmptyString,
});
const providerSecret = Schema.is(Schema.Struct({ type: Schema.Literal("secret_text") }));
const production = installedOrigins.production;
const describedText = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("plain_text"), text: Schema.String })
);
const bindingMatches = (binding: unknown, text: string): boolean =>
  Option.exists(describedText(binding), (found) => found.text === text);
type Bindings = Readonly<Record<string, unknown>>;
export const requireCanonicalSignupBindings = ({
  before,
  after,
  role,
}: {
  before: Bindings;
  after: Bindings;
  role: "Core" | "Ingress";
}): void => {
  const changes = sharedChanges.concat(role === "Core" ? coreChanges : []);
  const unchanged = (bindings: Bindings): Record<string, unknown> =>
    Object.fromEntries(Object.entries(bindings).filter(([name]) => !changes.includes(name)));
  const expected = {
    NATIVE_STORAGE_ADMISSION: "open",
    RECOVERY_ISOLATION: "",
    BROWSER_ORIGIN: production.browser,
  };
  if (
    !isDeepStrictEqual(unchanged(before), unchanged(after)) ||
    Object.entries(expected).some(([name, binding]) => !bindingMatches(after[name], binding))
  ) {
    throw Error("Canonical signup would alter retained bindings or launch controls");
  }
  if (role === "Core") requireOrdinaryProviderBindings(after);
};
const requireOrdinaryProviderBindings = (bindings: Bindings): void => {
  for (const provider of ["GOOGLE", "MICROSOFT"]) {
    Schema.decodeUnknownSync(plainText)(bindings[provider + "_CLIENT_ID"]);
    const expected = production.api + "/providers/" + provider.toLowerCase() + "/callback";
    if (!bindingMatches(bindings[provider + "_REDIRECT_URI"], expected)) {
      throw Error("Ordinary provider callback must use the canonical API");
    }
  }
  Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.Literal("plain_text"),
      text: Schema.Union([Schema.Literal(""), WhatsAppBusinessPhoneNumberId]),
    })
  )(bindings.WHATSAPP_SANDBOX_PHONE_NUMBER_ID);
  if (
    ordinaryProviderSecrets.some((name) => !providerSecret(bindings[name])) ||
    coreChanges.slice(0, 4).some((name) => bindings[name] !== undefined)
  ) {
    throw Error("Ordinary signup must use live provider credentials without the fixture signer");
  }
};

const idsDigest = (ids: readonly string[]): string =>
  new Bun.CryptoHasher("sha256").update(ids.toSorted().join("\n")).digest("hex");
const populatedUsers = (objects: ReadonlyMap<string, boolean>): readonly string[] =>
  [...objects.entries()].filter(([, populated]) => populated).map(([id]) => id);

export const signupUserCensus = (
  objects: ReadonlyMap<string, boolean>
): { count: number; sha256: string } => {
  const ids = populatedUsers(objects);
  return { count: ids.length, sha256: idsDigest(ids) };
};
export const addedSignupStore = ({
  objects,
  prior,
}: {
  objects: ReadonlyMap<string, boolean>;
  prior: ReturnType<typeof signupUserCensus>;
}): Option.Option<string> => {
  const ids = populatedUsers(objects);
  const maximumEvidenceUsers = 1000;
  if (ids.length !== prior.count + 1 || ids.length > maximumEvidenceUsers) return Option.none();
  const candidates = ids.filter((_, index) => idsDigest(ids.toSpliced(index, 1)) === prior.sha256);
  return candidates.length === 1 ? Option.fromUndefinedOr(candidates[0]) : Option.none();
};

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const pairing = Schema.Struct({
  pairingId: Schema.NonEmptyString,
  privateVerifier: Schema.NonEmptyString,
});
const redirect = Schema.Struct({ authorizationUrl: Schema.NonEmptyString });
const authorizationEndpoints = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
} as const;
type Provider = keyof typeof authorizationEndpoints;
export const validProviderRedirect = ({
  authorization,
  provider,
}: {
  authorization: string;
  provider: Provider;
}): boolean => {
  const url = new URL(authorization);
  const target = url.origin + url.pathname;
  const query = url.searchParams;
  return (
    target === authorizationEndpoints[provider] &&
    query.get("redirect_uri") === production.api + "/providers/" + provider + "/callback" &&
    query.get("response_type") === "code" &&
    query.get("code_challenge_method") === "S256" &&
    Boolean(
      query.get("client_id") &&
      query.get("state") &&
      query.get("nonce") &&
      query.get("code_challenge")
    )
  );
};

const hostOnlyProviderCookie = (header: string, provider: Provider): boolean => {
  const parts = header.split(";").map((value) => value.trim());
  return (
    header.startsWith("__Host-fidy_" + provider + "=") &&
    ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"].every((attribute) =>
      parts.includes(attribute)
    ) &&
    !/;\s*domain=/iu.test(header)
  );
};
const signupRefusal = (message: string): Effect.Effect<never, Error> =>
  Effect.logError(message).pipe(Effect.andThen(Effect.fail(Error(message))));
const readSignupResponse = Effect.fn(function* <Value>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<Value>,
  stage: string
) {
  const expected = 200;
  if (response.status !== expected) {
    return yield* signupRefusal(stage + " returned HTTP " + response.status);
  }
  return yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(schema)).pipe(
    Effect.catch(() => signupRefusal(stage + " returned an unexpected HTTP 200 response"))
  );
});
export const verifyCanonicalSignupRedirects = Effect.fn(function* (client: HttpClient.HttpClient) {
  const post = (path: string, body: unknown): ReturnType<HttpClient.HttpClient["execute"]> =>
    client.execute(
      HttpClientRequest.post(production.api + path, {
        headers: { origin: production.browser, referer: production.browser + "/login" },
        body: HttpBody.text(encode(body), "application/json"),
      })
    );
  return yield* Effect.forEach(
    ["google", "microsoft"] as const,
    Effect.fn(function* (provider) {
      const session = yield* post("/web/pairings", {});
      const proof = yield* readSignupResponse(session, pairing, "Canonical browser pairing");
      const response = yield* post("/web/providers/" + provider + "/start", {
        ...proof,
        intent: "signup",
        consentRevision: webSignupDisclosure().revision,
      });
      const location = yield* readSignupResponse(
        response,
        redirect,
        "Canonical " + provider + " start"
      );
      const header = response.headers["set-cookie"] ?? "";
      const valid = yield* Effect.try(() =>
        validProviderRedirect({ authorization: location.authorizationUrl, provider })
      );
      if (
        !valid ||
        !hostOnlyProviderCookie(header, provider) ||
        response.headers["access-control-allow-origin"] !== production.browser
      ) {
        return yield* signupRefusal(
          "Canonical " + provider + " signup has an unexpected redirect, cookie or browser origin"
        );
      }
      return { provider, canonicalCallback: true, hostOnlyCookie: true };
    })
  );
});
