import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/components/button-variants";
import { type EditorContext, mixedEditorCurrencies } from "./editor-draft";
import { EditorMessage, type EditorModel } from "./editor-model";

type Builder = HtmlBuilder<EditorMessage>;
type View = Readonly<{ model: EditorModel; html: Builder; context: EditorContext }>;
const field = (
  configuration: View &
    Readonly<{ name: "counterparty" | "notes" | "amount" | "date"; label: string; type: string }>
): Html => {
  const { model, html, context, name, label, type } = configuration;
  const disabled = name === "amount" && mixedEditorCurrencies(context);
  return html.div(
    [html.Class("flex flex-col gap-2")],
    [
      html.label(
        [html.For(`editor-${name}`), html.Class("flex flex-col gap-2")],
        [
          label,
          html.input([
            html.Id(`editor-${name}`),
            html.Type(type),
            html.Class("rounded-md border p-2"),
            html.Value(model.draft[name]),
            html.Disabled(disabled),
            html.Required(context.mode._tag === "Single" && (name === "amount" || name === "date")),
            html.InputMode(name === "amount" ? "decimal" : "text"),
            html.Placeholder(context.mode._tag === "Bulk" ? "Sin cambiar" : ""),
            html.OnInput((value) => EditorMessage.Changed({ field: name, value })),
          ]),
        ]
      ),
      disabled
        ? html.span(
            [],
            ["Para cambiar el monto en conjunto, selecciona transacciones con la misma moneda."]
          )
        : null,
    ]
  );
};
const choice = (
  configuration: View &
    Readonly<{
      name: "categoryId" | "direction";
      label: string;
      choices: ReadonlyArray<Readonly<{ value: string; label: string }>>;
    }>
): Html => {
  const { model, html, context, name, label, choices } = configuration;
  return html.label(
    [html.For(`editor-${name}`), html.Class("flex flex-col gap-2")],
    [
      label,
      html.select(
        [
          html.Id(`editor-${name}`),
          html.Value(model.draft[name]),
          html.OnChange((value) => EditorMessage.Changed({ field: name, value })),
        ],
        [
          context.mode._tag === "Bulk" ? html.option([html.Value("keep")], ["Sin cambiar"]) : null,
          ...choices.map((item) => html.option([html.Value(item.value)], [item.label])),
        ]
      ),
    ]
  );
};
const editorFields = (view: View): ReadonlyArray<Html> => [
  field({ ...view, name: "counterparty", label: "Contraparte", type: "text" }),
  choice({
    ...view,
    name: "categoryId",
    label: view.context.mode._tag === "Bulk" ? "Categoría de la selección" : "Categoría",
    choices: view.context.categories.map((category) => ({
      value: category.id,
      label: category.label,
    })),
  }),
  choice({
    ...view,
    name: "direction",
    label: view.context.mode._tag === "Bulk" ? "Tipo de la selección" : "Tipo",
    choices: [
      { value: "outflow", label: "Gasto" },
      { value: "inflow", label: "Ingreso" },
    ],
  }),
  field({ ...view, name: "amount", label: "Monto ($)", type: "text" }),
  field({ ...view, name: "date", label: "Fecha", type: "date" }),
  field({ ...view, name: "notes", label: "Notas", type: "text" }),
];
const feedbackCopy = {
  idle: "",
  saving: "",
  invalid: "Revisa los cambios antes de guardar.",
  rejected: "No se guardaron los cambios. Actualiza el historial.",
  uncertain: "No pudimos confirmar los cambios. Actualiza el historial antes de volver a editar.",
} as const;
export const editorView = (view: View): Html => {
  const { model, html, context } = view;
  const locked = ["saving", "uncertain", "rejected"].includes(model.status);
  const title =
    context.mode._tag === "Single" ? "Corregir transacción" : "Editar transacciones seleccionadas";
  return html.form(
    [
      html.AriaLabel(title),
      html.Class("flex flex-col gap-5"),
      html.OnSubmit(EditorMessage.Submit()),
    ],
    [
      html.h2([html.Class("text-xl font-semibold")], [title]),
      html.p(
        [],
        [
          context.mode._tag === "Single"
            ? "Corrige esta transacción sin crear otra."
            : "Los campos vacíos o sin cambiar conservan su valor en cada transacción.",
        ]
      ),
      html.fieldset(
        [html.Disabled(locked), html.Class("flex min-w-0 flex-col gap-5")],
        [html.legend([html.Class("sr-only")], ["Datos de la transacción"]), ...editorFields(view)]
      ),
      feedbackCopy[model.status].length > 0
        ? html.p([html.Role("alert")], [feedbackCopy[model.status]])
        : null,
      ["rejected", "uncertain"].includes(model.status)
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants({ variant: "outline" })),
              html.OnClick(EditorMessage.Refresh()),
            ],
            ["Actualizar historial"]
          )
        : null,
      html.div(
        [html.Class("grid grid-cols-2 gap-3")],
        [
          html.button(
            [
              html.Type("button"),
              html.Disabled(model.status === "saving"),
              html.Class(buttonVariants({ variant: "outline" })),
              html.OnClick(EditorMessage.Cancel()),
            ],
            ["Cancelar"]
          ),
          html.button(
            [html.Type("submit"), html.Disabled(locked), html.Class(buttonVariants())],
            [model.status === "saving" ? "Guardando…" : "Guardar cambios"]
          ),
        ]
      ),
    ]
  );
};
