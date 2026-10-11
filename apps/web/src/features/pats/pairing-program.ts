import { Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { type PrivateInputs, makePrivateInputs } from "@/browser/private-inputs";
import {
  type FidyClient,
  PATPairingId,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
} from "@/transport/client";
import { pairingView } from "./pairing-foldkit-view";
import { PairingMessage as Message, PairingModel as Model, emptyPairing } from "./pairing-model";

type Inputs = PrivateInputs<"code">;
type Commands = Readonly<{
  Inspect: () => Command.Command<Message>;
  Approve: (args: Readonly<{ pairingId: PATPairingId }>) => Command.Command<Message>;
}>;
const makeCommands = (
  client: FidyClient,
  inputs: Inputs,
  initialCode: Option.Option<PATPairingPublicCode>
): Commands => {
  let selectedCode = initialCode;
  const Inspect = Command.define("InspectCLIPairing", {
    messages: [Message.Inspected, Message.InspectionFailed],
    execute: Effect.gen(function* () {
      const publicCode = Option.orElse(selectedCode, () =>
        Schema.decodeOption(PATPairingPublicCodeInput)(inputs.read("code"))
      );
      selectedCode = Option.none();
      inputs.clear("code");
      if (Option.isNone(publicCode)) return Message.InspectionFailed({ publicCode });
      const api = yield* client;
      return yield* api.pats.inspectPATPairing({ payload: { publicCode: publicCode.value } }).pipe(
        Effect.map(({ data }) => Message.Inspected({ review: data, publicCode: publicCode.value })),
        Effect.catchCause(() => Effect.succeed(Message.InspectionFailed({ publicCode })))
      );
    }),
  });
  const Approve = Command.define("ApproveCLIPairing", {
    args: { pairingId: PATPairingId },
    messages: [Message.Approved, Message.ApprovalFailed],
    execute: ({ pairingId }) =>
      client.pipe(
        Effect.flatMap((api) => api.pats.approvePATPairing({ payload: { pairingId } })),
        Effect.as(Message.Approved()),
        Effect.catchCause(() => Effect.succeed(Message.ApprovalFailed()))
      ),
  });
  return { Inspect, Approve };
};
const makeUpdate =
  ({ Inspect, Approve }: ReturnType<typeof makeCommands>) =>
  (model: Model, message: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      EditedCode: ({ hasDraft }) => ({ model: { ...model, hasDraft } }),
      RequestedInspection: () =>
        model.status === "Entering" && model.hasDraft
          ? { model: { ...model, status: "Inspecting" }, commands: [Inspect()] }
          : { model },
      Inspected: ({ review, publicCode }) => ({
        model: {
          ...emptyPairing,
          review: Option.some(review),
          publicCode: Option.some(publicCode),
          status: "Reviewing",
        },
      }),
      InspectionFailed: ({ publicCode }) => ({
        model: { ...emptyPairing, status: "Invalid", publicCode },
      }),
      RequestedApproval: () =>
        model.status === "Reviewing" && Option.isSome(model.review)
          ? {
              model: { ...model, status: "Approving" },
              commands: [Approve({ pairingId: model.review.value.pairingId })],
            }
          : { model },
      Approved: () => ({ model: { ...emptyPairing, status: "Approved" } }),
      ApprovalFailed: () => ({ model: { ...emptyPairing, status: "Invalid" } }),
      Reset: () =>
        model.status === "Approving" || model.status === "Inspecting"
          ? { model }
          : { model: emptyPairing },
      Mounted: () => ({ model }),
    });
const makeInputMount = (
  inputs: Inputs,
  events: Queue.Queue<Message>
): (() => Mount.MountAction<Message>) =>
  Mount.define("PrivateCLICode", {
    messages: [Message.Mounted],
    execute: ({ element }) => {
      if (!(element instanceof HTMLInputElement)) return Effect.succeed(Message.Mounted());
      return Effect.acquireRelease(
        Effect.sync(() => {
          const release = inputs.bind("code", element);
          const edited = (): void => {
            Queue.offerUnsafe(
              events,
              Message.EditedCode({ hasDraft: element.value.trim().length > 0 })
            );
          };
          element.addEventListener("input", edited);
          return (): void => {
            element.removeEventListener("input", edited);
            release();
          };
        }),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.Mounted()));
    },
  });
/** Reviews a public code, then grants only the reviewed identity on explicit intent. */
export const mountCLIPairing = (
  configuration: Readonly<{
    container: HTMLElement;
    client: FidyClient;
    resources: Layer.Layer<never>;
    code: unknown;
  }>
): (() => void) => {
  const { container, client, resources } = configuration;
  const code = Schema.decodeUnknownOption(PATPairingPublicCode)(configuration.code);
  const inputs = makePrivateInputs<"code">();
  const events = Effect.runSync(Queue.unbounded<Message>());
  const commands = makeCommands(client, inputs, code);
  const input = makeInputMount(inputs, events);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: Option.isSome(code)
          ? { ...emptyPairing, status: "Inspecting", publicCode: code }
          : emptyPairing,
        commands: Option.isSome(code) ? [commands.Inspect()] : [],
      }),
      update: makeUpdate(commands),
      view: (model, html) => pairingView({ model, html, input: input() }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        edits: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: () => inputs.dispose(),
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["La solicitud no está disponible. Inicia una nueva conexión."]
          ),
      },
    })
  );
  return () => {
    inputs.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
