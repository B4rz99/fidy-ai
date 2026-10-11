import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/button-variants";
import { invalidPairingMessage } from "./controller";
import { Message, type PairingState } from "./model";
import { browserLoginPairingWhatsAppUrl } from "./whatsapp-link";

type InputMount = (args: Readonly<{ field: "email" | "proof" }>) => Mount.MountAction<Message>;
const actionButton = (html: HtmlBuilder<Message>, label: string, message: Message): Html =>
  html.button(
    [html.Type("button"), html.Class(`${buttonVariants()} w-full`), html.OnClick(message)],
    [label]
  );
const requestForm = (sending: boolean, html: HtmlBuilder<Message>, input: InputMount): Html =>
  html.form(
    [
      html.Class("flex flex-col gap-2"),
      html.Key("pairing-email-request"),
      html.OnSubmit(Message.RequestedEmail({ action: "Request" })),
    ],
    [
      html.label(
        [html.Class("text-sm font-medium"), html.For("browser-login-email")],
        ["O accede con tu correo verificado"]
      ),
      html.input([
        html.Id("browser-login-email"),
        html.Name("email"),
        html.Type("email"),
        html.Autocomplete("email"),
        html.Required(true),
        html.Disabled(sending),
        html.Placeholder("tu@correo.com"),
        html.Class("h-11 rounded-md border px-3"),
        html.OnMount(input({ field: "email" })),
      ]),
      html.button(
        [
          html.Type("submit"),
          html.Disabled(sending),
          html.Class(buttonVariants({ variant: "outline" })),
        ],
        ["Enviar código por correo"]
      ),
    ]
  );
const codeForm = (step: string, html: HtmlBuilder<Message>, input: InputMount): Html =>
  html.form(
    [
      html.Class("flex flex-col gap-2"),
      html.Key("pairing-email-proof"),
      html.OnSubmit(Message.RequestedEmail({ action: "Complete" })),
    ],
    [
      html.label(
        [html.Class("text-sm font-medium"), html.For("browser-login-email-code")],
        ["Código recibido por correo"]
      ),
      html.input([
        html.Id("browser-login-email-code"),
        html.Name("combinedCode"),
        html.Autocomplete("one-time-code"),
        html.Required(true),
        html.Disabled(step === "submitting"),
        html.Placeholder("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"),
        html.Class("h-11 rounded-md border px-3"),
        html.OnMount(input({ field: "proof" })),
      ]),
      step === "rejected"
        ? html.p(
            [
              html.Role("alert"),
              html.Id("browser-login-code-error"),
              html.Class("rounded-lg bg-destructive p-3 text-sm text-destructive-foreground"),
            ],
            ["El código no es válido. Revisa el correo o solicita uno nuevo."]
          )
        : null,
      html.button(
        [
          html.Type("submit"),
          html.Disabled(step === "submitting"),
          html.Class(buttonVariants({ variant: "outline" })),
        ],
        ["Aprobar este navegador"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Disabled(step === "submitting"),
          html.Class(buttonVariants({ variant: "ghost" })),
          html.OnClick(Message.RequestedEmail({ action: "Resend" })),
        ],
        ["Solicitar otro código al mismo correo"]
      ),
    ]
  );
const awaiting = (
  state: Extract<PairingState, { _tag: "AwaitingApproval" }>,
  html: HtmlBuilder<Message>,
  input: InputMount
): Html =>
  html.div(
    [html.Class("flex flex-col gap-4")],
    [
      html.div(
        [html.Role("alert")],
        [
          html.h2([], ["Aprueba en WhatsApp"]),
          html.p([], ["Confirma que el código que muestra Fidy coincide con este código."]),
        ]
      ),
      html.p(
        [
          html.AriaLabel(`Código de vinculación ${state.publicCode}`),
          html.Class(
            "rounded-lg border bg-background py-4 text-center font-mono text-3xl font-semibold tracking-widest"
          ),
        ],
        [state.publicCode]
      ),
      html.a(
        [
          html.Href(browserLoginPairingWhatsAppUrl(state.publicCode)),
          html.Rel("noreferrer"),
          html.Class(`${buttonVariants()} w-full`),
        ],
        ["Abrir WhatsApp"]
      ),
      html.p(
        [html.AriaLive("polite"), html.Class("text-center text-sm text-muted-foreground")],
        ["Esperando aprobación…"]
      ),
      state.emailStep === "ready" || state.emailStep === "sending"
        ? requestForm(state.emailStep === "sending", html, input)
        : codeForm(state.emailStep, html, input),
    ]
  );
const content = (state: PairingState, html: HtmlBuilder<Message>, input: InputMount): Html => {
  switch (state._tag) {
    case "Idle":
      return actionButton(html, "Iniciar sesión en el navegador", Message.ClickedStart());
    case "Starting":
      return html.output([], ["Iniciando vinculación segura…"]);
    case "AwaitingApproval":
      return awaiting(state, html, input);
    case "Authenticated":
      return html.div(
        [html.Class("flex flex-col gap-4")],
        [
          html.h2([], ["Sesión iniciada"]),
          html.p([], ["Este navegador ahora tiene una sesión de Fidy guardada."]),
          actionButton(html, "Cerrar sesión", Message.ClickedLogout()),
        ]
      );
    case "Invalid":
      return html.div(
        [html.Role("alert")],
        [
          html.h2([], ["La vinculación terminó"]),
          html.p([], [invalidPairingMessage]),
          actionButton(html, "Iniciar de nuevo", Message.ClickedRestart()),
        ]
      );
  }
};
/** Displays only the public pairing code; proof inputs belong to scoped DOM capabilities. */
export const pairingView = ({
  state,
  html,
  input,
  providerUrl,
}: Readonly<{
  state: PairingState;
  html: HtmlBuilder<Message>;
  input: InputMount;
  providerUrl: string;
}>): Html =>
  html.main(
    [html.Class("flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12")],
    [
      card({
        html,
        className: "w-full max-w-md",
        title: "Inicia sesión en Fidy",
        description:
          "Empieza aquí y luego aprueba este navegador desde tu conversación con Fidy en WhatsApp.",
        content: [
          html.a(
            [html.Href(providerUrl), html.Class("text-center underline")],
            ["Crear cuenta o iniciar sesión con Google o Microsoft"]
          ),
          content(state, html, input),
        ],
        footer: [],
      }),
    ]
  );
