import { Cause, Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { type FidyClient, PriceId } from "@/transport/client";
import type { EnrollmentGateway } from "./enrollment-gateway";
import { subscriptionView } from "./foldkit-view";
import { Message, Model, initialModel } from "./model";
import { type PaymentController, makePaymentController } from "./payment-controller";
import { PaymentAction, PaymentField, PaymentMethod } from "./payment-model";
import { type SubscriptionCommands, makeSubscriptionUpdate } from "./workspace-update";

const makeCommands = (
  client: FidyClient,
  gateway: EnrollmentGateway,
  controller: PaymentController
): SubscriptionCommands => ({
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
      update: makeSubscriptionUpdate(commands),
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
