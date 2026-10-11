import { Effect, type Layer, Option, Predicate, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { AtomicBatchRejected, type FidyClient } from "@/transport/client";
import { bulkBatchInput } from "./bulk-draft";
import { type EditorContext, editorChanges, initialEditorDraft } from "./editor-draft";
import { EditorDraft, EditorMessage, EditorModel, EditorStatus } from "./editor-model";
import { editorView } from "./editor-view";

type Configuration = EditorContext &
  Readonly<{
    container: HTMLElement;
    client: FidyClient;
    resources: Layer.Layer<never>;
    onSaved: () => void;
    onCancel: () => void;
    onRefresh: () => void;
    onStatus: (status: EditorStatus) => void;
  }>;
type SaveResult = Extract<EditorMessage, { _tag: "Saved" | "Invalid" | "Rejected" | "Uncertain" }>;
const correction = (configuration: Configuration, draft: EditorDraft): Effect.Effect<SaveResult> =>
  Effect.gen(function* () {
    const changes = editorChanges({ draft, context: configuration });
    if (Option.isNone(changes)) return EditorMessage.Invalid();
    const api = yield* configuration.client;
    if (configuration.mode._tag === "Single") {
      const transaction = configuration.mode.transaction;
      yield* api.transactions.updateTransaction({
        params: { id: transaction.id },
        payload: { expectedRevision: transaction.revision, changes: changes.value },
      });
      return EditorMessage.Saved();
    }
    const input = bulkBatchInput({
      changes: changes.value,
      transactions: configuration.mode.transactions,
    });
    if (Option.isNone(input)) return EditorMessage.Invalid();
    yield* api.operations.executeAtomicBatch(input.value);
    return EditorMessage.Saved();
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(rejected(error) ? EditorMessage.Rejected() : EditorMessage.Uncertain())
    ),
    Effect.catchCause(() => Effect.succeed(EditorMessage.Uncertain()))
  );
const rejected = (error: unknown): boolean =>
  Schema.is(AtomicBatchRejected)(error) ||
  Predicate.isTagged(error, "ValidationFailed") ||
  Predicate.isTagged(error, "NotFound") ||
  Predicate.isTagged(error, "ResourceLimited");
type DraftCommand = (args: Readonly<{ draft: EditorDraft }>) => Command.Command<EditorMessage>;
type StatusCommand = (args: Readonly<{ status: EditorStatus }>) => Command.Command<EditorMessage>;
type Commands = Readonly<{
  save: DraftCommand;
  notify: StatusCommand;
  cancel: () => Command.Command<EditorMessage>;
  refresh: () => Command.Command<EditorMessage>;
}>;
const makeCommands = (configuration: Configuration, active: () => boolean): Commands => ({
  save: Command.define("CorrectTransactions", {
    args: { draft: EditorDraft },
    messages: [
      EditorMessage.Saved,
      EditorMessage.Invalid,
      EditorMessage.Rejected,
      EditorMessage.Uncertain,
    ],
    execute: ({ draft }) => correction(configuration, draft),
  }),
  notify: Command.define("CorrectionFeedback", {
    args: { status: EditorStatus },
    messages: [EditorMessage.Completed],
    execute: ({ status }) =>
      Effect.sync(() => {
        if (active()) configuration.onStatus(status);
        return EditorMessage.Completed();
      }),
  }),
  cancel: Command.define("CancelCorrection", {
    messages: [EditorMessage.Completed],
    execute: Effect.sync(() => {
      if (active()) configuration.onCancel();
      return EditorMessage.Completed();
    }),
  }),
  refresh: Command.define("RefreshCorrectionHistory", {
    messages: [EditorMessage.Completed],
    execute: Effect.sync(() => {
      if (active()) configuration.onRefresh();
      return EditorMessage.Completed();
    }),
  }),
});
const submission = (
  configuration: Readonly<{ model: EditorModel; context: EditorContext; commands: Commands }>
): Update.Return<EditorModel, EditorMessage> => {
  const { model, context, commands } = configuration;
  if (["saving", "uncertain", "rejected"].includes(model.status)) return { model };
  const changes = editorChanges({ draft: model.draft, context });
  if (Option.isNone(changes)) {
    return {
      model: { ...model, status: "invalid" },
      commands: [commands.notify({ status: "invalid" })],
    };
  }
  if (Object.keys(changes.value).length === 0) {
    return context.mode._tag === "Single"
      ? { model, commands: [commands.cancel()] }
      : { model: { ...model, status: "invalid" } };
  }
  return {
    model: { ...model, status: "saving" },
    commands: [commands.notify({ status: "saving" }), commands.save({ draft: model.draft })],
  };
};
const makeUpdate = (
  configuration: Readonly<{ context: Configuration; commands: Commands; active: () => boolean }>
): ((model: EditorModel, message: EditorMessage) => Update.Return<EditorModel, EditorMessage>) => {
  const { context, commands, active } = configuration;
  const saved = Command.define("CorrectionSaved", {
    messages: [EditorMessage.Completed],
    execute: Effect.sync(() => {
      if (active()) context.onSaved();
      return EditorMessage.Completed();
    }),
  });
  const failed = (
    model: EditorModel,
    status: EditorStatus
  ): Update.Return<EditorModel, EditorMessage> => ({
    model: { ...model, status },
    commands: [commands.notify({ status })],
  });
  return (model, message) =>
    EditorMessage.match<Update.Return<EditorModel, EditorMessage>>(message, {
      Changed: ({ field, value }) => ({
        model: ["saving", "uncertain", "rejected"].includes(model.status)
          ? model
          : { ...model, draft: { ...model.draft, [field]: value } },
      }),
      Submit: () => submission({ model, context, commands }),
      Saved: () => ({ model: { ...model, status: "idle" }, commands: [saved()] }),
      Invalid: () => failed(model, "invalid"),
      Rejected: () => failed(model, "rejected"),
      Uncertain: () => failed(model, "uncertain"),
      Cancel: () => ({ model, commands: model.status === "saving" ? [] : [commands.cancel()] }),
      Refresh: () => ({ model, commands: model.status === "saving" ? [] : [commands.refresh()] }),
      Completed: () => ({ model }),
    });
};
/** Owns observed revision-bound corrections; ambiguous writes require a fresh authoritative read. */
export const mountTransactionEditor = (configuration: Configuration): (() => void) => {
  let active = true;
  const commands = makeCommands(configuration, () => active);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model: EditorModel,
      container: configuration.container,
      resources: configuration.resources,
      devTools: false,
      init: (): Update.Return<EditorModel, EditorMessage> => ({
        model: { draft: initialEditorDraft(configuration), status: "idle" },
      }),
      update: makeUpdate({ context: configuration, commands, active: () => active }),
      view: (model, html) => editorView({ model, html, context: configuration }),
      crash: {
        report: () => {
          active = false;
        },
        view: (_, html) =>
          html.p([html.Role("alert")], ["Actualiza el historial antes de volver a editar."]),
      },
    })
  );
  return () => {
    active = false;
    handle.dispose();
  };
};
