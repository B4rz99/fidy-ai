import { DateTime, Duration, Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { OAuthReview, OAuthReviewChoice, PATLifetimeDays, PATScope } from "@/transport/client";

export const Model = Schema.Struct({
  review: Schema.Option(OAuthReview),
  scopes: Schema.Array(PATScope),
  days: PATLifetimeDays,
  status: Schema.Literals([
    "Loading",
    "Ready",
    "Unavailable",
    "Connecting",
    "Uncertain",
    "Cancelling",
    "CancelFailed",
    "Cancelled",
  ]),
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  Loaded: { review: OAuthReview },
  Failed: {},
  ToggledScope: { scope: PATScope },
  SelectedDays: { days: PATLifetimeDays },
  ClickedConnect: {},
  ClickedCancel: {},
  Cancelled: {},
  CancelFailed: {},
  Uncertain: {},
  Redirected: {},
});
export type Message = typeof Message.Type;
export const editable = (model: Model): boolean =>
  model.status === "Ready" || model.status === "CancelFailed";
export const selectedChoice = (model: Model): Option.Option<OAuthReviewChoice> =>
  Option.flatMap(model.review, (review) =>
    Schema.decodeOption(Schema.toType(OAuthReviewChoice))({
      requestId: review.requestId,
      scopes: model.scopes,
      lifetimeDays: model.days,
      reviewedAt: review.reviewedAt,
      expiresAt: DateTime.addDuration(review.reviewedAt, Duration.days(model.days)),
    })
  );
