import { Effect, type Layer, Option, Predicate, Queue, Result, Schema, Stream } from "effect";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  EmailAddress,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailVerificationCode,
  type FidyClient,
} from "@/transport/client";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/components/button-variants";

const Status = Schema.Literals([
  "Editing",
  "Requesting",
  "AwaitingCode",
  "Completing",
  "Invalid",
  "FreshPairingRequired",
  "Replaced",
  "Unavailable",
]);
type Status = typeof Status.Type;
const Model = Schema.Struct({ status: Status, hasDraft: Schema.Boolean, attempt: Schema.Finite });
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  ChangedDraftPresence: { present: Schema.Boolean },
  SubmittedMailbox: {},
  SubmittedProof: {},
  ClickedResend: {},
  ClickedRestart: {},
  CompletedWork: { status: Status, attempt: Schema.Finite },
  CompletedMount: {},
});
type Message = typeof Message.Type;

const freshPairingRequired = (failure: unknown): boolean =>
  Schema.is(EmailReplacementFreshPairingRequiredApi)(failure) ||
  Predicate.isTagged(failure, "Unauthenticated");
type PrivateForm = Readonly<{
  edit: (value: string, proof: boolean) => void;
  retain: (element: Element) => () => void;
  reveal: (element: Element) => void;
  request: Effect.Effect<Status>;
  complete: Effect.Effect<Status>;
  reset: () => void;
}>;
const makePrivateForm = (apiClient: FidyClient): PrivateForm => {
  let mailbox = "";
  let proof = "";
  const elements = new Set<Element>();
  return {
    retain: (element) => {
      elements.add(element);
      return () => {
        elements.delete(element);
      };
    },
    edit: (value, isProof) => {
      if (isProof) proof = value.toUpperCase();
      else mailbox = value;
    },
    reveal: (element) => {
      element.textContent = mailbox;
    },
    reset: () => {
      mailbox = "";
      proof = "";
      for (const element of elements) {
        if (element instanceof HTMLInputElement) element.value = "";
        else element.textContent = "";
      }
    },
    request: Effect.gen(function* () {
      const candidateEmail = Schema.decodeOption(EmailAddress)(mailbox);
      if (Option.isNone(candidateEmail)) return "Editing";
      const client = yield* apiClient;
      const result = yield* Effect.result(
        client.emailAuthentication.requestEmailReplacement({
          payload: { candidateEmail: candidateEmail.value },
        })
      );
      if (Result.isSuccess(result)) return "AwaitingCode";
      return freshPairingRequired(result.failure) ? "FreshPairingRequired" : "Unavailable";
    }).pipe(Effect.catchCause(() => Effect.succeed("Unavailable" as const))),
    complete: Effect.gen(function* () {
      const combinedCode = Schema.decodeOption(EmailVerificationCode)(proof);
      proof = "";
      if (Option.isNone(combinedCode)) return "Invalid";
      const client = yield* apiClient;
      const result = yield* Effect.result(
        client.emailAuthentication.completeEmailReplacement({
          payload: { combinedCode: combinedCode.value },
        })
      );
      if (Result.isSuccess(result)) {
        mailbox = "";
        return "Replaced";
      }
      if (freshPairingRequired(result.failure)) return "FreshPairingRequired";
      return Schema.is(EmailReplacementInvalidApi)(result.failure) ? "Invalid" : "Unavailable";
    }).pipe(Effect.catchCause(() => Effect.succeed("Unavailable" as const))),
  };
};

type Mounts = Readonly<{
  input: (args: Readonly<{ proof: boolean }>) => Mount.MountAction<Message>;
  mailbox: () => Mount.MountAction<Message>;
}>;
const makeMounts = (form: PrivateForm, events: Queue.Queue<Message>): Mounts => ({
  input: Mount.define("EditPrivateMailboxProof", {
    args: { proof: Schema.Boolean },
    messages: [Message.CompletedMount],
    execute: ({ element, proof }) => {
      if (!(element instanceof HTMLInputElement)) return Effect.succeed(Message.CompletedMount());
      const input = element;
      const change = (): void => {
        if (proof) input.value = input.value.toUpperCase();
        form.edit(input.value, proof);
        Queue.offerUnsafe(
          events,
          Message.ChangedDraftPresence({ present: input.value.length > 0 })
        );
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          input.addEventListener("input", change);
          return form.retain(input);
        }),
        (release) =>
          Effect.sync(() => {
            release();
            input.removeEventListener("input", change);
            input.value = "";
          })
      ).pipe(Effect.as(Message.CompletedMount()));
    },
  }),
  mailbox: Mount.define("ShowReplacementMailbox", {
    messages: [Message.CompletedMount],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          form.reveal(element);
          return form.retain(element);
        }),
        (release) =>
          Effect.sync(() => {
            release();
            element.textContent = "";
          })
      ).pipe(Effect.as(Message.CompletedMount())),
  }),
});
const button = (html: HtmlBuilder<Message>, label: string, message: Message): Html =>
  html.button(
    [
      html.Type("button"),
      html.Class(buttonVariants({ variant: "outline" })),
      html.OnClick(message),
    ],
    [label]
  );
