import { Effect, type Layer, Option, Queue, Redacted, Schema, Stream } from "effect";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { makeMountedClipboard } from "@/browser/mounted-clipboard";
import { type SensitiveClipboard, sensitiveClipboardLifetime } from "@/browser/sensitive-clipboard";
import type { BackupRecoveryCode, FidyClient } from "@/transport/client";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/components/button-variants";

const Model = Schema.Struct({
  status: Schema.Literals(["Idle", "Rotating", "Disclosed", "Failed", "FreshSessionRequired"]),
  copied: Schema.Boolean,
});
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  ClickedRotate: {},
  CompletedRotation: { status: Model.fields.status },
  CopiedCode: {},
  CompletedMount: {},
});
type Message = typeof Message.Type;
const FreshSessionRequired = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("user_action_required") }),
});

type Disclosure = Readonly<{
  retain: (code: Redacted.Redacted<BackupRecoveryCode>) => boolean;
  reveal: (element: Element) => void;
  conceal: (element: Element) => void;
  copy: () => void;
  dispose: () => void;
}>;

const makeDisclosure = (clipboard: SensitiveClipboard, onCopied: () => void): Disclosure => {
  let active = true;
  let code = Option.none<Redacted.Redacted<BackupRecoveryCode>>();
  const elements = new Set<Element>();
  return {
    retain: (value) => {
      if (!active) return false;
      code = Option.some(value);
      return true;
    },
    reveal: (element) => {
      if (!active || Option.isNone(code)) return;
      elements.add(element);
      element.textContent = Redacted.value(code.value);
    },
    conceal: (element) => {
      elements.delete(element);
      element.textContent = "";
    },
    copy: () => {
      if (active && Option.isSome(code)) {
        clipboard.copy(Redacted.value(code.value), () => {
          if (active) onCopied();
        });
      }
    },
    dispose: () => {
      active = false;
      if (Option.isSome(code)) clipboard.clear(Redacted.value(code.value));
      code = Option.none();
      for (const element of elements) element.textContent = "";
      elements.clear();
    },
  };
};

type Mounts = Readonly<{
  reveal: () => Mount.MountAction<Message>;
  copy: () => Mount.MountAction<Message>;
}>;
const makeMounts = (disclosure: Disclosure): Mounts => ({
  reveal: Mount.define("RevealRotatedRecovery", {
    messages: [Message.CompletedMount],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => disclosure.reveal(element)),
        () => Effect.sync(() => disclosure.conceal(element))
      ).pipe(Effect.as(Message.CompletedMount())),
  }),
  copy: Mount.define("CopyRotatedRecovery", {
    messages: [Message.CompletedMount],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => element.addEventListener("click", disclosure.copy)),
        () => Effect.sync(() => element.removeEventListener("click", disclosure.copy))
      ).pipe(Effect.as(Message.CompletedMount())),
  }),
});

const failedFeedback = (html: HtmlBuilder<Message>): Html =>
  html.div(
    [html.Role("alert"), html.Class("rounded-lg bg-destructive p-4 text-destructive-foreground")],
    [
      html.h2([], ["No pudimos confirmar el código nuevo."]),
      html.p(
        [],
        [
          "Intenta crear otro código antes de cerrar esta página. Usa únicamente el último código que veas.",
        ]
      ),
    ]
  );

