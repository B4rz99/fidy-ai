import { EmailForwardingLocalPart } from "../../src/core/ingestion/contract";
import { PATId } from "../../src/core/tokens/contract";
import { Data, Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { WebSessionId } from "../../src/core/web-session/contract";

export const directoryName = "directory-v1";
export const sessionRouteUrl = "https://directory.invalid/session-route";
export const SessionRoute = Schema.Struct({ userId: UserId, sessionId: WebSessionId });

export type UserStoreBindings = Readonly<{
  DIRECTORY: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  USER_STORE: Readonly<{ getByName: (id: string) => Pick<Fetcher, "fetch"> }>;
}>;

export const patRouteUrl = "https://directory.invalid/pat-route";
export const sourcePressureUrl = "https://directory.invalid/unresolved-source";
export const patRouteHeader = "fidy-internal-pat-reference";
export const PATRoute = Schema.Struct({ userId: UserId, patId: PATId });

export const FrozenBrowserHandoff = Schema.Struct({
  user_id: UserId,
  id: Schema.String,
  pairing_id: Schema.String,
  ordinal: Schema.Int,
  verifier_digest: Schema.String,
  expires_at_ms: Schema.Int,
  pairing_expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  minimum_poll_seconds: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  issuer: Schema.String,
  subject: Schema.String,
  contact_email: Schema.NullOr(Schema.String),
  creation_attempt: Schema.String,
  established: Schema.Int,
  disclosure: Schema.NullOr(Schema.String),
  invitation: Schema.NullOr(Schema.String),
  portfolio: Schema.NullOr(Schema.String),
  bsuid: Schema.NullOr(Schema.String),
  endpoint: Schema.NullOr(Schema.String),
  review_code: Schema.NullOr(Schema.String),
  review_attempt: Schema.NullOr(Schema.String),
  review_text: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.String),
  decision_message: Schema.NullOr(Schema.String),
  confirmed_ms: Schema.NullOr(Schema.Int),
  invitation_expiry: Schema.NullOr(Schema.Int),
  accepted_at_ms: Schema.NullOr(Schema.Int),
  intent: Schema.Literals(["signup", "login"]),
});
export const handoffInspectUrl = "https://directory.invalid/bootstrap/inspect";
export const handoffCancelUrl = "https://directory.invalid/bootstrap/cancel";
export const bootstrapCompleteUrl = "https://user.invalid/bootstrap/complete";
export const bootstrapCancelUrl = "https://user.invalid/bootstrap/cancel";
export const registerSessionUrl = "https://directory.invalid/bootstrap/session";

export const whatsappBootstrapUrl = "https://directory.invalid/bootstrap/whatsapp";
export const WhatsAppBootstrapText = Schema.Struct({
  portfolio: Schema.String,
  bsuid: Schema.String,
  endpoint: Schema.String,
  message: Schema.String,
  phone: Schema.NullOr(Schema.String),
  text: Schema.String,
  occurredAt: Schema.Int,
  receivedAt: Schema.Int,
});

export const channelInspectUrl = "https://directory.invalid/bootstrap/channel";
export const localChannelApprovalUrl = "https://user.invalid/browser/channel-approval";
export const localCallerUrl = "https://user.invalid/browser/channel-caller";
export const FrozenChannelApproval = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  pairing_id: Schema.String,
  ordinal: Schema.Int,
  verifier_digest: Schema.String,
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
  portfolio: Schema.String,
  bsuid: Schema.String,
  endpoint: Schema.String,
  message: Schema.String,
  occurred_ms: Schema.Int,
  received_ms: Schema.Int,
});

export const reserveRecoveryUrl = "https://directory.invalid/bootstrap/recovery";

export class DirectoryWriteUnavailable extends Data.TaggedError("DirectoryWriteUnavailable") {}

const maximumCallbackIdentifierLength = 200;
const callbackIdentifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumCallbackIdentifierLength)
);
const forwardingKey = Schema.Struct({
  kind: Schema.Literal("forwarding"),
  endpoint: Schema.Literal("fidyapp.com"),
  lookup: EmailForwardingLocalPart,
});
const wompiKey = Schema.Struct({
  kind: Schema.Literal("wompi"),
  endpoint: Schema.Literals(["sandbox", "production"]),
  lookup: Schema.String.check(Schema.isPattern(/^fidy-[a-f0-9-]{36}$/u)),
});
const whatsappKey = Schema.Struct({
  kind: Schema.Literal("whatsapp"),
  endpoint: callbackIdentifier,
  lookup: Schema.String.check(Schema.isUUID()),
});
export const ExternalEventKey = Schema.Union([forwardingKey, wompiKey, whatsappKey]);
const destination = { userId: UserId, operationId: callbackIdentifier };
export const ExternalEventRoute = Schema.Union([
  Schema.Struct({ ...forwardingKey.fields, ...destination, family: Schema.Literal("forwarding") }),
  Schema.Struct({ ...wompiKey.fields, ...destination, family: Schema.Literal("billing") }),
  Schema.Struct({
    ...whatsappKey.fields,
    ...destination,
    family: Schema.Literals(["hosted", "proactivity", "insight", "weekly-question", "disclosure"]),
  }),
]);
export const externalReserveUrl = "https://directory.invalid/external/reserve";
export const externalLookupUrl = "https://directory.invalid/external/lookup";

export type ExternalEventNamespace = Readonly<{
  getByName: (id: string) => Pick<Fetcher, "fetch">;
}>;
export type ExternalEventBindings = Readonly<{
  DIRECTORY: ExternalEventNamespace;
  USER_STORE: ExternalEventNamespace;
}>;

export const statusLookupAdmissionUrl = "https://directory.invalid/external/kapso-lookup";
export const StatusLookupCoordinates = Schema.Struct({
  endpoint: callbackIdentifier,
  messageId: callbackIdentifier,
  status: Schema.Literals(["sent", "delivered", "failed"]),
});
