import { Clock, Context, Crypto, Effect, Layer, Option, Redacted } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { TestCrypto } from "../src/shell/testing/crypto-harness";
import {
  activateBancolombiaSandbox,
  revokeBancolombiaSandboxGrant,
} from "./bancolombia-authentication/operations";
import { BancolombiaAuthorizationFailed } from "./bancolombia-authentication/contract";
import {
  ConnectionAuthorizationUnavailable,
  type ConnectionBankActivation,
  type ConnectionBankCleanup,
} from "./connections/contract";

const issuer = "https://auth1-api-open-finance-sandbox.ambientesbc.com";
const token = "https://as1-api-open-finance-sandbox.ambientesbc.com/token";
const accountsUrl =
  "https://rs1-api-open-finance-sandbox.ambientesbc.com/open-banking/v1/deposits/accounts";
const jwks =
  "https://s3.us-east-1.amazonaws.com/keystore.sandbox.bancol.col-hub-prod.ozoneapi.co.uk/server";
const clientId = "10000000-0000-4000-8000-000000000001";
const tokenSeconds = 300;
const millisecondsPerSecond = 1000;
const unavailableStatus = 503;
const successfulStatus = 200;
const uncertainStatus = 504;
type Scenario =
  | "ready"
  | "issuer"
  | "missing-identity"
  | "subject"
  | "expired"
  | "future"
  | "not-before"
  | "intent"
  | "authorized-party"
  | "access-hash"
  | "code-hash"
  | "state-hash"
  | "audience"
  | "signature"
  | "consent"
  | "permissions"
  | "malformed"
  | "duplicate"
  | "foreign-page"
  | "looped-page"
  | "skipped-page"
  | "invalid-position"
  | "over-limit"
  | "paginated"
  | "truncated"
  | "contradictory"
  | "partial"
  | "uncertain";
type State = {
  scenario: Scenario;
  exchanges: number;
  consentReads: number;
  beforeAccounts: Effect.Effect<void>;
  beforeCleanup: Effect.Effect<void>;
  cleanupRejected: boolean;
  tokenLabel: string;
  revocations: string[];
};
type ActivationInput = Parameters<ConnectionBankActivation["activate"]>[0];

const fixtureKeys = Effect.gen(function* () {
  const crypto = Context.get(yield* Layer.build(TestCrypto), Crypto.Crypto);
  const client = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  const bank = yield* Effect.tryPromise(() => generateKeyPair("RS256", { extractable: true }));
  return {
    credentials: {
      crypto,
      clientId,
      privateKey: Redacted.make(yield* Effect.tryPromise(() => exportPKCS8(client.privateKey))),
      publicKey: {
        ...(yield* Effect.tryPromise(() => exportJWK(client.publicKey))),
        kid: "client",
        alg: "RS256",
      },
    },
    clientPrivate: client.privateKey,
    bankPrivate: bank.privateKey,
    bankKey: {
      ...(yield* Effect.tryPromise(() => exportJWK(bank.publicKey))),
      kid: "bank",
      alg: "RS256",
    },
  };
});
type Material = Effect.Success<typeof fixtureKeys>;