const feedback = (
  model: Model,
  html: HtmlBuilder<Message>,
  mounts: Mounts
): ReadonlyArray<Html> => {
  if (model.status === "Disclosed") {
    return [
      html.div(
        [html.Role("alert"), html.Class("rounded-lg border p-4")],
        [
          html.h2([html.Class("font-semibold")], ["Guárdalo ahora"]),
          html.p(
            [],
            ["Este código se muestra una sola vez. Guárdalo fuera de Fidy y no lo compartas."]
          ),
          html.code([
            html.Key("recovery-disclosure"),
            html.Class("break-all text-base font-semibold"),
            html.OnMount(mounts.reveal()),
          ]),
        ]
      ),
    ];
  }
  if (model.status === "FreshSessionRequired") {
    return [
      html.div(
        [html.Role("alert")],
        [
          html.h2([], ["Inicia sesión de nuevo"]),
          html.p(
            [],
            [
              "Por seguridad, necesitas una sesión reciente para crear un código nuevo. Tu sesión actual sigue activa.",
            ]
          ),
        ]
      ),
    ];
  }
  if (model.status === "Failed") return [failedFeedback(html)];
  return [];
};
const actionLabel = (status: Model["status"]): string => {
  if (status === "Rotating") return "Creando código…";
  if (status === "Failed") return "Intentar de nuevo";
  return "Crear un código nuevo";
};
const action = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html => {
  if (model.status === "FreshSessionRequired") {
    return html.a(
      [html.Href("/auth/google"), html.Class(buttonVariants()), html.AriaLabel("Iniciar sesión")],
      ["Iniciar sesión"]
    );
  }
  if (model.status === "Disclosed") {
    return html.button(
      [
        html.Key("copy-recovery"),
        html.Type("button"),
        html.Class(buttonVariants()),
        html.OnMount(mounts.copy()),
      ],
      [model.copied ? "Copiado" : "Copiar código"]
    );
  }
  return html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants()),
      html.Disabled(model.status === "Rotating"),
      html.OnClick(Message.ClickedRotate()),
    ],
    [actionLabel(model.status)]
  );
};
const view = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html =>
  html.main(
    [html.Class("mx-auto w-full max-w-2xl px-4 py-10 sm:px-6")],
    [
      card({
        html,
        className: "",
        title: "Código de recuperación",
        description:
          "Reemplaza el código anterior después de recuperar tu acceso. El código anterior dejará de funcionar de inmediato.",
        content: feedback(model, html, mounts),
        footer: [action(model, html, mounts)],
      }),
    ]
  );

const makeRotate = (
  apiClient: FidyClient,
  disclosure: Disclosure
): (() => Command.Command<Message>) =>
  Command.define("RotateBackupRecovery", {
    messages: [Message.CompletedRotation],
    execute: Effect.gen(function* () {
      const client = yield* apiClient;
      const response = yield* client.recovery.rotateBackupRecoveryCode();
      const retained = yield* Effect.sync(() =>
        disclosure.retain(response.data.backupRecoveryCode)
      );
      return Message.CompletedRotation({ status: retained ? "Disclosed" : "Failed" });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          Message.CompletedRotation({
            status: Schema.is(FreshSessionRequired)(error) ? "FreshSessionRequired" : "Failed",
          })
        )
      )
    ),
  });

/**
 * Mounts one recovery-code disclosure. The raw code stays in a private capability and its scoped
 * DOM element; disposal erases both immediately and interrupts a pending rotation.
 */
export const mountBackupRecovery = ({
  container,
  apiClient,
  resources,
  clipboard,
}: Readonly<{
  container: HTMLElement;
  apiClient: FidyClient;
  resources: Layer.Layer<never>;
  clipboard: Option.Option<SensitiveClipboard>;
}>): (() => void) => {
  const ownedClipboard = Option.match(clipboard, {
    onNone: () => makeMountedClipboard(sensitiveClipboardLifetime),
    onSome: (command) => ({ clipboard: command, dispose: (): void => undefined }),
  });
  const commands = ownedClipboard.clipboard;
  const events = Effect.runSync(Queue.sliding<Message>(1));
  const disclosure = makeDisclosure(commands, () => {
    Queue.offerUnsafe(events, Message.CopiedCode());
  });
  const Rotate = makeRotate(apiClient, disclosure);
  const mounts = makeMounts(disclosure);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({ model: { status: "Idle", copied: false } }),
      update: (model, message): Update.Return<Model, Message> =>
        Message.match<Update.Return<Model, Message>>(message, {
          ClickedRotate: () =>
            model.status === "Idle" || model.status === "Failed"
              ? { model: { status: "Rotating", copied: false }, commands: [Rotate()] }
              : { model },
          CompletedRotation: ({ status }) => ({ model: { status, copied: false } }),
          CopiedCode: () => ({ model: { ...model, copied: true } }),
          CompletedMount: () => ({ model }),
        }),
      view: (model, html) => view(model, html, mounts),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        clipboard: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: disclosure.dispose,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["No pudimos confirmar el código nuevo. Recarga la página."]
          ),
      },
    })
  );
  return () => {
    disclosure.dispose();
    ownedClipboard.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
