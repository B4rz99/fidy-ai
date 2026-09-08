import { Schema } from "effect";
import type { UserId } from "~/core/identity/reference";
import { ProviderQualifiedMessages } from "~/core/consent/model";
import { TranscriptText } from "~/core/transcript/model";

/** Channel-neutral text and optional provider evidence accepted by the hosted agent. */
export const InboundMessage = Schema.Struct({
  text: TranscriptText,
  confirmationEvidence: Schema.optionalKey(ProviderQualifiedMessages),
});
export type InboundMessage = typeof InboundMessage.Type;

/** Validated input bound to the stable User resolved by onboarding. */
export type AuthorizedAgentTurn = Readonly<{
  _tag: "AuthorizedTurn";
  userId: UserId;
  inboundMessage: InboundMessage;
}>;

/** One channel-neutral media reference that an adapter may render or deliver. */
export const AgentAttachment = Schema.Struct({
  mediaType: Schema.NonEmptyString,
  url: Schema.URLFromString,
});
/** One channel-neutral follow-up action that an adapter may present to the User. */
export const AgentChoice = Schema.Struct({ label: Schema.NonEmptyString, message: TranscriptText });
/** Semantic response returned to whichever channel initiated the turn. */
export const AgentReply = Schema.Struct({
  text: TranscriptText,
  attachments: Schema.OptionFromOptionalKey(Schema.NonEmptyArray(AgentAttachment)),
  choices: Schema.OptionFromOptionalKey(Schema.NonEmptyArray(AgentChoice)),
});
export type AgentReply = typeof AgentReply.Type;
