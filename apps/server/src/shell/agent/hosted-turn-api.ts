import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { TranscriptText, TranscriptTurnId } from "~/core/transcript/model";

/** The browser-only, cookie-authenticated hosted Turn channel is not a canonical tool operation. */
export const HostedTurnRequest = Schema.Struct({ text: TranscriptText });
export const HostedTurnReceipt = Schema.Struct({
  turnId: TranscriptTurnId,
  receipt: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export const HostedTurnProposal = Schema.Struct({
  text: TranscriptText,
  turnId: TranscriptTurnId,
  receipt: HostedTurnReceipt.fields.receipt,
}).annotate({ httpApiStatus: 202 });
export const HostedTurnCompleted = Schema.Struct({ status: Schema.Literal("completed") });
const Unauthenticated = Schema.Struct({ status: Schema.Literal("unauthenticated") }).annotate({
  httpApiStatus: 401,
});
const ConsentRequired = Schema.Struct({ status: Schema.Literal("user_action_required") }).annotate({
  httpApiStatus: 403,
});
const Invalid = Schema.Struct({ status: Schema.Literal("validation_failed") }).annotate({
  httpApiStatus: 400,
});
const Unavailable = Schema.Struct({
  status: Schema.Literals(["unavailable", "interrupted"]),
}).annotate({ httpApiStatus: 503 });
const AwaitingDelivery = Schema.Struct({ status: Schema.Literal("awaiting_delivery") }).annotate({
  httpApiStatus: 409,
});
const CapacityExceeded = Schema.Struct({ status: Schema.Literal("capacity_exceeded") }).annotate({
  httpApiStatus: 429,
});
const HostedTurnGroup = HttpApiGroup.make("hostedTurn")
  .add(
    HttpApiEndpoint.post("propose", "/web/hosted-turns", {
      payload: HostedTurnRequest,
      success: HostedTurnProposal,
      error: [
        Unauthenticated,
        ConsentRequired,
        Invalid,
        Unavailable,
        AwaitingDelivery,
        CapacityExceeded,
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("acknowledge", "/web/hosted-turns/delivery", {
      payload: HostedTurnReceipt,
      success: HostedTurnCompleted,
      error: [Unauthenticated, ConsentRequired, Invalid, Unavailable],
    })
  );
export const HostedTurnApi = HttpApi.make("hostedTurnChannel").add(HostedTurnGroup);
export type HostedTurnApiGroups =
  typeof HostedTurnApi extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;
