import { DateTime, Effect, type Layer, Option, Predicate } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { CanonicalSuccess, FidyClient } from "@/transport/client";
import { CaptureDraft, CaptureStatus, captureInput, initialCapture } from "./capture-draft";
import { CaptureMessage, CaptureModel } from "./capture-model";
import { captureView } from "./capture-view";

type Configuration = Readonly<{
  container: HTMLElement;
  client: FidyClient;
  resources: Layer.Layer<never>;
  timeZone: string;
  onCreated: (transaction: CanonicalSuccess<"transactions.createTransaction">["data"]) => void;
  onStatus: (status: CaptureStatus) => void;
  onCheckHistory: () => void;
}>;
const makeSave = (
  configuration: Configuration,
  active: () => boolean
): ((args: Readonly<{ draft: CaptureDraft }>) => Command.Command<CaptureMessage>) =>
  Command.define("CaptureTransaction", {
    args: { draft: CaptureDraft },
    messages: [CaptureMessage.Saved, CaptureMessage.Failed, CaptureMessage.Uncertain],
    execute: ({ draft }) =>
      Effect.gen(function* () {
        const input = captureInput({ draft, timeZone: configuration.timeZone });
        if (Option.isNone(input)) return CaptureMessage.Failed();
        const api = yield* configuration.client;
        const created = yield* api.transactions.createTransaction(input.value);
        yield* Effect.sync(() => {
          if (active()) configuration.onCreated(created.data);
        });
        return CaptureMessage.Saved();
      }).pipe(
        Effect.catch((failure) =>
          Effect.succeed(
            Predicate.isTagged(failure, "ValidationFailed") ||
              Predicate.isTagged(failure, "NotFound") ||
              Predicate.isTagged(failure, "ResourceLimited")
              ? CaptureMessage.Failed()
              : CaptureMessage.Uncertain()
          )
        ),
        Effect.catchCause(() => Effect.succeed(CaptureMessage.Uncertain()))
      ),
  });
const changedDraft = (
  model: CaptureModel,
  message: Extract<CaptureMessage, { _tag: "Changed" }>
): CaptureModel => {
  if (["saving", "uncertain"].includes(model.status)) return model;
  if (message.field === "direction") {
    if (message.value !== "inflow" && message.value !== "outflow") return model;
    return { ...model, draft: { ...model.draft, direction: message.value } };
  }
  return { ...model, draft: { ...model.draft, [message.field]: message.value } };
};
type DraftCommand = (args: Readonly<{ draft: CaptureDraft }>) => Command.Command<CaptureMessage>;
type StatusCommand = (args: Readonly<{ status: CaptureStatus }>) => Command.Command<CaptureMessage>;
const makeUpdate = (
  configuration: Readonly<{
    save: DraftCommand;
    notify: StatusCommand;
    history: () => Command.Command<CaptureMessage>;
    timeZone: string;
  }>
): ((
  model: CaptureModel,
  message: CaptureMessage
) => Update.Return<CaptureModel, CaptureMessage>) => {
  const { save, notify, history } = configuration;
  const status = (
    model: CaptureModel,
    value: CaptureStatus
  ): Update.Return<CaptureModel, CaptureMessage> => ({
    model: { ...model, status: value },
    commands: [notify({ status: value })],
  });
  return (
    model: CaptureModel,
    message: CaptureMessage
  ): Update.Return<CaptureModel, CaptureMessage> =>
    CaptureMessage.match<Update.Return<CaptureModel, CaptureMessage>>(message, {
      Changed: () => ({ model: message._tag === "Changed" ? changedDraft(model, message) : model }),
      Submit: () => {
        if (["saving", "uncertain"].includes(model.status)) return { model };
        if (Option.isNone(captureInput({ draft: model.draft, timeZone: configuration.timeZone }))) {
          return status(model, "failed");
        }
        return {
          model: { ...model, status: "saving" },
          commands: [notify({ status: "saving" }), save({ draft: model.draft })],
        };
      },
      Saved: () =>
        status({ ...model, draft: { ...model.draft, amount: "", counterparty: "" } }, "saved"),
      Failed: () => status(model, "failed"),
      Uncertain: () => status(model, "uncertain"),
      CheckHistory: () => ({ model, commands: [history()] }),
      Notified: () => ({ model }),
    });
};
/** Owns capture drafts and single-flight canonical submission for one mounted interaction. */
export const mountTransactionCapture = (configuration: Configuration): (() => void) => {
  let active = true;
  const save = makeSave(configuration, () => active);
  const notify = Command.define("CaptureFeedback", {
    args: { status: CaptureStatus },
    messages: [CaptureMessage.Notified],
    execute: ({ status }) =>
      Effect.sync(() => {
        if (active) configuration.onStatus(status);
        return CaptureMessage.Notified();
      }),
  });
  const history = Command.define("CaptureCheckHistory", {
    messages: [CaptureMessage.Notified],
    execute: Effect.sync(() => {
      if (active) configuration.onCheckHistory();
      return CaptureMessage.Notified();
    }),
  });
  const update = makeUpdate({ save, notify, history, timeZone: configuration.timeZone });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model: CaptureModel,
      container: configuration.container,
      resources: configuration.resources,
      devTools: false,
      init: (): Update.Return<CaptureModel, CaptureMessage> => ({
        model: {
          draft: initialCapture({
            timeZone: configuration.timeZone,
            now: Effect.runSync(DateTime.now),
          }),
          status: "idle",
        },
      }),
      update,
      view: (model, html) => captureView({ model, html }),
      crash: {
        report: () => {
          active = false;
        },
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["Revisa el historial antes de volver a registrar una transacción."]
          ),
      },
    })
  );
  return () => {
    active = false;
    handle.dispose();
  };
};
