import { Option } from "effect";
import type { Command, Update } from "foldkit";
import type { PriceId } from "@/transport/client";
import { Message, type Model } from "./model";
import type { PaymentAction, PaymentMethod } from "./payment-model";

export type SubscriptionCommands = Readonly<{
  Offers: () => Command.Command<Message>;
  Standing: () => Command.Command<Message>;
  Methods: () => Command.Command<Message>;
  Select: (args: Readonly<{ price: PriceId; method: PaymentMethod }>) => Command.Command<Message>;
  Work: (args: Readonly<{ action: PaymentAction }>) => Command.Command<Message>;
}>;
const selectionAllowed = (model: Model): boolean =>
  !model.payment.busy && !model.payment.locked && model.offersStatus === "Ready";
const choose = (
  configuration: Readonly<{
    model: Model;
    price: PriceId;
    method: PaymentMethod;
    commands: SubscriptionCommands;
  }>
): Update.Return<Model, Message> => {
  const { model, price, method, commands } = configuration;
  if (!selectionAllowed(model)) return { model };
  return {
    model: {
      ...model,
      selected: Option.some(price),
      endUserPolicy: false,
      personalData: false,
      payment: { ...model.payment, busy: true, method },
    },
    commands: [commands.Select({ price, method })],
  };
};
export const makeSubscriptionUpdate =
  (
    commands: SubscriptionCommands
  ): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      LoadedOffers: ({ offers }) => ({
        model: { ...model, offers: Option.some(offers), offersStatus: "Ready" },
      }),
      FailedOffers: ({ boundary }) => ({
        model: { ...model, offersStatus: "Failed", offersBoundaryFailure: boundary },
      }),
      RefreshOffers: () =>
        model.offersStatus === "Loading"
          ? { model }
          : { model: { ...model, offersStatus: "Loading" }, commands: [commands.Offers()] },
      LoadedStanding: ({ standing }) => ({
        model: { ...model, standing: Option.some(standing), standingStatus: "Ready" },
      }),
      FailedStanding: () => ({ model: { ...model, standingStatus: "Failed" } }),
      RefreshStanding: () =>
        model.standingStatus === "Loading"
          ? { model }
          : { model: { ...model, standingStatus: "Loading" }, commands: [commands.Standing()] },
      LoadedMethods: ({ methods }) => ({ model: { ...model, enabledMethods: methods } }),
      SelectedPrice: ({ price }) =>
        choose({ model, price, method: model.payment.method, commands }),
      SelectedMethod: ({ method }) => {
        if (
          !selectionAllowed(model) ||
          method === model.payment.method ||
          !model.enabledMethods.includes(method)
        ) {
          return { model };
        }
        return Option.isNone(model.selected)
          ? { model: { ...model, payment: { ...model.payment, method } } }
          : choose({ model, price: model.selected.value, method, commands });
      },
      ChangedPayment: ({ payment }) => ({
        model: {
          ...model,
          payment,
          endUserPolicy: payment.generation === model.payment.generation && model.endUserPolicy,
          personalData: payment.generation === model.payment.generation && model.personalData,
        },
      }),
      RequestedPayment: ({ action }) => {
        if (action === "Submit" && (!model.endUserPolicy || !model.personalData)) return { model };
        if (action !== "Cancel" && model.payment.busy) return { model };
        return { model, commands: [commands.Work({ action })] };
      },
      ToggledDecision: ({ decision }) => ({
        model: model.payment.busy ? model : { ...model, [decision]: !model[decision] },
      }),
      Completed: () => ({ model }),
      Mounted: () => ({ model }),
    });
