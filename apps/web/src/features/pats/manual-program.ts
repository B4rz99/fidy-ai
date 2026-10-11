import { DateTime, Duration, Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { Command, Runtime, Subscription, type Update } from "foldkit";
import { browserCrypto } from "@/browser/crypto";
import { type FidyClient, ManualPATRequestId, patLifetimeDayOptions } from "@/transport/client";
import { makeManualDisclosure } from "./manual-disclosure";
import { manualView } from "./manual-foldkit-view";
import {
  GrantDraft,
  ManualMessage as Message,
  ManualModel as Model,
  ReviewedGrant,
  defaultDays,
} from "./manual-model";

const initial: Model = {
  status: "Editing",
  recipientLabel: "",
  scopes: [],
  lifetimeDays: defaultDays,
  review: Option.none(),
  copied: false,
};
type Commands = Readonly<{
  Review: (args: Readonly<{ grant: GrantDraft }>) => Command.Command<Message>;
  Issue: (args: ReviewedGrant) => Command.Command<Message>;
  Clear: () => Command.Command<Message>;
}>;
const makeCommands = (
  client: FidyClient,
  disclosure: ReturnType<typeof makeManualDisclosure>,
  issued: () => void
): Commands => ({
  Review: Command.define("ReviewManualPAT", {
    args: { grant: GrantDraft },
    messages: [Message.Reviewed],
    execute: ({ grant }) =>
      Effect.gen(function* () {
        const requestId = ManualPATRequestId.make(
          yield* browserCrypto.randomUUIDv4.pipe(Effect.orDie)
        );
        const now = yield* DateTime.now;
        return Message.Reviewed({
          review: {
            grant: {
              ...grant,
              reviewExpiresAt: DateTime.addDuration(now, Duration.days(grant.lifetimeDays)),
            },
            requestId,
            reviewExpiresAt: DateTime.addDuration(now, Duration.days(grant.lifetimeDays)),
          },
        });
      }),
  }),
  Issue: Command.define("IssueManualPAT", {
    args: ReviewedGrant.fields,
    messages: [Message.Issued, Message.Failed],
    execute: ({ grant, requestId }) =>
      Effect.gen(function* () {
        const api = yield* client;
        const response = yield* api.pats.createManualPAT({ payload: { grant, requestId } });
        if (!disclosure.retain(response.data.bearer)) return Message.Failed();
        issued();
        return Message.Issued();
      }).pipe(Effect.catchCause(() => Effect.succeed(Message.Failed()))),
  }),
  Clear: Command.define("ClearManualPAT", {
    messages: [Message.Mounted],
    execute: Effect.sync(() => {
      disclosure.clear();
      return Message.Mounted();
    }),
  }),
});
const startReview = (model: Model, commands: Commands): Update.Return<Model, Message> => {
  if (model.status !== "Editing") return { model };
  const grant = Schema.decodeOption(GrantDraft)({
    recipientLabel: model.recipientLabel.trim(),
    scopes: model.scopes,
    lifetimeDays: model.lifetimeDays,
  });
  return Option.isNone(grant)
    ? { model }
    : {
        model: { ...model, status: "Reviewing", review: Option.none() },
        commands: [commands.Review({ grant: grant.value })],
      };
};
const makeUpdate =
  (commands: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      EditedLabel: ({ value }) => ({
        model: model.status === "Editing" ? { ...model, recipientLabel: value } : model,
      }),
      ToggledScope: ({ scope }) => ({
        model:
          model.status === "Editing"
            ? {
                ...model,
                scopes: model.scopes.includes(scope)
                  ? model.scopes.filter((item) => item !== scope)
                  : [...model.scopes, scope],
              }
            : model,
      }),
      ChoseDays: ({ value }) => {
        const selected = patLifetimeDayOptions.find((days) => String(days) === value);
        return {
          model:
            model.status === "Editing" && selected !== undefined
              ? { ...model, lifetimeDays: selected }
              : model,
        };
      },
      RequestedReview: () => startReview(model, commands),
      Reviewed: ({ review }) => ({
        model: { ...model, review: Option.some(review), status: "Reviewing" },
      }),
      RequestedIssue: () =>
        model.status === "Reviewing" && Option.isSome(model.review)
          ? {
              model: { ...model, status: "Issuing" },
              commands: [commands.Issue(model.review.value)],
            }
          : { model },
      Issued: () => ({ model: { ...initial, status: "Issued" } }),
      Failed: () => ({ model: { ...model, status: "Failed" } }),
      Edit: () => ({
        model:
          model.status === "Reviewing"
            ? { ...model, status: "Editing", review: Option.none() }
            : model,
      }),
      RetryReview: () => ({
        model: model.status === "Failed" ? { ...model, status: "Reviewing" } : model,
      }),
      Reset: () =>
        model.status === "Issuing" ? { model } : { model: initial, commands: [commands.Clear()] },
      Copied: () => ({ model: { ...model, copied: true } }),
      Mounted: () => ({ model }),
    });
/** Creates one exact reviewed grant, retaining its request identity for explicit submission recovery. */
export const mountManualPAT = (
  configuration: Readonly<{
    container: HTMLElement;
    client: FidyClient;
    resources: Layer.Layer<never>;
    issued: () => void;
  }>
): (() => void) => {
  const { container, client, resources, issued } = configuration;
  const events = Effect.runSync(Queue.unbounded<Message>());
  const disclosure = makeManualDisclosure(events);
  const commands = makeCommands(client, disclosure, issued);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({ model: initial }),
      update: makeUpdate(commands),
      view: (model, html) => manualView({ model, html, disclosure }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        disclosure: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: disclosure.dispose,
        view: (_, html) =>
          html.p([html.Role("alert")], ["No pudimos confirmar el token. Recarga la página."]),
      },
    })
  );
  return () => {
    disclosure.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
