import type { OAuthRecentActivity } from "../../../src/core/audit/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { oauthScopeCopy } from "../../../src/core/oauth-agents/operations";
import {
  OAuthConnectionMetadata,
  OAuthRegistration,
} from "../../../src/shell/oauth-agents/contract";
import { type AuditUnavailable } from "../../../src/shell/audit/contract";

export const ConnectionRow = Schema.Struct({
  id: OAuthConnectionId,
  claimed_client_name: OAuthRegistration.fields.client_name,
  scopes_json: Schema.String,
  expires_at_ms: Schema.DateTimeUtcFromMillis,
  revoked_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
});

const permissionCopy = (
  scope: PATScopes[number]
): OAuthConnectionMetadata["permissions"][number] => ({
  scope,
  ...oauthScopeCopy[scope],
});

const connectionState = (
  row: typeof ConnectionRow.Type,
  current: number
): "revoked" | "expired" | "active" => {
  if (Option.isSome(row.revoked_at_ms)) return "revoked";

  return DateTime.toEpochMillis(row.expires_at_ms) <= current ? "expired" : "active";
};

export const projectConnection = ({
  current,
  row,
  recentActivity,
}: {
  current: number;
  row: typeof ConnectionRow.Type;
  recentActivity: OAuthRecentActivity;
}): Effect.Effect<OAuthConnectionMetadata, AuditUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(row.scopes_json);

    return yield* Schema.decodeUnknownEffect(Schema.toType(OAuthConnectionMetadata))({
      connectionId: row.id,
      claimedClientName: row.claimed_client_name,
      scopes,
      permissions: scopes.map(permissionCopy),
      expiresAt: row.expires_at_ms,
      state: connectionState(row, current),
      recentActivity,
    });
  });
