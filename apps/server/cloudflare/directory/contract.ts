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

export const releaseSessionUrl = "https://directory.invalid/bootstrap/session/release";

export const registerSessionUrl = "https://directory.invalid/bootstrap/session";

export const whatsappBootstrapUrl = "https://directory.invalid/bootstrap/whatsapp";

export const rejectInvitationSendUrl = "https://directory.invalid/bootstrap/whatsapp/rejected";

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

export const rotateRecoveryRouteUrl = "https://directory.invalid/recovery/rotation";

const recoveryDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const RecoveryRotation = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: UserId,
  prior_digest: recoveryDigest,
  next_digest: recoveryDigest,
  revision: Schema.Int,
  expires_at_ms: Schema.Int,
});

export const RecoveryRouteDecision = Schema.Struct({
  ...RecoveryRotation.fields,
  decision: Schema.Literals(["reserve", "committed", "cancelled"]),
});

export const supportAdmissionUrl = "https://directory.invalid/recovery/operator";

export const supportApprovalUrl = "https://directory.invalid/recovery/approval";

export const localSupportUrl = "https://user.invalid/recovery/approval";

export const SupportOperator = Schema.Struct({
  issuer: Schema.String,
  subject: Schema.String,
  issuedAtMs: Schema.Int,
  expiresAtMs: Schema.Int,
});

export const SupportApproval = Schema.Struct({
  operator: SupportOperator,
  publicCode: Schema.String,
  digest: recoveryDigest,
});

export const FrozenRecovery = Schema.Struct({
  id: Schema.String,
  user_id: UserId,
  pairing_id: Schema.String,
  ordinal: Schema.Int,
  verifier_digest: Schema.String,
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
  credential_digest: recoveryDigest,
  revision: Schema.Int,
  operator_issuer: Schema.String,
  operator_subject: Schema.String,
  operator_issued_ms: Schema.Int,
  operator_expires_ms: Schema.Int,
});

export const replaceIdentityUrl = "https://directory.invalid/identity/replace";

export const localIdentityCommitUrl = "https://user.invalid/identity/commit";

export const localIdentityCancelUrl = "https://user.invalid/identity/cancel";

export const emailRouteUrl = "https://directory.invalid/email/route";

export const ReplacementInput = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["email", "whatsapp"]),
  scope: Schema.String,
  prior_key: Schema.String,
  next_key: Schema.String,
  occurred_at_ms: Schema.Int,
  expires_at_ms: Schema.Int,
  expected_user: Schema.NullOr(UserId),
});

export const ReservedIdentity = Schema.Struct({
  ...ReplacementInput.fields,
  user_id: UserId,
  revision: Schema.Int,
  prior_reservation: Schema.String,
});

export const IdentityOutcome = Schema.Literals(["committed", "cancelled"]);

export const localRecoveryCheckUrl = "https://user.invalid/recovery/check";

export const RecoveryCandidate = Schema.Struct({
  user_id: UserId,
  digest: recoveryDigest,
  revision: Schema.Int,
});

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

export const whatsappOwnerUrl = "https://directory.invalid/whatsapp/owner";

export const emailCapacityUrl = "https://directory.invalid/forwarded-email/capacity";

export const mediaCapacityUrl = "https://directory.invalid/ingestion/media-capacity";

export const retainedMediaLimit = 2_500;

export type IngestionCapacity = "email" | "media";

export const retainedEmailLimit = 10_000;

export const outstandingEmailLimit = 1_000;

export const EmailCapacitySlot = Schema.Struct({
  slot: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: retainedEmailLimit })),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const EmailCapacityTarget = Schema.Struct({
  ...EmailCapacitySlot.fields,
  receipt: Schema.String.check(Schema.isUUID()),
  expires: Schema.Int,
});

export const EmailCapacityTargetCommand = Schema.Union([
  Schema.TaggedStruct("Claim", EmailCapacityTarget.fields),
  Schema.TaggedStruct("Settle", EmailCapacityTarget.fields),
  Schema.TaggedStruct("Release", EmailCapacityTarget.fields),
]);

export const EmailCapacityCommand = Schema.Union([
  Schema.TaggedStruct("Offer", {}),
  ...EmailCapacityTargetCommand.members,
]);

const routeReservationTransportMs = 60_000;

export const routeIssuedHeader = "fidy-route-issued-ms";

export const currentRouteReservation = ({
  request,
  now,
}: Readonly<{ request: Request; now: number }>): boolean => {
  const issued = Number(request.headers.get(routeIssuedHeader));

  return (
    Number.isSafeInteger(issued) &&
    issued > 0 &&
    issued <= now &&
    now - issued < routeReservationTransportMs
  );
};
