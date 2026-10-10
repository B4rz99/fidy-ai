import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const Intent = Schema.Literals(["signup", "login"]);
export const ProviderViewState = Schema.Union([
  Schema.Struct({
    status: Schema.Literals([
      "editing",
      "waiting",
      "recovery",
      "uncertain",
      "refused",
      "cancelled",
      "cancelling",
    ]),
  }),
  Schema.Struct({ status: Schema.Literal("confirming"), code: Schema.String }),
]);
export type ProviderViewState = typeof ProviderViewState.Type;

const Disclosure = Schema.TaggedUnion({
  Loading: {},
  Failed: {},
  Ready: { revision: Schema.String, text: Schema.String, policyUrl: Schema.String },
});

/** Only public presentation enters the model; proof and recovery remain in the mounted controller. */
export const Model = Schema.Struct({
  intent: Intent,
  accepted: Schema.Boolean,
  disclosure: Disclosure,
  state: ProviderViewState,
  attempt: Schema.Finite,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  ToggledIntent: {},
  ToggledConsent: {},
  ClickedContinue: {},
  ClickedRetry: {},
  ClickedCancel: {},
  ClickedAcknowledge: {},
  ClickedRestart: {},
  ClickedReloadDisclosure: {},
  LoadedDisclosure: { disclosure: Disclosure },
  ChangedAttempt: { attempt: Schema.Finite, state: ProviderViewState },
  CompletedCancellation: { state: ProviderViewState },
  CompletedWork: {},
});
export type Message = typeof Message.Type;

/** Signup needs the displayed disclosure's acceptance unless originating-chat Consent owns it. */
export const canContinue = ({
  model,
  handoff,
}: Readonly<{ model: Model; handoff: boolean }>): boolean =>
  handoff || model.intent === "login" || (model.accepted && model.disclosure._tag === "Ready");
