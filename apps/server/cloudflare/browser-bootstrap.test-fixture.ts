import { Effect, Schema } from "effect";
import type { Miniflare } from "miniflare";
import {
  type AuthenticationProvider,
  ProviderBrowserProof,
} from "../src/shell/provider-authentication/contract";
import { webSignupDisclosure } from "../src/shell/consent/operations";
import { native } from "./user-store.test-fixture";
import { browserOrigins, productionTopology } from "./runtime/contract";
import { expect } from "vitest";

const okStatus = 200;

const redirectStatus = 303;

type ResponseEffect = Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;

type Verified = Readonly<{
  proof: typeof ProviderBrowserProof.Type;
  attempt: string;
  review: unknown;
}>;

type LoginOptions = Readonly<{ provider: AuthenticationProvider; scenario: string }>;

type Begun = Readonly<{
  proof: typeof ProviderBrowserProof.Type;
  authorization: URL;
  cookie: string;
}>;

type Browser = Readonly<{
  api: string;
  headers: Record<string, string>;
  post: (path: string, data: unknown) => ResponseEffect;
  pair: Effect.Effect<typeof ProviderBrowserProof.Type, Schema.SchemaError>;
  verified: (
    subject: string,
    handoffReference?: string
  ) => Effect.Effect<Verified, Schema.SchemaError>;
  begin: (
    provider: AuthenticationProvider,
    handoff?: string
  ) => Effect.Effect<Begun, Schema.SchemaError>;
  login: (
    subject: string,
    options: LoginOptions,
    handoff?: string
  ) => Effect.Effect<Verified, Schema.SchemaError>;
}>;

const transport = (runtime: Miniflare): Pick<Browser, "api" | "headers" | "post"> => {
  const api = `https://${productionTopology.ingress.hostname}`;

  const headers = {
    origin: browserOrigins.production,
    "content-type": "application/json",
    "CF-Connecting-IP": "192.0.2.1",
    connection: "close",
  };

  const post = (path: string, data: unknown): ResponseEffect =>
    native(() =>
      runtime.dispatchFetch(api + path, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      })
    );

  return { api, headers, post };
};

const browserWithIntent = (runtime: Miniflare, intent: "signup" | "login"): Browser => {
  const { api, headers, post } = transport(runtime);

  const pair = Effect.gen(function* () {
    const response = yield* post("/web/pairings", {});
    expect(response.status).toBe(okStatus);

    return yield* Schema.decodeUnknownEffect(ProviderBrowserProof)(
      yield* native(() => response.json())
    );
  });

  const begin = Effect.fn(function* (provider: AuthenticationProvider, handoffReference?: string) {
    const proof = yield* pair;

    const start = { ...proof, intent, consentRevision: webSignupDisclosure().revision };

    const started = yield* post(
      `/web/providers/${provider}/start`,
      handoffReference === undefined ? start : { ...start, handoffReference }
    );

    expect(started.status).toBe(okStatus);
    const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";

    const { authorizationUrl } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ authorizationUrl: Schema.String })
    )(yield* native(() => started.json()));

    const authorization = new URL(authorizationUrl);

    return { proof, authorization, cookie };
  });

  const login = Effect.fn(function* (
    subject: string,
    { provider, scenario }: LoginOptions,
    handoffReference?: string
  ) {
    const { proof, authorization, cookie } = yield* begin(provider, handoffReference);
    const state = authorization.searchParams.get("state") ?? "";
    const nonce = authorization.searchParams.get("nonce") ?? "";
    const callback = new URL(`/providers/${provider}/callback`, api);
    callback.search = new URLSearchParams({
      state,
      code: nonce + "." + subject + "." + scenario,
    }).toString();

    const response = yield* native(() =>
      runtime.dispatchFetch(callback.href, { headers: { ...headers, cookie }, redirect: "manual" })
    );

    expect(response.status).toBe(redirectStatus);
    yield* native(() => response.arrayBuffer());
    const status = yield* post(`/web/providers/${provider}/status`, proof);
    expect(status.status).toBe(okStatus);
    const review = yield* native(() => status.json());

    return { proof, attempt: state, review };
  });

  const verified = Effect.fn(function* (subject: string, handoffReference?: string) {
    const value = yield* login(
      subject,
      { provider: "google", scenario: "valid" },
      handoffReference
    );

    expect(handoffReference === undefined ? value.review : { status: "verified" }).toEqual({
      status: "verified",
    });

    return value;
  });

  return { api, headers, post, pair, verified, login, begin };
};

export const browser = (runtime: Miniflare): Browser => browserWithIntent(runtime, "signup");

export const loginOnlyBrowser = (runtime: Miniflare): Browser =>
  browserWithIntent(runtime, "login");

export { chatWith, signedWebhook, signedChat } from "./signed-whatsapp.test-fixture";
