import type { Html } from "foldkit/html";
import { buttonVariants } from "./button-variants";
import { darkPalettes } from "./dark-palettes";
import { Message, type ViewConfiguration } from "./reference-model";
import { referenceExamples } from "./reference-examples";
import { workspaceReference } from "./workspace-reference";
import { compactTableReference } from "./compact-table-reference";

const header = ({ html, model }: ViewConfiguration): Html =>
  html.header(
    [html.Class("flex flex-col gap-6 border-b pb-8 sm:flex-row sm:items-start sm:justify-between")],
    [
      html.div(
        [html.Class("flex flex-col gap-3")],
        [
          html.p(
            [html.Class("text-sm text-muted-foreground")],
            ["Fidy · Interfaz de la aplicación"]
          ),
          html.h1(
            [html.Class("font-heading text-3xl font-semibold tracking-tight")],
            ["Tu plata, con claridad."]
          ),
          html.p(
            [html.Class("max-w-xl text-muted-foreground")],
            ["Una base cálida, legible y tranquila para registrar y entender tus transacciones."]
          ),
          html.span(
            [html.Class("rounded-md bg-information px-2 py-1 text-sm text-on-pastel")],
            ["Referencia local · Datos de ejemplo"]
          ),
        ]
      ),
      html.fieldset(
        [html.Class("flex shrink-0 flex-wrap gap-2")],
        [
          html.legend([html.Class("mb-2 text-sm font-semibold")], ["Apariencia"]),
          ...(["light", "dark", "system"] as const).map((theme) =>
            html.button(
              [
                html.Type("button"),
                html.Class(
                  buttonVariants({ variant: model.theme === theme ? "default" : "outline" })
                ),
                html.AriaPressed(String(model.theme === theme)),
                html.OnClick(Message.Theme({ theme })),
              ],
              [{ light: "Claro", dark: "Oscuro", system: "Sistema" }[theme]]
            )
          ),
        ]
      ),
    ]
  );
const palettes = ({ html, model }: ViewConfiguration): Html =>
  html.section(
    [html.AriaLabelledBy("dark-options-heading"), html.Class("flex flex-col gap-4")],
    [
      html.h2(
        [html.Id("dark-options-heading"), html.Class("text-2xl font-semibold tracking-tight")],
        ["Cuatro formas de ver la noche"]
      ),
      html.p(
        [html.Class("max-w-2xl text-muted-foreground")],
        [
          "Compara los mismos elementos en cuatro paletas sin azul. Elige una para verla en toda esta página.",
        ]
      ),
      html.div(
        [html.Class("grid gap-4 sm:grid-cols-2")],
        darkPalettes.map(({ id, name, description }) =>
          palettePreview({ html, model, id, name, description })
        )
      ),
    ]
  );
export const referenceView = (configuration: ViewConfiguration): Html => {
  const { html, model } = configuration;
  const dark = model.theme === "dark" || (model.theme === "system" && model.systemDark);
  return html.div(
    [
      html.DataAttribute("dark-palette", model.palette),
      html.Class(`ui-reference min-h-svh bg-background text-foreground${dark ? " dark" : ""}`),
    ],
    [
      html.main(
        [html.Class("mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 sm:px-6 lg:px-12")],
        [
          header(configuration),
          palettes(configuration),
          ...referenceExamples(html),
          workspaceReference(configuration),
          compactTableReference(html),
          html.p(
            [html.Class("border-t pt-6 text-sm text-muted-foreground")],
            ["Poppins · Texto de lectura de 16 px · Controles principales de 44–48 px"]
          ),
        ]
      ),
    ]
  );
};

const palettePreview = ({
  html,
  model,
  id,
  name,
  description,
}: ViewConfiguration &
  Readonly<{ id: (typeof darkPalettes)[number]["id"]; name: string; description: string }>): Html =>
  html.article(
    [
      html.Key(id),
      html.DataAttribute("dark-palette", id),
      html.AriaLabel(name),
      html.Class("dark flex flex-col gap-5 rounded-xl border bg-background p-5 text-foreground"),
    ],
    [
      html.h3([html.Class("text-lg font-semibold")], [name]),
      html.p([html.Class("text-sm text-muted-foreground")], [description]),
      html.div(
        [
          html.Class(
            "flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4 text-card-foreground"
          ),
        ],
        [
          html.div(
            [],
            [
              html.p([html.Class("font-semibold")], ["La Cocina"]),
              html.p([html.Class("text-sm text-muted-foreground")], ["Restaurantes"]),
            ]
          ),
          html.p([html.Class("font-semibold tabular-nums")], ["− $28.000 COP"]),
        ]
      ),
      html.div(
        [html.Class("flex flex-wrap items-center justify-between gap-3")],
        [
          html.span(
            [html.Class("rounded-md bg-success px-2 py-1 text-sm text-on-pastel")],
            ["Registrada"]
          ),
          html.button(
            [
              html.Type("button"),
              html.AriaLabel(`Probar ${name}`),
              html.AriaPressed(String(model.palette === id)),
              html.Class(buttonVariants({ variant: model.palette === id ? "default" : "outline" })),
              html.OnClick(Message.Palette({ palette: id })),
            ],
            [model.palette === id ? "Viendo esta opción" : "Probar esta opción"]
          ),
        ]
      ),
    ]
  );
