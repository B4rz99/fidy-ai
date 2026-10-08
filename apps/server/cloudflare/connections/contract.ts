import { Data, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import { ConnectionAttemptReference } from "../../src/shell/connections/contract";

const digestLength = 32;
const maximumByte = 255;
/** Private browser admission; never sufficient without the coordinator's live credential recheck. */
export const ConnectionBrowserAdmission = Schema.Struct({
  attempt: ConnectionAttemptReference,
  userId: UserId,
  sessionId: WebSessionId,
  digest: Schema.Array(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumByte }))
  ).check(Schema.isBetweenLength(digestLength, digestLength)),
  deadlineMilliseconds: Schema.Int,
});
export type ConnectionBrowserAdmission = typeof ConnectionBrowserAdmission.Type;
/** The canonical product reads owned by Connections. */
export type ConnectionQueryOperation =
  | "connections.listInstitutions"
  | "connections.listConnections"
  | "connections.getConnection";

/** Connection continuation cleanup could not complete; no private storage detail is exposed. */
export class ConnectionRetentionUnavailable extends Data.TaggedError(
  "ConnectionRetentionUnavailable"
) {}
