import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "@/ui/button-variants";
import { hasTransactionFilters, transactionsEditable } from "./ledger-presentation";
import { Message, type Model } from "./model";

type Builder = HtmlBuilder<Message>;
const choice = (
  configuration: Readonly<{
    html: Builder;
    label: string;
    value: string;
    options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
    disabled: boolean;
    changed: (value: string) => Message;
  }>
): Html => {
  const { html } = configuration;
  return html.select(
    [
      html.AriaLabel(configuration.label),
      html.Value(configuration.value),
      html.Disabled(configuration.disabled),
      html.Class("h-9 rounded-md border bg-background px-3 text-sm"),
      html.OnChange(configuration.changed),
    ],
    configuration.options.map((item) =>
      html.option(
        [html.Value(item.value), html.Selected(item.value === configuration.value)],
        [item.label]
      )
    )
  );
};
const displayControls = (model: Model, html: Builder): ReadonlyArray<Html> => [
  choice({
    html,
    label: "Ordenar transacciones",
    value: model.sort,
    disabled: model.working,
    changed: (value) => Message.Sorted({ value }),
    options: [
      { value: "default", label: "Fecha más reciente" },
      { value: "counterpartyLabel:asc", label: "Contraparte A–Z" },
      { value: "counterpartyLabel:desc", label: "Contraparte Z–A" },
      { value: "categoryLabel:asc", label: "Categoría A–Z" },
    ],
  }),
  ...(["category", "type"] as const).map((column) =>
    html.label(
      [html.Class("flex items-center gap-2 text-sm")],
      [
        html.input([
          html.Type("checkbox"),
          html.Checked(column === "category" ? model.categoryVisible : model.typeVisible),
          html.OnClick(Message.ToggledColumn({ column })),
        ]),
        column === "category" ? "Categoría" : "Tipo",
      ]
    )
  ),
];
export const workspaceToolbar = ({
  model,
  html,
}: Readonly<{ model: Model; html: Builder }>): ReadonlyArray<Html> => [
  choice({
    html,
    label: "Filtrar por tipo",
    value: model.filters.direction,
    disabled: model.working,
    changed: (value) => Message.Filtered({ field: "direction", value }),
    options: [
      { value: "all", label: "Todas las transacciones" },
      { value: "outflow", label: "Gastos" },
      { value: "inflow", label: "Ingresos" },
    ],
  }),
  ...(model.filtersVisible
    ? [
        choice({
          html,
          label: "Filtrar por categoría",
          value: model.filters.categoryId,
          disabled: model.working,
          changed: (value) => Message.Filtered({ field: "categoryId", value }),
          options: [
            { value: "all", label: "Todas las categorías" },
            ...model.query.categories.map((category) => ({
              value: category.id,
              label: category.label,
            })),
          ],
        }),
      ]
    : []),
  ...displayControls(model, html),
  ...(hasTransactionFilters(model.filters)
    ? [
        html.button(
          [
            html.Type("button"),
            html.Disabled(model.working),
            html.OnClick(Message.ClearedFilters()),
            html.Class(buttonVariants({ variant: "ghost" })),
          ],
          ["Limpiar filtros"]
        ),
      ]
    : []),
];
const searchControls = ({
  model,
  html,
  disabled,
}: Readonly<{ model: Model; html: Builder; disabled: boolean }>): ReadonlyArray<Html> => [
  html.input([
    html.Type("search"),
    html.AriaLabel("Buscar transacciones"),
    html.Value(model.filters.search),
    html.Disabled(disabled),
    html.Class("h-9 rounded-md border px-3"),
    html.OnInput((value) => Message.Filtered({ field: "search", value })),
  ]),
  html.input([
    html.Type("date"),
    html.AriaLabel("Filtrar por fecha"),
    html.Value(model.filters.date),
    html.Disabled(disabled),
    html.Class("h-9 rounded-md border px-3"),
    html.OnInput((value) => Message.Filtered({ field: "date", value })),
  ]),
];
export const workspaceHeader = ({
  model,
  html,
}: Readonly<{ model: Model; html: Builder }>): Html => {
  const disabled =
    !transactionsEditable(model) || ["Capture", "Correction", "Bulk"].includes(model.panel);
  const action = (
    configuration: Readonly<{ label: string; message: Message; primary: boolean }>
  ): Html =>
    html.button(
      [
        html.Type("button"),
        html.Disabled(disabled),
        html.OnClick(configuration.message),
        html.Class(
          buttonVariants({ variant: configuration.primary === true ? "default" : "outline" })
        ),
      ],
      [configuration.label]
    );
  return html.header(
    [html.Class("flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4")],
    [
      html.h1(
        [html.Class("font-heading text-3xl font-semibold tracking-tight")],
        ["Transacciones"]
      ),
      html.span([html.Class("sr-only")], [`${model.query.monthLabel} · ${model.query.timeZone}`]),
      html.div(
        [html.Class("flex flex-wrap items-center gap-2")],
        [
          ...searchControls({ model, html, disabled }),
          action({ label: "Filtros", message: Message.ToggledFilters(), primary: false }),
          html.button(
            [
              html.Type("button"),
              html.Disabled(model.working || model.query.waiting),
              html.OnClick(Message.Refresh()),
              html.Class(buttonVariants({ variant: "ghost" })),
            ],
            ["Actualizar transacciones"]
          ),
          action({ label: "+ Registrar", message: Message.Capture(), primary: true }),
        ]
      ),
    ]
  );
};
