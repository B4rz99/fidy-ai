import { Cause, Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { type FidyClient, PriceId } from "@/transport/client";
import type { EnrollmentGateway } from "./enrollment-gateway";
import { subscriptionView } from "./foldkit-view";
import { Message, Model, initialModel } from "./model";
import { type PaymentController, makePaymentController } from "./payment-controller";
import { PaymentAction, PaymentField, PaymentMethod } from "./payment-model";

type Commands = Readonly<{
  Offers: () => Command.Command<Message>;
  Standing: () => Command.Command<Message>;
  Methods: () => Command.Command<Message>;
  Select: (args: Readonly<{ price: PriceId; method: PaymentMethod }>) => Command.Command<Message>;
  Work: (args: Readonly<{ action: PaymentAction }>) => Command.Command<Message>;
}>;
const makeCommands = (
  client: FidyClient,
  gateway: EnrollmentGateway,
  controller: PaymentController
): Commands => ({
  Offers: Command.define("SubscriptionOffers", {
    messages: [Message.LoadedOffers, Message.FailedOffers],
    execute: client.pipe(
      Effect.flatMap((api) => api.subscription.listSubscriptionOffers({})),
      Effect.map(({ data }) => Message.LoadedOffers({ offers: data })),
      Effect.catchCause((cause) =>
        Effect.succeed(
          Message.FailedOffers({
            boundary:
              Cause.hasDies(cause) ||
              Option.exists(
                Cause.findErrorOption(cause),
                (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error)
              ),
          })
        )
      )
    ),
  }),
  Standing: Command.define("SubscriptionStanding", {
    messages: [Message.LoadedStanding, Message.FailedStanding],
    execute: client.pipe(
      Effect.flatMap((api) => api.subscription.getSubscriptionStatus({})),
      Effect.map(({ data }) => Message.LoadedStanding({ standing: data })),
      Effect.catchCause(() => Effect.succeed(Message.FailedStanding()))
    ),
  }),
  Methods: Command.define("EnrollmentMethods", {
    messages: [Message.LoadedMethods],
    execute: Effect.tryPromise((signal) => gateway.availability(signal)).pipe(
      Effect.map((availability) => Message.LoadedMethods({ methods: availability.enabledMethods })),
      Effect.catchCause(() => Effect.succeed(Message.LoadedMethods({ methods: ["card", "nequi"] })))
    ),
  }),
  Select: Command.define("PreparePayment", {
    args: { price: PriceId, method: PaymentMethod },
    messages: [Message.Completed],
    interrupt: true,
    execute: (selection) => controller.select(selection).pipe(Effect.as(Message.Completed())),
  }),
  Work: Command.define("PaymentAction", {
    args: { action: PaymentAction },
    messages: [Message.Completed],
    execute: ({ action }) => controller.execute(action).pipe(Effect.as(Message.Completed())),
  }),
});
const selectionAllowed = (model: Model): boolean =>
  !model.payment.busy && !model.payment.locked && model.offersStatus === "Ready";
const choose = (
  configuration: Readonly<{
    model: Model;
    price: PriceId;
    method: PaymentMethod;
    commands: Commands;
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
const makeUpdate =
  (commands: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
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
const normalizedInput = (field: PaymentField, value: string): string => {
  if (field === "email") return value;
  if (field === "name") return value.replace(/[^\p{L} ]/gu, "");
  const digits = value.replace(/\D/gu, "");
  if (field !== "expiration") return digits;
  const expirationDigits = 6;
  const monthDigits = 2;
  const bounded = digits.slice(0, expirationDigits);
  return bounded.length > monthDigits
    ? `${bounded.slice(0, monthDigits)}/${bounded.slice(monthDigits)}`
    : bounded;
};
const makeInputMount = (
  controller: PaymentController
): ((args: Readonly<{ field: PaymentField }>) => Mount.MountAction<Message>) =>
  Mount.define("PrivatePaymentInput", {
    args: { field: PaymentField },
    messages: [Message.Mounted],
    execute: ({ element, field }) => {
      if (!(element instanceof HTMLInputElement)) return Effect.succeed(Message.Mounted());
      return Effect.acquireRelease(
        Effect.sync(() => {
          const normalize = (): void => {
            element.value = normalizedInput(field, element.value);
          };
          element.addEventListener("input", normalize, true);
          const release = controller.inputs.bind(field, element);
          return (): void => {
            element.removeEventListener("input", normalize, true);
            release();
          };
        }),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.Mounted()));
    },
  });
/** Owns canonical subscription queries and a private, interruptible payment workflow. */
export const mountSubscription = (
  configuration: Readonly<{
    container: HTMLElement;
    client: FidyClient;
    resources: Layer.Layer<never>;
    gateway: EnrollmentGateway;
  }>
): (() => void) => {
  const { container, client, resources, gateway } = configuration;
  const events = Effect.runSync(Queue.unbounded<Message>());
  const controller = makePaymentController({
    gateway,
    changed: (payment) => {
      Queue.offerUnsafe(events, Message.ChangedPayment({ payment }));
    },
  });
  const commands = makeCommands(client, gateway, controller);
  const mount = makeInputMount(controller);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: initialModel,
        commands: [commands.Offers(), commands.Standing(), commands.Methods()],
      }),
      update: makeUpdate(commands),
      view: (model, html) => subscriptionView({ model, html, mount }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        payments: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: controller.dispose,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            [
              "No pudimos continuar. Recarga la página y consulta el estado antes de repetir un pago.",
            ]
          ),
      },
    })
  );
  return () => {
    controller.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
