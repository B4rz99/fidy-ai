import { Schema } from "effect";
import { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";

export const maximumMcpRequestBytes = 16384;
const header = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maximumMcpRequestBytes)));
/** Bounded verifier facts and original protocol bytes for the existing User coordinator, never a grant. */
export const OAuthMcpAdmission = Schema.Struct({
  userId: OAuthCanonicalAdmission.fields.userId,
  connectionId: OAuthCanonicalAdmission.fields.connectionId,
  credentialId: OAuthCanonicalAdmission.fields.credentialId,
  clientId: OAuthCanonicalAdmission.fields.clientId,
  resource: OAuthCanonicalAdmission.fields.resource,
  digest: OAuthCanonicalAdmission.fields.digest,
  deadlineMilliseconds: OAuthCanonicalAdmission.fields.deadlineMilliseconds,
  method: Schema.Literals(["POST", "GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  headers: Schema.Struct({
    accept: header,
    "content-type": header,
    origin: header,
    "mcp-session-id": header,
    "mcp-protocol-version": header,
    "mcp-method": header,
    "mcp-name": header,
  }),
  body: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isMaxLength(maximumMcpRequestBytes)
  ),
});
export type OAuthMcpAdmission = typeof OAuthMcpAdmission.Type;
