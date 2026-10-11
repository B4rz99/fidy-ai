import { Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { PriceId, SubscriptionOffers, SubscriptionStatus } from "@/transport/client";
import { PaymentAction, PaymentMethod, PaymentView, initialPayment } from "./payment-model";

export const Model = Schema.Struct({
  offers: Schema.Option(SubscriptionOffers),
  standing: Schema.Option(SubscriptionStatus),
  offersBoundaryFailure: Schema.Boolean,
  offersStatus: Schema.Literals(["Loading", "Ready", "Failed"]),
  standingStatus: Schema.Literals(["Loading", "Ready", "Failed"]),
  enabledMethods: Schema.Array(PaymentMethod),
  selected: Schema.Option(PriceId),
  payment: PaymentView,
  endUserPolicy: Schema.Boolean,
  personalData: Schema.Boolean,
});
export type Model = typeof Model.Type;
export const initialModel: Model = {
  offers: Option.none(),
  standing: Option.none(),
  offersBoundaryFailure: false,
  offersStatus: "Loading",
  standingStatus: "Loading",
  enabledMethods: ["card", "nequi"],
  selected: Option.none(),
  payment: initialPayment,
  endUserPolicy: false,
  personalData: false,
};
export const Message = defineMessageUnion({
  LoadedOffers: { offers: SubscriptionOffers },
  FailedOffers: { boundary: Schema.Boolean },
  RefreshOffers: {},
  LoadedStanding: { standing: SubscriptionStatus },
  FailedStanding: {},
  RefreshStanding: {},
  LoadedMethods: { methods: Schema.Array(PaymentMethod) },
  SelectedPrice: { price: PriceId },
  SelectedMethod: { method: PaymentMethod },
  ChangedPayment: { payment: PaymentView },
  RequestedPayment: { action: PaymentAction },
  ToggledDecision: { decision: Schema.Literals(["endUserPolicy", "personalData"]) },
  Completed: {},
  Mounted: {},
});
export type Message = typeof Message.Type;
