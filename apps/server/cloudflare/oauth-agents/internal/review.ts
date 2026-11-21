import { type BootstrapUnavailable } from "../contract";
import { DateTime, Effect, Array as EffectArray, Schema } from "effect";
import type { PlatformError } from "effect";
import {
  OAuthRegistration,
  OAuthRequestId,
  OAuthReview,
  OAuthReviewChoice,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import { type PATScopes } from "../../../src/core/tokens/contract";
import { oauthScopeCopy } from "../../../src/core/oauth-agents/operations";
import { oauthResponse as response } from "./response";
import { type BootstrapInvalid, decodePayload } from "./bootstrap";

import type {
  ResourceAdmissionRefused,
  ResourceAdmissionUnavailable,
} from "../../resource-admission/contract";

type ReviewFailure =
  | BootstrapInvalid
  | BootstrapUnavailable
  | PlatformError.PlatformError
  | Schema.SchemaError
  | ResourceAdmissionRefused
  | ResourceAdmissionUnavailable;

const successStatus = 200;

const Row = Schema.Struct({
  request_json: Schema.String,
  metadata_json: Schema.String,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
});

const Reference = Schema.Struct({ requestId: OAuthRequestId });

export const readReference = (
  request: Request
): Effect.Effect<typeof Reference.Type | OAuthReviewChoice, ReviewFailure> => {
  const path = new URL(request.url).pathname;

  if (path === oauthPaths.review) {
    return Schema.decodeUnknownEffect(Reference, { onExcessProperty: "error" })(
      Object.fromEntries(new URL(request.url).searchParams)
    );
  }

  return path === oauthPaths.cancel
    ? decodePayload({ request, schema: Reference, onExcessProperty: "error" })
    : decodePayload({ request, schema: OAuthReviewChoice, onExcessProperty: "error" });
};

export const projectReview = (
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
      requestExpiresAt: DateTime.formatIso(input.row.expires_at_ms),
      reviewedAt: DateTime.formatIso(DateTime.makeUnsafe(input.current)),
      connectAvailable: true,
    });

    return response({
      body: yield* Schema.encodeEffect(OAuthReview)(review),
      status: successStatus,
    });
  });