const tokenResponse = (
  request: HttpClientRequest.HttpClientRequest,
  state: State,
  identity: string
): Response => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected form");
  const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
  const codeExchange = form.get("grant_type") === "authorization_code";
  if (codeExchange) state.exchanges += 1;
  if (codeExchange && state.scenario === "uncertain") {
    return new Response(null, { status: uncertainStatus });
  }
  return Response.json({
    access_token: codeExchange ? `${state.tokenLabel}synthetic-access` : "synthetic-application",
    ...(codeExchange
      ? {
          refresh_token: `${state.tokenLabel}synthetic-refresh`,
          ...(state.scenario === "missing-identity" ? {} : { id_token: identity }),
        }
      : {}),
    expires_in: tokenSeconds,
    token_type: "Bearer",
    scope: "accounts",
  });
};
const incompletePages = (state: State, request: HttpClientRequest.HttpClientRequest): Response => {
  const second = request.urlParams.params.length > 0;
  if (
    second &&
    !request.urlParams.params.some(([key, value]) => key === "pageNumber" && value === "2")
  ) {
    throw new Error("Expected contract pageNumber");
  }
  const body = {
    Data: { AccountReport: [{ AccountIdentification: second ? "second" : "first" }] },
  };
  if (!second) {
    return Response.json({
      ...body,
      Data: {
        ...body.Data,
        Links: {
          Next: `${accountsUrl}?pageNumber=2`,
          Last: `${accountsUrl}?pageNumber=${state.scenario === "paginated" ? 2 : 3}`,
        },
      },
    });
  }
  if (state.scenario === "contradictory") {
    return Response.json({
      Data: { ...body.Data, Links: { Last: `${accountsUrl}?pageNumber=2` } },
    });
  }
  return Response.json(body);
};
const hostilePage = (scenario: Scenario): Response => {
  const next =
    scenario === "foreign-page"
      ? "https://attacker.invalid/accounts?pageNumber=2"
      : `${accountsUrl}?pageNumber=${scenario === "looped-page" ? 1 : 3}`;
  return Response.json({
    Data: {
      AccountReport: [{ AccountIdentification: "first" }],
      Links: scenario === "over-limit" ? { Last: `${accountsUrl}?pageNumber=21` } : { Next: next },
    },
  });
};
const accountResponse = (state: State, request: HttpClientRequest.HttpClientRequest): Response => {
  if (state.scenario === "invalid-position") {
    return Response.json({
      Data: {
        AccountReport: [{ AccountIdentification: "first" }],
        Links: { Previous: "https://attacker.invalid/accounts?pageNumber=0" },
      },
    });
  }
  if (state.scenario === "malformed") {
    return Response.json({ Data: { AccountReport: [{ AccountIdentification: {} }] } });
  }
  if (state.scenario === "partial" && request.urlParams.params.length > 0) {
    return new Response(null, { status: unavailableStatus });
  }
  if (["foreign-page", "looped-page", "skipped-page", "over-limit"].includes(state.scenario)) {
    return hostilePage(state.scenario);
  }
  if (["truncated", "contradictory", "paginated"].includes(state.scenario)) {
    return incompletePages(state, request);
  }
  return readyAccounts(state.scenario);
};
const readyAccounts = (scenario: Scenario): Response =>
  Response.json({
    Data: {
      AccountReport: [
        { AccountIdentification: "synthetic-account-a" },
        {
          AccountIdentification:
            scenario === "duplicate" ? "synthetic-account-a" : "synthetic-account-b",
        },
      ],
      ...(scenario === "partial" ? { Links: { Next: `${accountsUrl}?pageNumber=2` } } : {}),
    },
  });
const bankResponse = (
  input: Readonly<{
    request: HttpClientRequest.HttpClientRequest;
    state: State;
    material: Material;
    identity: string;
    activation: ActivationInput;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { request, state, material, identity, activation } = input;
    if (request.url === jwks) return Response.json({ keys: [material.bankKey] });
    if (request.url.endsWith("/.well-known/openid-configuration")) {
      return bankDiscovery();
    }
    if (
      request.url === `${token}/revoke` ||
      request.url === token.replace("/token", "/introspection")
    ) {
      return yield* cleanupResponse(request, state);
    }
    if (request.url === token) return tokenResponse(request, state, identity);
    if (request.url.includes("account-access-consent/")) {
      return consentResponse(state, activation);
    }
    yield* state.beforeAccounts;
    return accountResponse(state, request);
  });

const bankIdentity = (
  material: Material,
  state: State,
  input: ActivationInput
): Effect.Effect<string, BancolombiaAuthorizationFailed> =>
  Effect.gen(function* () {
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / millisecondsPerSecond);
    const hash = (value: string): Effect.Effect<string, BancolombiaAuthorizationFailed> =>
      material.credentials.crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
        Effect.map((digest) => Base64Url.encode(digest.slice(0, digest.length / 2))),
        Effect.mapError(() => new BancolombiaAuthorizationFailed())
      );
    const payload = {
      openbanking_intent_id: state.scenario === "intent" ? "other-consent" : input.consentId,
      azp: state.scenario === "authorized-party" ? "other-client" : clientId,
      at_hash: yield* hash(
        state.scenario === "access-hash" ? "other-access" : `${state.tokenLabel}synthetic-access`
      ),
      c_hash: yield* hash(
        state.scenario === "code-hash" ? "other-code" : Redacted.value(input.code)
      ),
      s_hash: yield* hash(state.scenario === "state-hash" ? "other-state" : input.state),
      ...(state.scenario === "not-before" ? { nbf: issuedAt + tokenSeconds } : {}),
    };
    return yield* Effect.tryPromise(() =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "bank" })
        .setIssuer(state.scenario === "issuer" ? "https://other.example" : issuer)
        .setAudience(state.scenario === "audience" ? "other-client" : clientId)
        .setSubject(state.scenario === "subject" ? "" : "synthetic-bank-user")
        .setIssuedAt(state.scenario === "future" ? issuedAt + tokenSeconds : issuedAt)
        .setExpirationTime(state.scenario === "expired" ? issuedAt - 1 : issuedAt + tokenSeconds)
        .sign(state.scenario === "signature" ? material.clientPrivate : material.bankPrivate)
    );
  }).pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed()));

