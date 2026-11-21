import { Option } from "effect";
import { Cookies } from "effect/http";
import { expect, it } from "vitest";
import {
  addedSignupStore,
  hostOnlyProviderCookie,
  requireCanonicalSignupBindings,
  signupUserCensus,
  validProviderRedirect,
} from "./native-canonical-signup";

type PlainTextBinding = Readonly<{ type: string; text: string }>;

it("verifies the provider cookie independently of other edge cookies and attribute casing", () => {
  const cookie = "__Host-fidy_google=proof; path=/; secure; HTTPOnly; SameSite=lax";
  const headers = ["edge-session=opaque; Path=/; Secure", cookie];
  const google = hostOnlyProviderCookie("google");
  expect(google(Cookies.fromSetCookie(headers))).toBe(true);
  expect(hostOnlyProviderCookie("microsoft")(Cookies.fromSetCookie(headers))).toBe(false);
  expect(google(Cookies.fromSetCookie([cookie + "; Domain=fidyapp.com"]))).toBe(false);
  expect(google(Cookies.fromSetCookie([cookie.replace("; secure", "")]))).toBe(false);
});

it("checks the canonical ordinary OAuth callback without exporting OAuth state", () => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    redirect_uri: "https://api.fidyapp.com/providers/google/callback",
    response_type: "code",
    code_challenge_method: "S256",
    client_id: "client",
    state: "state",
    nonce: "nonce",
    code_challenge: "challenge",
  }).toString();
  expect(validProviderRedirect({ authorization: url.href, provider: "google" })).toBe(true);
  expect(validProviderRedirect({ authorization: url.href, provider: "microsoft" })).toBe(false);
  url.searchParams.set(
    "redirect_uri",
    "https://storage-acceptance.fidyapp.com/providers/google/callback"
  );
  expect(validProviderRedirect({ authorization: url.href, provider: "google" })).toBe(false);
});

it("matches a single new physical signup Store without publishing prior identities", () => {
  const prior = signupUserCensus(
    new Map([
      ["prior", true],
      ["empty", false],
    ])
  );

  expect(prior.count).toBe(1);
  expect(prior.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    addedSignupStore({
      objects: new Map([
        ["prior", true],
        ["new", true],
      ]),
      prior,
    })
  ).toEqual(Option.some("new"));
  expect(
    addedSignupStore({
      objects: new Map([
        ["prior", true],
        ["new", false],
      ]),
      prior,
    })
  ).toEqual(Option.none());
  expect(
    addedSignupStore({
      objects: new Map([
        ["foreign", true],
        ["new", true],
      ]),
      prior,
    })
  ).toEqual(Option.none());
  expect(
    addedSignupStore({
      objects: new Map([
        ["prior", true],
        ["new", true],
        ["other", true],
      ]),
      prior,
    })
  ).toEqual(Option.none());
});

it("retains unmodified launch controls when staging ordinary admission", () => {
  const plain = (text: string): PlainTextBinding => ({ type: "plain_text", text });
  const before = { PROACTIVITY_ENABLED: plain("disabled") };

  const after = {
    ...before,
    NATIVE_STORAGE_ADMISSION: plain("open"),
    RECOVERY_ISOLATION: plain(""),
    BROWSER_ORIGIN: plain("https://app.fidyapp.com"),
  };

  requireCanonicalSignupBindings({ before, after, role: "Ingress" });
  expect(() =>
    requireCanonicalSignupBindings({
      before,
      after: { ...after, PROACTIVITY_ENABLED: plain("enabled") },
      role: "Ingress",
    })
  ).toThrow("retained bindings or launch controls");
});

it("requires the ordinary WhatsApp sandbox binding to be a valid ID or empty", () => {
  const plain = (text: string): PlainTextBinding => ({ type: "plain_text", text });

  const secrets = Object.fromEntries(
    [
      "GOOGLE_CLIENT_SECRET",
      "MICROSOFT_CLIENT_SECRET",
      "KAPSO_WEBHOOK_SECRET",
      "WOMPI_EVENT_SECRET",
      "WOMPI_INTEGRITY_SECRET",
      "OPENAI_API_KEY",
      "KAPSO_API_KEY",
      "RESEND_API_KEY",
      "WOMPI_PRIVATE_KEY",
    ].map((name) => [name, { type: "secret_text" }])
  );

  const before = { ...secrets, WHATSAPP_SANDBOX_PHONE_NUMBER_ID: plain("123456789012345") };

  const after = {
    ...secrets,
    NATIVE_STORAGE_ADMISSION: plain("open"),
    RECOVERY_ISOLATION: plain(""),
    BROWSER_ORIGIN: plain("https://app.fidyapp.com"),
    GOOGLE_CLIENT_ID: plain("google"),
    GOOGLE_REDIRECT_URI: plain("https://api.fidyapp.com/providers/google/callback"),
    MICROSOFT_CLIENT_ID: plain("microsoft"),
    MICROSOFT_REDIRECT_URI: plain("https://api.fidyapp.com/providers/microsoft/callback"),
    WHATSAPP_SANDBOX_PHONE_NUMBER_ID: plain(""),
  };

  requireCanonicalSignupBindings({ before, after, role: "Core" });
  expect(() =>
    requireCanonicalSignupBindings({
      before,
      after: { ...after, WHATSAPP_SANDBOX_PHONE_NUMBER_ID: plain("invalid-id") },
      role: "Core",
    })
  ).toThrow();
});