const proofField = {
  id: "replacement-code",
  type: "text",
  maxLength: 29,
  autocomplete: "one-time-code",
  placeholder: "ABCD-2345-F7KM-9Q2D-X4PT-6RWC",
  label: "Código de verificación",
  submit: "Cambiar correo",
} as const;
const mailboxField = {
  id: "candidate-email",
  type: "email",
  maxLength: 320,
  autocomplete: "email",
  placeholder: "tu-nuevo-correo@ejemplo.com",
  label: "Nuevo correo",
  submit: "Enviar código",
} as const;
const fields = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html => {
  const proof = model.status !== "Editing";
  const field = proof ? proofField : mailboxField;
  const id = field.id;
  return html.form(
    [
      html.Key(proof ? `proof-${model.status}` : "mailbox"),
      html.Class("flex flex-col gap-4"),
      html.OnSubmit(proof ? Message.SubmittedProof() : Message.SubmittedMailbox()),
    ],
    [
      model.status === "Invalid"
        ? html.div(
            [html.Role("alert")],
            [
              html.h2([], ["El código no es válido"]),
              html.p([], ["Revisa el correo o solicita otro código."]),
            ]
          )
        : null,
      proof
        ? html.p(
            [html.Class("text-sm text-muted-foreground")],
            ["Enviamos un código a ", html.span([html.OnMount(mounts.mailbox())]), "."]
          )
        : null,
      html.label([html.For(id), html.Class("text-sm font-medium")], [field.label]),
      html.input([
        html.Id(id),
        html.Type(field.type),
        html.Required(true),
        html.Maxlength(field.maxLength),
        html.Autocomplete(field.autocomplete),
        html.Spellcheck(false),
        html.Placeholder(field.placeholder),
        html.Class(
          "h-11 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        ),
        html.OnMount(mounts.input({ proof })),
      ]),
      html.button(
        [html.Type("submit"), html.Class(buttonVariants()), html.Disabled(!model.hasDraft)],
        [field.submit]
      ),
      ...(proof
        ? [
            button(html, "Reenviar código", Message.ClickedResend()),
            button(html, "Usar otro correo", Message.ClickedRestart()),
          ]
        : []),
    ]
  );
};

const failureContent = (model: Model, html: HtmlBuilder<Message>): Html => {
  const fresh = model.status === "FreshPairingRequired";
  return html.div(
    [html.Role("alert")],
    [
      html.h2(
        [],
        [fresh ? "Vincula el navegador de nuevo" : "No pudimos confirmar el cambio de correo"]
      ),
      html.p(
        [],
        [
          fresh
            ? "Por seguridad, necesitas una sesión recién vinculada para cambiar tu correo. "
            : "El cambio podría haberse completado. Comprueba tu correo al iniciar sesión antes de solicitar otro cambio. ",
          html.a([html.Href("/auth/pair"), html.Class("underline")], ["Ir a vinculación"]),
          ".",
        ]
      ),
    ]
  );
};

const content = (model: Model, html: HtmlBuilder<Message>, mounts: Mounts): Html => {
  if (model.status === "Editing" || model.status === "AwaitingCode" || model.status === "Invalid") {
    return fields(model, html, mounts);
  }
  if (model.status === "Requesting" || model.status === "Completing") {
    return html.output([], ["Procesando…"]);
  }
  if (model.status === "Replaced") {
    return html.div(
      [html.Role("alert")],
      [
        html.h2([], ["Correo actualizado"]),
        html.p([], ["Tu nuevo correo verificado ya está activo."]),
      ]
    );
  }
  return failureContent(model, html);
};

type Commands = Readonly<{
  Request: (args: Readonly<{ attempt: number }>) => Command.Command<Message>;
  Complete: (args: Readonly<{ attempt: number }>) => Command.Command<Message>;
  Reset: (args: Readonly<{ attempt: number }>) => Command.Command<Message>;
}>;
const makeCommands = (form: PrivateForm): Commands => {
  const Request = Command.define("RequestEmailReplacement", {
    args: { attempt: Schema.Finite },
    messages: [Message.CompletedWork],
    interrupt: true,
    execute: ({ attempt }) =>
      form.request.pipe(Effect.map((status) => Message.CompletedWork({ status, attempt }))),
  });
  const Complete = Command.define("CompleteEmailReplacement", {
    args: { attempt: Schema.Finite },
    messages: [Message.CompletedWork],
    interrupt: true,
    execute: ({ attempt }) =>
      form.complete.pipe(Effect.map((status) => Message.CompletedWork({ status, attempt }))),
  });
  const Reset = Command.define("ResetEmailReplacement", {
    args: { attempt: Schema.Finite },
    messages: [Message.CompletedWork],
    execute: ({ attempt }) =>
      Effect.sync(form.reset).pipe(
        Effect.andThen(
          Request.Interrupt(() => Message.CompletedWork({ status: "Editing", attempt })).effect
        ),
        Effect.andThen(
          Complete.Interrupt(() => Message.CompletedWork({ status: "Editing", attempt })).effect
        ),
        Effect.as(Message.CompletedWork({ status: "Editing", attempt }))
      ),
  });
  return { Request, Complete, Reset };
};

const makeUpdate =
  ({
    Request,
    Complete,
    Reset,
  }: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model: Model, message: Message): Update.Return<Model, Message> =>
    Message.match<Update.Return<Model, Message>>(message, {
      ChangedDraftPresence: ({ present }) => ({ model: { ...model, hasDraft: present } }),
      SubmittedMailbox: () =>
        model.status === "Editing" && model.hasDraft
          ? {
              model: { ...model, status: "Requesting", hasDraft: false },
              commands: [Request({ attempt: model.attempt })],
            }
          : { model },
      SubmittedProof: () =>
        (model.status === "AwaitingCode" || model.status === "Invalid") && model.hasDraft
          ? {
              model: { ...model, status: "Completing", hasDraft: false },
              commands: [Complete({ attempt: model.attempt })],
            }
          : { model },
      ClickedResend: () =>
        model.status === "AwaitingCode" || model.status === "Invalid"
          ? {
              model: { ...model, status: "Requesting", hasDraft: false },
              commands: [Request({ attempt: model.attempt })],
            }
          : { model },
      ClickedRestart: () => ({
        model: { status: "Editing", hasDraft: false, attempt: model.attempt + 1 },
        commands: [Reset({ attempt: model.attempt + 1 })],
      }),
      CompletedWork: ({ status, attempt }) =>
        attempt === model.attempt ? { model: { ...model, status, hasDraft: false } } : { model },
      CompletedMount: () => ({ model }),
    });

/** Keeps mailbox and proof in the mounted form capability, outside serialized presentation state. */
export const mountEmailReplacement = ({
  container,
  apiClient,
  resources,
}: Readonly<{
  container: HTMLElement;
  apiClient: FidyClient;
  resources: Layer.Layer<never>;
}>): (() => void) => {
  const form = makePrivateForm(apiClient);
  const events = Effect.runSync(Queue.sliding<Message>(1));
  const mounts = makeMounts(form, events);
  const update = makeUpdate(makeCommands(form));
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      update,
      init: (): Update.Return<Model, Message> => ({
        model: { status: "Editing", hasDraft: false, attempt: 0 },
      }),
      view: (model, html) =>
        html.main(
          [html.Class("mx-auto w-full max-w-2xl px-4 py-12 sm:px-6")],
          [
            card({
              html,
              footer: [],
              className: "",
              title: "Cambiar correo verificado",
              description:
                "Esta opción requiere un correo verificado establecido por separado. Iniciar sesión con Google o Microsoft no lo establece. Si ya tienes uno, seguirá activo hasta que verifiques el nuevo.",
              content: [content(model, html, mounts)],
            }),
          ]
        ),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        draft: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: form.reset,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["No pudimos confirmar el cambio de correo. Recarga la página."]
          ),
      },
    })
  );
  return () => {
    form.reset();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
