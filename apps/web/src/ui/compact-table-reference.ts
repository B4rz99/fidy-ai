import type { Html, HtmlBuilder } from "foldkit/html";
import type { Message } from "./reference-model";

const examples = [
  { name: "Mi agente personal para reportes mensuales", created: "01-10-2026", used: "10-10-2026" },
  { name: "Agente de prueba", created: "09-10-2026", used: "Nunca" },
];
/** Synthetic metadata demonstrates compact density and contained scrolling. */
export const compactTableReference = (html: HtmlBuilder<Message>): Html =>
  html.section(
    [html.AriaLabelledBy("compact-table-heading"), html.Class("flex min-w-0 flex-col gap-4")],
    [
      html.h2(
        [html.Id("compact-table-heading"), html.Class("text-2xl font-semibold tracking-tight")],
        ["Tablas de administración"]
      ),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        [
          "Nombres largos se ajustan; las fechas permanecen legibles. En pantallas pequeñas, desplaza solo la tabla.",
        ]
      ),
      html.div([html.Class("overflow-x-auto")], [compactTable(html)]),
    ]
  );

const compactTable = (html: HtmlBuilder<Message>): Html =>
  html.table(
    [html.Class("w-full min-w-96 table-fixed text-sm")],
    [
      html.thead(
        [],
        [
          html.tr(
            [],
            ["Nombre", "Permisos", "Creado el", "Último uso"].map((label) =>
              html.th([html.Scope("col"), html.Class("px-4 py-2 text-left")], [label])
            )
          ),
        ]
      ),
      html.tbody(
        [],
        examples.map((example) =>
          html.tr(
            [html.Key(example.name), html.Class("border-t")],
            [
              html.td([html.Class("break-words px-4 py-2 font-semibold")], [example.name]),
              html.td(
                [html.Class("px-4 py-2")],
                [
                  html.span(
                    [html.Class("rounded-md bg-secondary px-2 py-1 text-secondary-foreground")],
                    ["Lectura"]
                  ),
                ]
              ),
              html.td([html.Class("px-4 py-2")], [example.created]),
              html.td([html.Class("px-4 py-2")], [example.used]),
            ]
          )
        )
      ),
    ]
  );
