import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/components/button-variants";
import { CaptureMessage, type CaptureModel } from "./capture-model";

type Builder = HtmlBuilder<CaptureMessage>;
const input = (
  configuration: Readonly<{
    html: Builder;
    model: CaptureModel;
    name: "amount" | "counterparty" | "occurredOn";
    label: string;
    type: string;
    required: boolean;
  }>
): Html => {
  const { html, model, name, label, type, required } = configuration;
  return html.label(
    [html.For(`capture-${name}`), html.Class("flex flex-col gap-2")],
    [
      label,
      html.input([
        html.Id(`capture-${name}`),
        html.Type(type),
        html.Required(required),
        html.InputMode(name === "amount" ? "decimal" : "text"),
        html.Value(model.draft[name]),
        html.Class("rounded-md border p-2"),
        html.OnInput((value) => CaptureMessage.Changed({ field: name, value })),
      ]),
    ]
  );
};
const feedback = (model: CaptureModel, html: Builder): ReadonlyArray<Html> => {
  if (model.status === "saved") return [html.output([], ["Transacción guardada."])];
  if (model.status === "failed") {
    return [html.p([html.Role("alert")], ["No se pudo guardar la transacción. Intenta de nuevo."])];
  }
  if (model.status !== "uncertain") return [];
  return [
    html.p(
      [html.Role("alert")],
      [
        "No pudimos confirmar el registro de la transacción. Revisa el historial antes de registrar otro movimiento.",
      ]
    ),
    html.button(
      [
        html.Type("button"),
        html.Class(buttonVariants({ variant: "outline" })),
        html.OnClick(CaptureMessage.CheckHistory()),
      ],
      ["Actualizar historial"]
    ),
  ];
};
export const captureView = ({
  model,
  html,
}: Readonly<{ model: CaptureModel; html: Builder }>): Html => {
  const locked = model.status === "saving" || model.status === "uncertain";
  return html.form(
    [
      html.AriaLabel("Registrar transacción"),
      html.Class("flex flex-col gap-5"),
      html.OnSubmit(CaptureMessage.Submit()),
    ],
    [
      html.fieldset(
        [html.Disabled(locked), html.Class("flex min-w-0 flex-col gap-4")],
        [
          html.legend([html.Class("sr-only")], ["Datos de la transacción"]),
          input({ html, model, name: "amount", label: "Monto ($)", type: "text", required: true }),
          input({
            html,
            model,
            name: "occurredOn",
            label: "Fecha del movimiento",
            type: "date",
            required: true,
          }),
          input({
            html,
            model,
            name: "counterparty",
            label: "Contraparte (opcional)",
            type: "text",
            required: false,
          }),
          html.label(
            [html.For("capture-direction"), html.Class("flex flex-col gap-2")],
            [
              "Dirección",
              html.select(
                [
                  html.Id("capture-direction"),
                  html.Value(model.draft.direction),
                  html.OnChange((value) => CaptureMessage.Changed({ field: "direction", value })),
                ],
                [
                  html.option([html.Value("outflow")], ["Gasto"]),
                  html.option([html.Value("inflow")], ["Ingreso"]),
                ]
              ),
            ]
          ),
          html.button(
            [html.Type("submit"), html.Disabled(locked), html.Class(buttonVariants())],
            [model.status === "saving" ? "Guardando…" : "Registrar transacción"]
          ),
        ]
      ),
      ...feedback(model, html),
    ]
  );
};
