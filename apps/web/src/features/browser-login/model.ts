import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const PairingState = Schema.TaggedUnion({
  Idle: {},
  Starting: {},
  AwaitingApproval: {
    publicCode: Schema.String,
    emailStep: Schema.Literals(["ready", "sending", "code", "submitting", "rejected"]),
  },
  Authenticated: {},
  Invalid: {},
});
export type PairingState = typeof PairingState.Type;
export const Model = Schema.Struct({ state: PairingState });
export type Model = typeof Model.Type;
export const EmailAction = Schema.Literals(["Request", "Complete", "Resend"]);
export type EmailAction = typeof EmailAction.Type;
export const Message = defineMessageUnion({
  ChangedState: { state: PairingState },
  ClickedStart: {},
  ClickedRestart: {},
  ClickedLogout: {},
  RequestedEmail: { action: EmailAction },
  CompletedMount: {},
  CompletedWork: {},
});
export type Message = typeof Message.Type;
