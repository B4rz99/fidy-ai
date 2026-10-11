import type { Html } from "foldkit/html";
import { buttonVariants } from "./button-variants";
import { inputClass } from "./reference-examples";
import { Message, type ViewConfiguration } from "./reference-model";

const categories = [
  { value: "restaurants", label: "Restaurantes" },
  { value: "groceries", label: "Mercado" },
];
const categoryChoice = ({ html, model }: ViewConfiguration): Html =>
  html.div(
    [html.Class("flex flex-col gap-2")],
    [
      html.label([html.For("reference-category-filter")], ["Categoría de ejemplo"]),
      html.select(
        [
          html.Id("reference-category-filter"),
          html.Class(inputClass),
          html.Value(model.category),
          html.OnChange((value) => Message.Field({ field: "category", value })),
        ],
        categories.map(({ value, label }) => html.option([html.Value(value)], [label]))
      ),
      html.label([html.For("reference-category-inline")], ["Cambiar categoría del ejemplo"]),
      html.select(
        [
          html.Id("reference-category-inline"),
          html.Class(inputClass),
          html.Value(model.category),
          html.OnChange((value) => Message.Field({ field: "category", value })),
        ],
        categories.map(({ value, label }) => html.option([html.Value(value)], [label]))
      ),
    ]
  );
/** Interactive examples own only local search, date and category drafts. */
export const workspaceReference = (configuration: ViewConfiguration): Html => {
  const { html } = configuration;
  return html.section(
    [html.AriaLabel("Patrones de aplicación"), html.Class("overflow-hidden rounded-xl border")],
    [
      referenceHeader(configuration),
      html.div(
        [html.Class("grid gap-6 p-4 lg:grid-cols-[1fr_20rem]")],
        [
          html.div(
            [],
            [
              categoryChoice(configuration),
              html.button(
                [html.Disabled(true), html.Class(buttonVariants({ variant: "outline" }))],
                ["Editar varias"]
              ),
              html.div(
                [html.Class("mt-4 flex flex-wrap gap-4")],
                [
                  html.span([], ["↓ Gasto · $ 28.000,00"]),
                  html.span([], ["↑ Ingreso · $ 50.000,00"]),
                ]
              ),
              html.p(
                [html.Class("mt-4 text-sm text-muted-foreground")],
                ["La búsqueda y las selecciones permanecen en esta referencia."]
              ),
            ]
          ),
          html.aside(
            [html.AriaLabel("Resumen del ejemplo"), html.Class("rounded-lg border p-4")],
            [
              html.h3([html.Class("text-2xl font-semibold")], ["Resumen"]),
              html.p(
                [html.Class("mt-4 text-muted-foreground")],
                ["Ejemplos locales. Ningún control cambia tus datos."]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};

const referenceHeader = (configuration: ViewConfiguration): Html => {
  const { html, model } = configuration;
  return html.header(
    [html.Class("flex flex-wrap items-center gap-4 border-b p-4")],
    [
      html.h2([html.Class("mr-auto text-2xl font-semibold")], ["Patrones de aplicación"]),
      html.input([
        html.Type("search"),
        html.AriaLabel("Buscar en el ejemplo"),
        html.Class(inputClass),
        html.Value(model.search),
        html.OnInput((value) => Message.Field({ field: "search", value })),
      ]),
      html.div(
        [],
        [
          html.label([html.For("reference-calendar")], ["Fecha del ejemplo"]),
          html.input([
            html.Type("date"),
            html.Id("reference-calendar"),
            html.Class(inputClass),
            html.Value(model.date),
            html.OnInput((value) => Message.Field({ field: "date", value })),
          ]),
        ]
      ),
    ]
  );
};
