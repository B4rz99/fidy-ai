import { Option } from "effect";
import { expect, it } from "vitest";
import {
  addedSignupStore,
  requireCanonicalSignupBindings,
  signupUserCensus,
  validProviderRedirect,
} from "./native-canonical-signup";

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
  const plain = (text: string): { type: string; text: string } => ({ type: "plain_text", text });
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
