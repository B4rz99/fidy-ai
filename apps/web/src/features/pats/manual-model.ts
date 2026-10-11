import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import {
  ManualPATGrantInput,
  ManualPATRequestId,
  PATLifetimeDays,
  PATScope,
  defaultPATLifetimeDays,
} from "@/transport/client";

export const GrantDraft = Schema.Struct({
  recipientLabel: ManualPATGrantInput.fields.recipientLabel,
  scopes: ManualPATGrantInput.fields.scopes,
  lifetimeDays: ManualPATGrantInput.fields.lifetimeDays,
});
export type GrantDraft = typeof GrantDraft.Type;
export const ReviewedGrant = Schema.Struct({
  grant: ManualPATGrantInput,
  requestId: ManualPATRequestId,
  reviewExpiresAt: Schema.DateTimeUtc,
});
export type ReviewedGrant = typeof ReviewedGrant.Type;
export const ManualModel = Schema.Struct({
  status: Schema.Literals(["Editing", "Reviewing", "Issuing", "Failed", "Issued"]),
  recipientLabel: Schema.String,
  scopes: Schema.Array(PATScope),
  lifetimeDays: PATLifetimeDays,
  review: Schema.Option(ReviewedGrant),
  copied: Schema.Boolean,
});
export type ManualModel = typeof ManualModel.Type;
export const ManualMessage = defineMessageUnion({
  EditedLabel: { value: Schema.String },
  ToggledScope: { scope: PATScope },
  ChoseDays: { value: Schema.String },
  RequestedReview: {},
  Reviewed: { review: ReviewedGrant },
  RequestedIssue: {},
  Issued: {},
  Failed: {},
  Edit: {},
  RetryReview: {},
  Reset: {},
  Copied: {},
  Mounted: {},
});
export type ManualMessage = typeof ManualMessage.Type;
export const defaultDays = defaultPATLifetimeDays;
