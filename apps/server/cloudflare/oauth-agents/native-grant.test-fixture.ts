import { DateTime, Effect, Option, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { expect } from "vitest";
import { oauthIssuer, oauthPaths, oauthResource } from "../../src/shell/oauth-agents/contract";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { browserOrigins } from "../runtime/contract";
import { native, nativeOAuthPlatform } from "../user-store.test-fixture";
import type { Miniflare } from "miniflare";

type NativeResponse = Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>>;

export const tokenPair = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
});

const headers = { "content-type": "application/json", "cf-connecting-ip": "192.0.2.75" };

const status = { created: 201, ok: 200, redirect: 302, invalid: 400 };

const weekMs = 604800000,
  proofLength = 43;

const publicClient = Effect.fn(function* (runtime: Miniflare, scopes: ReadonlyArray<string>) {
  const registration = yield* native(() =>
    runtime.dispatchFetch(oauthIssuer + oauthPaths.register, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_name: "Public client",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    })
  );

  expect(registration.status).toBe(status.created);

  const { client_id } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ client_id: Schema.String })
  )(yield* native(() => registration.json()));

  const authorize = new URL(oauthIssuer + oauthPaths.authorize);
  const verifier = "test-verifier-".repeat(4);

  const challenge = Base64Url.encode(
    new Uint8Array(
      yield* native(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    )
  );

  authorize.search = new URLSearchParams({
    client_id,
    response_type: "code",
    redirect_uri: "https://client.example/callback",
    resource: oauthResource,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: scopes.join(" "),
  }).toString();

  const start = yield* native(() =>
    runtime.dispatchFetch(authorize.href, { headers, redirect: "manual" })
  );

  expect(start.status).toBe(status.redirect);
  expect(start.headers.get("location")).toMatch(/\/oauth\/review\/[\w-]+$/u);
  yield* native(() => start.text());
  authorize.searchParams.set("redirect_uri", "https://other.example/callback");

  const wrong = yield* native(() =>
    runtime.dispatchFetch(authorize.href, { headers, redirect: "manual" })
  );

  expect(wrong.status).toBe(status.invalid);
  yield* native(() => wrong.text());

  return { start, client_id, verifier };
});

const approved = Effect.fn(function* (
  runtime: Miniflare,
  start: Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
  scopes: ReadonlyArray<string>
) {
  const owner = yield* seed(runtime, alice);
  yield* seed(runtime, bob);
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES(?,?,'processing_grant',?)",
    "consent-test",
    alice.user,
    owner.now
  );

  const session = (path: string, subject: typeof alice, payload?: unknown): NativeResponse =>
    native(() =>
      runtime.dispatchFetch(oauthIssuer + path, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          origin: browserOrigins.production,
          cookie: "__Host-fidy_session=" + subject.bearer,
          "Fidy-Session-Binding": subject.session,
        },
        body: payload === undefined ? null : JSON.stringify(payload),
      })
    );

  const requestId = new URL(start.headers.get("location") ?? "").pathname.split("/").at(-1) ?? "";
  const review = yield* session(oauthPaths.review + "?requestId=" + requestId, alice);
  expect(review.status).toBe(status.ok);

  const { reviewedAt } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ reviewedAt: Schema.DateTimeUtcFromString })
  )(yield* native(() => review.json()));

  const choice = {
    requestId,
    scopes,
    lifetimeDays: 7,
    reviewedAt: DateTime.formatIso(reviewedAt),
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(reviewedAt) + weekMs)),
  };

  const foreign = yield* session(oauthPaths.connect, bob, choice);
  expect(foreign.status).toBe(status.invalid);
  yield* native(() => foreign.text());
  const connect = yield* session(oauthPaths.connect, alice, choice);
  expect(connect.status).toBe(status.ok);

  const { callback, connectionId } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ callback: Schema.String, connectionId: Schema.String })
  )(yield* native(() => connect.json()));

  const code = new URL(callback).searchParams.get("code") ?? "";

  return { owner, session, connectionId, code };
});

export const nativeGrantWithScopes = Effect.fn(function* (
  scopes: ReadonlyArray<string>,
  platform: typeof nativeOAuthPlatform = nativeOAuthPlatform
) {
  const create = yield* platform,
    runtime = yield* create();

  const { start, client_id, verifier } = yield* publicClient(runtime, scopes);
  const { owner, session, code, connectionId } = yield* approved(runtime, start, scopes);

  const exchange = (fields: Record<string, string>): NativeResponse =>
    native(() =>
      runtime.dispatchFetch(oauthIssuer + oauthPaths.token, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      })
    );

  const fields = {
    client_id,
    resource: oauthResource,
    code,
    grant_type: "authorization_code",
    redirect_uri: "https://client.example/callback",
    code_verifier: verifier,
  };

  const bad = yield* exchange({ ...fields, code_verifier: "z".repeat(proofLength) });
  expect(bad.status).toBe(status.invalid);
  yield* native(() => bad.text());
  const issued = yield* exchange(fields);
  expect(issued.status).toBe(status.ok);

  const credential = yield* Schema.decodeUnknownEffect(tokenPair)(
    yield* native(() => issued.json())
  );

  const lost = yield* exchange(fields);
  expect(lost.status).toBe(status.invalid);
  expect(yield* native(() => lost.text())).not.toContain(credential.access_token);

  return { runtime, owner, session, exchange, client_id, credential, connectionId };
});

export const nativeGrant = nativeGrantWithScopes(["read", "write"]);

type ToolCall = Readonly<{ name: string; args: unknown }>;

type ContinuedToolCall = ToolCall & Readonly<{ continuation: string }>;

type RetriedToolCall = ToolCall & Readonly<{ retryKey: string }>;

export const protocolFor =
  (
    runtime: Miniflare
  ): ((
    bearer: string,
    method: string,
    input?: ToolCall | ContinuedToolCall | RetriedToolCall
  ) => NativeResponse) =>
  (bearer, method, input) => {
    const name = input?.name,
      args = input?.args,
      continuation =
        input !== undefined && "continuation" in input ? input.continuation : undefined,
      retryKey = input !== undefined && "retryKey" in input ? input.retryKey : undefined;

    return native(() =>
      runtime.dispatchFetch(oauthResource, {
        method: "POST",
        headers: [
          ["cf-connecting-ip", "192.0.2.75"],
          ["authorization", "Bearer " + bearer],
          ["content-type", "application/json"],
          ["accept", "application/json, text/event-stream"],
          ["mcp-protocol-version", "2026-07-28"],
          ["mcp-method", method],
          ...Option.toArray(
            Option.map(Option.fromUndefinedOr(name), (value): [string, string] => [
              "mcp-name",
              value,
            ])
          ),
        ],
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            name,
            arguments: name === undefined ? undefined : args,
            requestState: continuation,
            inputResponses:
              continuation === undefined
                ? undefined
                : { review: { action: "accept", content: { confirm: true } } },
            _meta: {
              "co.fidy/retryKey": retryKey,
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
            },
          },
        }),
      })
    );
  };
