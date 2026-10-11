import { Option } from "effect";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/components/button-variants";
import { Message, type Model } from "./model";
import type { PaymentField } from "./payment-model";

type Builder = HtmlBuilder<Message>;
export type InputMount = (args: Readonly<{ field: PaymentField }>) => Mount.MountAction<Message>;
type Field = Readonly<{
  field: PaymentField;
  id: string;
  label: string;
  type: string;
  autocomplete: string;
  inputMode: string;
  pattern: string;
  placeholder: string;
  maxlength: number;
}>;
const fields: Readonly<Record<PaymentField, Field>> = {
  email: {
    field: "email",
    id: "billing-email",
    label: "Correo de facturación",
    type: "email",
    autocomplete: "email",
    inputMode: "email",
    pattern: "",
    placeholder: "",
    maxlength: 254,
  },
  number: {
    field: "number",
    id: "card-number",
    label: "Número de tarjeta",
    type: "text",
    autocomplete: "cc-number",
    inputMode: "numeric",
    pattern: "[0-9]*",
    placeholder: "",
    maxlength: 19,
  },
  expiration: {
    field: "expiration",
    id: "card-expiration",
    label: "Vencimiento",
    type: "text",
    autocomplete: "cc-exp",
    inputMode: "numeric",
    pattern: "[0-9/]*",
    placeholder: "MM/YYYY",
    maxlength: 7,
  },
  cvc: {
    field: "cvc",
    id: "card-cvc",
    label: "CVC",
    type: "password",
    autocomplete: "cc-csc",
    inputMode: "numeric",
    pattern: "[0-9]*",
    placeholder: "",
    maxlength: 4,
  },
  name: {
    field: "name",
    id: "cardholder-name",
    label: "Nombre en la tarjeta",
    type: "text",
    autocomplete: "cc-name",
    inputMode: "text",
    pattern: "",
    placeholder: "",
    maxlength: 200,
  },
  nequi: {
    field: "nequi",
    id: "nequi-number",
    label: "Número de Nequi",
    type: "text",
    autocomplete: "off",
    inputMode: "numeric",
    pattern: "3[0-9]{9}",
    placeholder: "",
    maxlength: 10,
  },
  document: {
    field: "document",
    id: "daviplata-document",
    label: "Número de cédula",
    type: "text",
    autocomplete: "off",
    inputMode: "numeric",
    pattern: "[0-9]{5,15}",
    placeholder: "",
    maxlength: 15,
  },
  product: {
    field: "product",
    id: "daviplata-product",
    label: "Número de DaviPlata",
    type: "text",
    autocomplete: "off",
    inputMode: "numeric",
    pattern: "3[0-9]{9}",
    placeholder: "",
    maxlength: 10,
  },
  otp: {
    field: "otp",
    id: "daviplata-otp",
    label: "Código de verificación",
    type: "password",
    autocomplete: "off",
    inputMode: "numeric",
    pattern: "[0-9]{6}",
    placeholder: "",
    maxlength: 6,
  },
};
const inputField = (
  configuration: Readonly<{ name: PaymentField; busy: boolean; html: Builder; mount: InputMount }>
): Html => {
  const { name, busy, html, mount } = configuration;
  const field = fields[name];
  return html.label(
    [html.Class("flex flex-col gap-1"), html.For(field.id)],
    [
      field.label,
      html.input([
        html.Key(field.field),
        html.Id(field.id),
        html.Type(field.type),
        html.Autocomplete(field.autocomplete),
        html.InputMode(field.inputMode),
        html.Class("rounded-md border p-2"),
        html.Required(true),
        html.Disabled(busy),
        html.Maxlength(field.maxlength),
        html.Placeholder(field.placeholder),
        ...(field.pattern.length > 0 ? [html.Pattern(field.pattern)] : []),
        html.OnMount(mount({ field: name })),
      ]),
    ]
  );
};
const selectedFields = (model: Model): ReadonlyArray<PaymentField> => {
  if (model.payment.reuse) return [];
  if (model.payment.method === "card") return ["number", "expiration", "cvc", "name"];
  return model.payment.method === "nequi" ? ["nequi"] : ["document", "product"];
};
const decision = (
  configuration: Readonly<{
    model: Model;
    html: Builder;
    name: "endUserPolicy" | "personalData";
    prefix: string;
    label: string;
    href: string;
  }>
): Html => {
  const { model, html, name, prefix, label, href } = configuration;
  return html.label(
    [html.Class("flex items-start gap-2")],
    [
      html.input([
        html.Type("checkbox"),
        html.Checked(model[name]),
        html.Disabled(model.payment.busy),
        html.OnClick(Message.ToggledDecision({ decision: name })),
      ]),
      html.span(
        [],
        [
          prefix,
          html.a(
            [
              html.Href(href),
              html.Target("_blank"),
              html.Rel("noreferrer"),
              html.Class("underline"),
            ],
            [label]
          ),
          " de Wompi.",
        ]
      ),
    ]
  );
};
const decisions = (model: Model, html: Builder): Html => {
  if (Option.isNone(model.payment.contracts)) return html.div([]);
  const contracts = model.payment.contracts.value;
  return html.div(
    [html.Class("flex flex-col gap-2")],
    [
      decision({
        model,
        html,
        name: "endUserPolicy",
        prefix: "Acepto el ",
        label: "reglamento",
        href: contracts.endUserPolicy,
      }),
      decision({
        model,
        html,
        name: "personalData",
        prefix: "Autorizo el ",
        label: "tratamiento de datos personales",
        href: contracts.personalData,
      }),
    ]
  );
};
const submitLabel = (model: Model): string => {
  if (model.payment.busy) {
    return model.payment.method === "nequi" ? "Esperando autorización…" : "Activando Pro…";
  }
  if (model.payment.reuse || model.payment.method === "card") return "Activar Pro";
  return model.payment.method === "nequi" ? "Autorizar con Nequi" : "Autorizar con DaviPlata";
};
export const paymentFieldsView = (
  configuration: Readonly<{ model: Model; html: Builder; mount: InputMount }>
): Html => {
  const { model, html, mount } = configuration;
  const busy = model.payment.busy;
  return html.form(
    [
      html.Key(`payment-fields-${model.payment.generation}`),
      html.Class("flex flex-col gap-5"),
      html.OnSubmit(Message.RequestedPayment({ action: "Submit" })),
    ],
    [
      model.payment.reuse
        ? html.p(
            [],
            [
              "Usaremos de nuevo tu fuente de pago guardada. No necesitas ingresar los datos de nuevo.",
            ]
          )
        : null,
      model.payment.method === "daviplata" && !model.payment.reuse
        ? html.p([], ["Cédula de ciudadanía (CC). Por ahora solo admitimos CC."])
        : null,
      html.fieldset(
        [html.Class("grid gap-3 sm:grid-cols-2")],
        [
          html.legend([html.Class("sr-only")], ["Datos de pago"]),
          ...selectedFields(model).map((name) => inputField({ name, busy, html, mount })),
        ]
      ),
      inputField({ name: "email", busy, html, mount }),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        [
          "Fidy conservará este correo y lo compartirá con Wompi para los cobros automáticos posteriores de tu fuente de pago reutilizable.",
        ]
      ),
      decisions(model, html),
      model.payment.stage === "AwaitingNequi"
        ? html.output(
            [html.AriaLive("polite")],
            ["Aprueba la suscripción en Nequi. Luego verificaremos tu fuente de pago."]
          )
        : null,
      html.button(
        [
          html.Type("submit"),
          html.Class(buttonVariants()),
          html.Disabled(busy || !model.endUserPolicy || !model.personalData),
        ],
        [submitLabel(model)]
      ),
    ]
  );
};
export const otpFieldsView = (
  configuration: Readonly<{ model: Model; html: Builder; mount: InputMount }>
): Html => {
  const { model, html, mount } = configuration;
  const busy = model.payment.busy;
  return html.form(
    [
      html.Key(`otp-${model.payment.generation}`),
      html.Class("flex flex-col gap-4"),
      html.OnSubmit(Message.RequestedPayment({ action: "Confirm" })),
    ],
    [
      inputField({ name: "otp", busy, html, mount }),
      html.button(
        [html.Type("submit"), html.Disabled(busy), html.Class(buttonVariants())],
        ["Confirmar código"]
      ),
      html.button(
        [
          html.Type("button"),
          html.Disabled(busy),
          html.Class(buttonVariants({ variant: "outline" })),
          html.OnClick(Message.RequestedPayment({ action: "Resend" })),
        ],
        ["Reenviar código"]
      ),
    ]
  );
};
