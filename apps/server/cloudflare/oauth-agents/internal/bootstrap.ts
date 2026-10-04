import { Data, Effect, Option, Schema } from "effect";
import { OAuthAuthorization, OAuthRegistration } from "../../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { newId } from "../../secret-material/operations";
import { oauthResponse as jsonResponse } from "./response";

const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 3000,
});
const attemptLifetimeMs = 600_000;
const unusedLifetimeMs = 2_592_000_000;
const millisecondsPerSecond = 1000;
const registrationStatus = 201;
const invalidStatus = 400;
export const invalidRequest = (): Response =>
  jsonResponse({ body: { error: "invalid_request" }, status: invalidStatus });
export class BootstrapInvalid extends Data.TaggedError("BootstrapInvalid") {}
export class BootstrapUnavailable extends Data.TaggedError("BootstrapUnavailable") {}
export const dbWork = <A>(run: () => Promise<A>): Effect.Effect<A, BootstrapUnavailable> =>
  Effect.uninterruptible(Effect.tryPromise({ try: run, catch: () => new BootstrapUnavailable() }));

/** Strict decoding refuses unsupported metadata rather than silently trusting or fetching claims. */
export const decodePayload = <Shape extends Schema.ConstraintDecoder<unknown>>(
  input: Readonly<{ request: Request; schema: Shape }>
): Effect.Effect<Shape["Type"], BootstrapInvalid> =>
  Effect.gen(function* () {
    if (input.request.headers.get("content-type")?.split(";")[0] !== "application/json") {
      return yield* Effect.fail(undefined);
    }
    const bytes = yield* readBoundedRequestBody(input.request, policy);
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => undefined,
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(input.schema), {
      onExcessProperty: "error",
    })(text);
  }).pipe(Effect.catchCause(() => Effect.fail(new BootstrapInvalid())));
export const registerClient = (
  input: Readonly<{ request: Request; db: D1Database; current: number }>
): Effect.Effect<Response, BootstrapInvalid | BootstrapUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const metadata = yield* decodePayload({ request: input.request, schema: OAuthRegistration });
    if (
      metadata.grant_types !== undefined &&
      !metadata.grant_types.includes("authorization_code")
    ) {
      return jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus });
    }
    const id = newId();
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthRegistration))(metadata);
    yield* dbWork(() =>
      input.db.batch([
        input.db
          .prepare(
            "DELETE FROM oauth_public_clients WHERE id IN (SELECT id FROM oauth_public_clients WHERE last_used_at_ms <= ? ORDER BY last_used_at_ms LIMIT 64)"
          )
          .bind(input.current - unusedLifetimeMs),
        input.db
          .prepare(
            "INSERT INTO oauth_public_clients(id, metadata_json, created_at_ms, last_used_at_ms) VALUES (?, ?, ?, ?)"
          )
          .bind(id, encoded, input.current, input.current),
      ])
    );
    return jsonResponse({
      body: {
        client_id: id,
        client_id_issued_at: Math.floor(input.current / millisecondsPerSecond),
        ...metadata,
        grant_types: metadata.grant_types ?? ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      status: registrationStatus,
    });
  }).pipe(
    Effect.catchTags({
      BootstrapInvalid: () =>
        Effect.succeed(
          jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus })
        ),
      SchemaError: () =>
        Effect.succeed(
          jsonResponse({ body: { error: "invalid_client_metadata" }, status: invalidStatus })
        ),
    })
  );
const registeredRedirect = (registered: string, requested: string): boolean => {
  if (registered === requested) return true;
  const original = new URL(registered);
  if (original.protocol !== "http:") return false;
  const callback = new URL(requested);
  callback.port = original.port;
  return callback.href === registered;
};
export const requestedScopes = (scope: Option.Option<string>): Option.Option<PATScopes> => {
  const scopes = Option.match(scope, {
    onNone: () => ["read"],
    onSome: (value) => value.split(" "),
  });
  if (new Set(scopes).size !== scopes.length) return Option.none();
  return Schema.decodeUnknownOption(PATScopes)(scopes);
};
const retainAuthorization = (
  input: Readonly<{ request: OAuthAuthorization; db: D1Database; current: number; source: string }>
): Effect.Effect<string, Schema.SchemaError | BootstrapUnavailable> =>
  Effect.gen(function* () {
    const id = newId();
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthAuthorization))(
      input.request
    );
    yield* dbWork(() =>
      input.db.batch([
        input.db
          .prepare(
            "DELETE FROM oauth_review_requests WHERE id IN (SELECT id FROM oauth_review_requests WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 64)"
          )
          .bind(input.current),
        input.db
          .prepare(
            "INSERT INTO oauth_review_requests(id, client_id, request_json, source_digest, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .bind(
            id,
            input.request.client_id,
            encoded,
            input.source,
            input.current,
            input.current + attemptLifetimeMs
          ),
        input.db
          .prepare("UPDATE oauth_public_clients SET last_used_at_ms = ? WHERE id = ?")
          .bind(input.current, input.request.client_id),
      ])
    );
    return id;
  });
export const startAuthorization = (
  input: Readonly<{
    request: Request;
    db: D1Database;
    current: number;
    source: string;
    browserOrigin: string;
  }>
): Effect.Effect<Response, Schema.SchemaError | BootstrapUnavailable> =>
  Effect.gen(function* () {
    const query = new URL(input.request.url).searchParams;
    if (new Set(query.keys()).size !== Array.from(query.keys()).length) return invalidRequest();
    const request = yield* Schema.decodeUnknownEffect(OAuthAuthorization, {
      onExcessProperty: "error",
    })(Object.fromEntries(query));
    const scopes = requestedScopes(Option.fromUndefinedOr(request.scope));
    if (Option.isNone(scopes)) return invalidRequest();
    const found = yield* dbWork(() =>
      input.db
        .prepare(
          "SELECT metadata_json FROM oauth_public_clients WHERE id = ? AND last_used_at_ms > ?"
        )
        .bind(request.client_id, input.current - unusedLifetimeMs)
        .first<string>("metadata_json")
    );
    const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OAuthRegistration))(
      found
    );
    if (!metadata.redirect_uris.some((uri) => registeredRedirect(uri, request.redirect_uri))) {
      return invalidRequest();
    }
    const id = yield* retainAuthorization({ ...input, request });
    return new Response(null, {
      status: 302,
      headers: {
        location: `${input.browserOrigin}/oauth/review/${id}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  });
