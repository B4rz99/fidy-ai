import { Effect, type PlatformError, Redacted, Schema } from "effect";
import { PATScopes } from "../../../src/core/tokens/contract";
import { decideOAuthCredentialExpirations } from "../../../src/core/oauth-agents/operations";
import type { OAuthCredentialExpirations } from "../../../src/core/oauth-agents/contract";
import { newId, newSecret, secretDigest } from "../../secret-material/operations";
import { oauthResponse } from "./response";

const secondMs = 1000;

export const invalidGrant = (): Response =>
  oauthResponse({ body: { error: "invalid_grant" }, status: 400 });

const GrantRow = Schema.Struct({
  expires_at_ms: Schema.Int,
  scopes_json: Schema.String,
  consumed_at_ms: Schema.OptionFromNullOr(Schema.Int),
});

type GrantRow = typeof GrantRow.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
  scope: Schema.String,
});

type Issuance = OAuthCredentialExpirations &
  Readonly<{
    accessDigest: Uint8Array;
    refreshDigest: Uint8Array;
    refreshId: string;
    scopesJson: string;
    body: typeof TokenResponse.Type;
  }>;

export const prepareIssuance = (
  input: Readonly<{ current: number; grant: GrantRow; scopes: PATScopes }>
): Effect.Effect<Issuance, Schema.SchemaError | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const access = yield* newSecret;
    const refresh = yield* newSecret;
    const accessDigest = yield* secretDigest({ purpose: "oauth-access", value: access });
    const refreshDigest = yield* secretDigest({ purpose: "oauth-refresh", value: refresh });

    const expirations = decideOAuthCredentialExpirations({
      current: input.current,
      grantExpiresAt: input.grant.expires_at_ms,
    });

    const body = yield* Schema.encodeEffect(TokenResponse)({
      access_token: Redacted.value(access),
      refresh_token: Redacted.value(refresh),
      token_type: "Bearer",
      expires_in: Math.floor((expirations.accessExpiresAt - input.current) / secondMs),
      scope: input.scopes.join(" "),
    });

    return {
      ...expirations,
      accessDigest,
      refreshDigest,
      refreshId: newId(),
      body,
      scopesJson: yield* Schema.encodeEffect(Schema.fromJsonString(PATScopes))(input.scopes),
    };
  });
