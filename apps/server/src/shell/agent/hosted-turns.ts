import { type Effect, Schema } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc, type RpcGroup } from "effect/unstable/rpc";
import { UserId } from "~/core/identity/reference";
import { TranscriptTurnId } from "~/core/transcript/model";
import type { CanonicalAuthorityRoot } from "~/shell/_shared/operation-policy";
import { WhatsAppInboundWork } from "~/shell/channels/whatsapp/inbound-execution";
import { AgentReply, InboundMessage } from "./message";

/** Resource and context bounds applied independently to every hosted turn. */
export const AgentLimits = Schema.Struct({
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxToolCallsPerTurn: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxToolResultCharacters: Schema.Int.check(
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  maxModelRoundMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
});
export type AgentLimits = typeof AgentLimits.Type;

/** Closed safe failure vocabulary returned to a hosted client for one Turn. */
export const TurnFailure = Schema.Literals([
  "UnknownUser",
  "OnboardingConsentRequired",
  "HostedCapacityExceeded",
  "ModelUnavailable",
  "ModelResponseRejected",
  "HostedTurnAlreadyHandled",
  "HostedTurnUnavailable",
  "delivery_failed",
]);
export type TurnFailure = typeof TurnFailure.Type;

/**
 * The hosted agent's internal Cluster entity, owned here so production handlers, generated clients,
 * and tests all derive from one definition. This is not a service boundary: other shell modules
 * still reach the hosted agent through `AgentService`, which also hosts these operations and is
 * their only production sender; the definition is exported so the wire-contract tests and retention
 * address the same entity by name.
 */
export const HostedTurns = Entity.make("HostedTurns", [
  Rpc.make("Handle", {
    payload: {
      userId: UserId,
      turnId: TranscriptTurnId,
      message: InboundMessage,
      limits: AgentLimits,
      authorityRoot: Schema.Literals([
        "no-verified-whatsapp-authority",
        "verified-whatsapp",
      ] satisfies ReadonlyArray<CanonicalAuthorityRoot>),
    },
    success: AgentReply,
    error: TurnFailure,
  }).annotate(ClusterSchema.Uninterruptible, "client"),
  Rpc.make("ProcessWhatsApp", {
    payload: WhatsAppInboundWork.fields,
    primaryKey: ({ inboundJobId }) => inboundJobId,
  })
    .annotate(ClusterSchema.Persisted, true)
    .annotate(ClusterSchema.Uninterruptible, "client"),
  Rpc.make("Recover", {
    payload: { userId: UserId, turnId: TranscriptTurnId },
    primaryKey: ({ turnId }) => turnId,
  })
    .annotate(ClusterSchema.Persisted, true)
    .annotate(ClusterSchema.Uninterruptible, "client"),
]);

/** Entity-scoped client for every `HostedTurns` operation; an interrupted client cannot cancel an operation marked client-uninterruptible. */
export type HostedTurnsClient = Effect.Success<typeof HostedTurns.client>;

/** Union of the entity's request definitions, used to derive one payload type per operation. */
export type HostedTurnRpc = RpcGroup.Rpcs<typeof HostedTurns.protocol>;

/** Payload accepted by the immediate `Handle` operation. */
export type ImmediateTurnPayload = Rpc.Payload<Rpc.ExtractTag<HostedTurnRpc, "Handle">>;

/** Payload accepted by the durable `ProcessWhatsApp` operation. */
export type WhatsAppTurnPayload = Rpc.Payload<Rpc.ExtractTag<HostedTurnRpc, "ProcessWhatsApp">>;

/** Payload accepted by the durable `Recover` operation. */
export type RecoveryPayload = Rpc.Payload<Rpc.ExtractTag<HostedTurnRpc, "Recover">>;
