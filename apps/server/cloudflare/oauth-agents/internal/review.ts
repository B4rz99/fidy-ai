import { DateTime, Effect, Array as EffectArray, Option, Schema } from "effect";
import { approveRequest } from "./approval";
import type { PlatformError } from "effect";
import {
  OAuthAuthorization,
  OAuthRegistration,
  OAuthRequestId,
  OAuthReview,
  OAuthReviewChoice,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import { type PATScopes } from "../../../src/core/tokens/contract";
import { oauthScopeCopy } from "../../../src/core/oauth-agents/operations";
import { oauthResponse as response } from "./response";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import { freshBrowserSession } from "../../web-session/operations";
import {
  type BootstrapInvalid,
  type BootstrapUnavailable,
  dbWork,
  decodePayload,
  invalidRequest,
  requestedScopes,
} from "./bootstrap";

import type {
  ResourceAdmissionRefused,
  ResourceAdmissionUnavailable,
} from "../../resource-admission/contract";

type ReviewInput = Readonly<{
  admitUser: (
    userId: string
  ) => Effect.Effect<
    void,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable | Schema.SchemaError
  >;
  request: Request;
  db: D1Database;
  current: number;
  browserOrigin: string;
}>;
type ReviewFailure =
  | BootstrapInvalid
  | BootstrapUnavailable
  | PlatformError.PlatformError
  | Schema.SchemaError
  | ResourceAdmissionRefused
  | ResourceAdmissionUnavailable;
const successStatus = 200;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const Row = Schema.Struct({
  request_json: Schema.String,
  metadata_json: Schema.String,
  expires_at_ms: Schema.Int,
});
const Reference = Schema.Struct({ requestId: OAuthRequestId });
const readReference = (
  request: Request
): Effect.Effect<typeof Reference.Type | OAuthReviewChoice, ReviewFailure> => {
  const path = new URL(request.url).pathname;
  if (path === oauthPaths.review) {
    return Schema.decodeUnknownEffect(Reference, { onExcessProperty: "error" })(
      Object.fromEntries(new URL(request.url).searchParams)
    );
  }
  return path === oauthPaths.cancel
    ? decodePayload({ request, schema: Reference })
    : decodePayload({ request, schema: OAuthReviewChoice });
};
const bindPending = (
  input: ReviewInput & Readonly<{ requestId: string; session: FreshSessionSubject }>
): Effect.Effect<typeof Row.Type, ReviewFailure> =>
  Effect.gen(function* () {
    const guard = freshSessionConditions(input);
    const bound = yield* dbWork(() =>
      input.db.batch([
        input.db
          .prepare(
            `UPDATE oauth_review_requests SET user_id = ? WHERE id = ? AND state = 'pending' AND expires_at_ms > ? AND (user_id = ? OR (user_id IS NULL AND (SELECT count(*) FROM oauth_review_requests WHERE user_id = ? AND state = 'pending' AND expires_at_ms > ?) < 5)) AND ${guard.sql}`
          )
          .bind(
            input.session.user_id,
            input.requestId,
            input.current,
            input.session.user_id,
            input.session.user_id,
            input.current,
            ...guard.params
          ),
        input.db
          .prepare(
            `SELECT r.request_json, c.metadata_json, r.expires_at_ms FROM oauth_review_requests r JOIN oauth_public_clients c ON c.id = r.client_id WHERE r.id = ? AND r.user_id = ? AND r.state = 'pending' AND r.expires_at_ms > ? AND ${guard.sql}`
          )
          .bind(input.requestId, input.session.user_id, input.current, ...guard.params),
      ])
    );
    return yield* Schema.decodeUnknownEffect(Row)(bound[1]?.results[0]);
  });
const projectReview = (
  input: Readonly<{ row: typeof Row.Type; requestId: string; scopes: PATScopes; current: number }>
): Effect.Effect<Response, Schema.SchemaError> =>
  Effect.gen(function* () {
    const client = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthRegistration))(
      input.row.metadata_json
    );
    const review = yield* Schema.decodeUnknownEffect(OAuthReview)({
      requestId: input.requestId,
      claimedClientName: client.client_name,
      scopes: input.scopes,
      permissions: EffectArray.map(input.scopes, (scope) => ({
        scope,
        label: oauthScopeCopy[scope].label,
        description: oauthScopeCopy[scope].description,
      })),
      requestExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.row.expires_at_ms)),
      reviewedAt: DateTime.formatIso(DateTime.makeUnsafe(input.current)),
      connectAvailable: true,
    });
    return response({
      body: yield* Schema.encodeEffect(OAuthReview)(review),
      status: successStatus,
    });
  });
const cancelPending = (
  input: ReviewInput & Readonly<{ requestId: string; session: FreshSessionSubject }>
): Effect.Effect<Response, BootstrapUnavailable> =>
  Effect.gen(function* () {
    const guard = freshSessionConditions(input);
    const cancelled = yield* dbWork(() =>
      input.db
        .prepare(
          `UPDATE oauth_review_requests SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state = 'pending' AND expires_at_ms > ? AND ${guard.sql}`
        )
        .bind(input.requestId, input.session.user_id, input.current, ...guard.params)
        .run()
    );
    return cancelled.meta.changes === 1
      ? response({ body: { cancelled: true }, status: successStatus })
      : invalidRequest();
  });
const processReview = (
  input: ReviewInput & Readonly<{ session: FreshSessionSubject }>
): Effect.Effect<Response, ReviewFailure> =>
  Effect.gen(function* () {
    const payload = yield* readReference(input.request);
    const bound = { ...input, requestId: payload.requestId };
    const row = yield* bindPending(bound);
    const pending = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthAuthorization))(
      row.request_json
    );
    const scopes = requestedScopes(Option.fromUndefinedOr(pending.scope));
    if (Option.isNone(scopes)) return invalidRequest();
    const path = new URL(input.request.url).pathname;
    if (path === oauthPaths.cancel) return yield* cancelPending(bound);
    if (path === oauthPaths.connect) {
      if (
        !("scopes" in payload) ||
        !payload.scopes.every((scope) => scopes.value.includes(scope))
      ) {
        return invalidRequest();
      }
      const client = yield* Schema.decodeEffect(Schema.fromJsonString(OAuthRegistration))(
        row.metadata_json
      );
      return yield* approveRequest({ ...input, pending, client, choice: payload });
    }
    return yield* projectReview({
      row,
      requestId: payload.requestId,
      scopes: scopes.value,
      current: input.current,
    });
  });
export const reviewRequest = (input: ReviewInput): Effect.Effect<Response, ReviewFailure> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return response({ body: { error: "forbidden_origin" }, status: forbiddenStatus });
    }
    const query = new URL(input.request.url).searchParams;
    if (new Set(query.keys()).size !== Array.from(query.keys()).length) return invalidRequest();
    const session = yield* dbWork(() => freshBrowserSession(input));
    if (Option.isNone(session)) {
      return response({ body: { error: "unauthenticated" }, status: unauthorizedStatus });
    }
    yield* input.admitUser(session.value.user_id);
    return yield* processReview({ ...input, session: session.value });
  });