const makeActivation = (material: Material, state: State): ConnectionBankActivation => ({
  clientId,
  activate: (input) =>
    Effect.gen(function* () {
      const identity = yield* bankIdentity(material, state, input);
      const httpClient = HttpClient.make((request) =>
        bankResponse({ request, state, material, identity, activation: input }).pipe(
          Effect.map((response) => HttpClientResponse.fromWeb(request, response))
        )
      );
      return yield* activateBancolombiaSandbox({
        ...material.credentials,
        ...input,
        httpClient,
        retainGrant: (grant) =>
          input
            .retainGrant(grant)
            .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
      });
    }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable())),
});

export const activationFixture = Effect.gen(function* () {
  const material = yield* fixtureKeys;
  const state: State = {
    scenario: "ready",
    exchanges: 0,
    consentReads: 0,
    beforeAccounts: Effect.void,
    beforeCleanup: Effect.void,
    cleanupRejected: false,
    tokenLabel: "",
    revocations: [],
  };
  return {
    cleanup: makeCleanup(material, state),
    revocations: (): ReadonlyArray<string> => state.revocations,
    tokenLabel: (value: string): void => {
      state.tokenLabel = value;
    },
    cleanupRejected: (value: boolean): void => {
      state.cleanupRejected = value;
    },
    beforeCleanup: (work: Effect.Effect<void>): void => {
      state.beforeCleanup = work;
    },
    credentials: material.credentials,
    activation: makeActivation(material, state),
    exchanges: (): number => state.exchanges,
    scenario: (value: Scenario): void => {
      state.scenario = value;
    },
    beforeAccounts: (work: Effect.Effect<void>): void => {
      state.beforeAccounts = work;
    },
  };
}).pipe(Effect.scoped);

const bankDiscovery = (): Response =>
  Response.json({
    issuer,
    token_endpoint: token,
    jwks_uri: jwks,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ["RS256"],
    tls_client_certificate_bound_access_tokens: true,
    revocation_endpoint: `${token}/revoke`,
    introspection_endpoint: token.replace("/token", "/introspection"),
    mtls_endpoint_aliases: {
      token_endpoint: token,
      revocation_endpoint: `${token}/revoke`,
      introspection_endpoint: token.replace("/token", "/introspection"),
    },
  });
const cleanupResponse = (
  request: HttpClientRequest.HttpClientRequest,
  state: State
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    yield* state.beforeCleanup;
    if (request.body._tag !== "Uint8Array") throw new Error("Expected token form");
    const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
    const held = form.get("token") ?? "";
    if (request.url === `${token}/revoke`) {
      if (!state.cleanupRejected) state.revocations.push(held);
      return new Response(null, {
        status: state.cleanupRejected ? unavailableStatus : successfulStatus,
      });
    }
    return Response.json({ active: !state.revocations.includes(held), client_id: clientId });
  });
const makeCleanup = (material: Material, state: State): ConnectionBankCleanup => ({
  clientId,
  revoke: (input) =>
    revokeBancolombiaSandboxGrant({
      ...material.credentials,
      grant: input.grant,
      proof: Option.some({
        observedTokens: input.observedTokens,
        recordActive: (tokenType) =>
          input
            .recordActive(tokenType)
            .pipe(Effect.mapError(() => new BancolombiaAuthorizationFailed())),
      }),
      httpClient: HttpClient.make((request) =>
        (request.method === "GET"
          ? Effect.sync(bankDiscovery)
          : cleanupResponse(request, state)
        ).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)))
      ),
    }).pipe(Effect.mapError(() => new ConnectionAuthorizationUnavailable())),
});

const consentResponse = (state: State, activation: ActivationInput): Response => {
  state.consentReads += 1;
  return Response.json({
    Data: {
      ConsentId: activation.consentId,
      Status: state.scenario === "consent" && state.consentReads > 1 ? "Revoked" : "Authorised",
      Permissions: state.scenario === "permissions" ? [] : activation.intent.permissions,
    },
  });
};
