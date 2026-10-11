import { Option, Schema } from "effect";

export const PaymentMethod = Schema.Literals(["card", "nequi", "daviplata"]);
export type PaymentMethod = typeof PaymentMethod.Type;
export const PaymentAction = Schema.Literals([
  "Submit",
  "Confirm",
  "Resend",
  "RetrySubmission",
  "Cancel",
  "Refresh",
  "Prepare",
]);
export type PaymentAction = typeof PaymentAction.Type;
export const PaymentStage = Schema.Literals([
  "Idle",
  "Preparing",
  "Fields",
  "Submitting",
  "AwaitingNequi",
  "SendingOtp",
  "Otp",
  "Confirming",
  "RetrySubmission",
  "RetryingSubmission",
  "Uncertain",
  "Refused",
  "Available",
  "Expired",
  "Creating",
  "Verifying",
  "SourceVerifying",
  "PaymentPending",
  "PaymentSucceeded",
  "PaymentFailed",
]);
export type PaymentStage = typeof PaymentStage.Type;
export const PaymentView = Schema.Struct({
  stage: PaymentStage,
  method: PaymentMethod,
  reuse: Schema.Boolean,
  busy: Schema.Boolean,
  locked: Schema.Boolean,
  generation: Schema.Int,
  failed: Schema.Boolean,
  contracts: Schema.Option(
    Schema.Struct({ endUserPolicy: Schema.String, personalData: Schema.String })
  ),
});
export type PaymentView = typeof PaymentView.Type;
export const initialPayment: PaymentView = {
  stage: "Idle",
  method: "card",
  reuse: false,
  busy: false,
  locked: false,
  generation: 0,
  failed: false,
  contracts: Option.none(),
};
export const PaymentField = Schema.Literals([
  "email",
  "number",
  "expiration",
  "cvc",
  "name",
  "nequi",
  "document",
  "product",
  "otp",
]);
export type PaymentField = typeof PaymentField.Type;
