import { CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import type { Html, HtmlBuilder } from "foldkit/html";
import { buttonVariants } from "./button-variants";
import { icon } from "./icon";
import type { Message } from "./reference-model";

export const inputClass =
  "min-h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:bg-muted aria-invalid:border-foreground aria-invalid:ring-3 aria-invalid:ring-ring";
const feedbackClass = {
  success: "bg-success text-on-pastel",
  warning: "bg-warning text-on-pastel",
  destructive: "bg-destructive text-destructive-foreground",
  information: "bg-information text-on-pastel",
  pending: "bg-pending text-on-pastel",
};
const palette = [
  { name: "Acción principal", fill: "bg-primary", ink: "text-primary-foreground" },
  { name: "Superficie cálida", fill: "bg-secondary", ink: "text-secondary-foreground" },
  { name: "Guardado", fill: "bg-success", ink: "text-on-pastel" },
  { name: "Atención", fill: "bg-warning", ink: "text-on-pastel" },
  { name: "Error", fill: "bg-destructive", ink: "text-destructive-foreground" },
  { name: "Información", fill: "bg-information", ink: "text-on-pastel" },
  { name: "Por revisar", fill: "bg-pending", ink: "text-on-pastel" },
];
const feedback = [
  {
    variant: "success",
    title: "Transacción registrada",
    description: "Ya puedes verla en tu historial.",
  },
  {
    variant: "warning",
    title: "Revisa el historial antes de intentarlo de nuevo",
    description: "No pudimos confirmar si la transacción se guardó.",
  },
  {
    variant: "destructive",
    title: "No pudimos guardar la transacción",
    description: "Tus datos siguen en el formulario. Revísalos e intenta de nuevo.",
  },
  {
    variant: "information",
    title: "Estas cifras son un ejemplo",
    description: "Esta referencia no consulta ni cambia tus datos.",
  },
  {
    variant: "pending",
    title: "Transacción por revisar",
    description: "Hace falta confirmar los datos antes de registrarla.",
  },
] as const;
type Builder = HtmlBuilder<Message>;
const panel = ({
  html,
  title,
  children,
}: Readonly<{ html: Builder; title: string; children: ReadonlyArray<Html | string> }>): Html =>
  html.section(
    [
      html.Class(
        "flex flex-col gap-4 overflow-hidden rounded-xl bg-card py-4 text-card-foreground ring-1 ring-foreground/10"
      ),
    ],
    [
      html.h2([html.Class("px-4 font-heading text-lg leading-snug font-semibold")], [title]),
      html.div([html.Class("flex flex-col gap-5 px-4")], children),
    ]
  );
const actions = (html: Builder): Html =>
  panel({
    html,
    title: "Acciones claras",
    children: [
      html.p([html.Class("text-muted-foreground")], ["Una acción principal. El resto acompaña."]),
      html.div(
        [html.Class("flex flex-wrap items-center gap-3")],
        [
          html.button(
            [html.Type("button"), html.Class(buttonVariants())],
            ["Registrar transacción"]
          ),
          html.button(
            [html.Type("button"), html.Class(buttonVariants({ variant: "outline" }))],
            ["Cancelar"]
          ),
          html.button(
            [html.Type("button"), html.Class(buttonVariants({ variant: "link" }))],
            ["Ver historial"]
          ),
        ]
      ),
      html.div(
        [html.Class("flex flex-wrap items-center gap-3")],
        [
          html.button([html.Disabled(true), html.Class(buttonVariants())], ["Guardando…"]),
          html.button(
            [html.Disabled(true), html.Class(buttonVariants({ variant: "outline" }))],
            ["Acción no disponible"]
          ),
        ]
      ),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        ["Ejemplos visuales: estos botones no registran transacciones."]
      ),
    ],
  });
const fields = (html: Builder): Html =>
  panel({
    html,
    title: "Campos que orientan",
    children: [
      html.div(
        [html.Class("flex flex-col gap-2")],
        [
          html.label([html.For("reference-amount")], ["Monto en COP"]),
          html.input([
            html.Id("reference-amount"),
            html.InputMode("decimal"),
            html.Placeholder("28000"),
            html.AriaDescribedBy("reference-amount-help"),
            html.Class(inputClass),
          ]),
          html.p(
            [html.Id("reference-amount-help"), html.Class("text-sm text-muted-foreground")],
            ["Ejemplo: 28000 para una transacción de $28.000 COP."]
          ),
        ]
      ),
      html.div(
        [html.Class("flex flex-col gap-2")],
        [
          html.label([html.For("reference-error")], ["Monto con error"]),
          html.input([
            html.Id("reference-error"),
            html.Value("0"),
            html.Attribute("aria-invalid", "true"),
            html.AriaDescribedBy("reference-error-help"),
            html.Class(inputClass),
          ]),
          html.p(
            [
              html.Id("reference-error-help"),
              html.Class("rounded-lg bg-destructive p-3 text-sm text-destructive-foreground"),
            ],
            ["Ingresa un monto mayor que cero."]
          ),
        ]
      ),
    ],
  });
const paletteExamples = (html: Builder): Html =>
  html.section(
    [html.AriaLabelledBy("palette-heading"), html.Class("flex flex-col gap-4")],
    [
      html.h2(
        [html.Id("palette-heading"), html.Class("text-2xl font-semibold tracking-tight")],
        ["Color con propósito"]
      ),
      html.div(
        [html.Class("grid gap-3 sm:grid-cols-2 lg:grid-cols-4")],
        palette.map(({ name, fill, ink }) =>
          html.div(
            [
              html.Key(name),
              html.Class(
                `flex min-h-24 items-end rounded-lg border p-4 text-sm font-semibold ${fill} ${ink}`
              ),
            ],
            [name]
          )
        )
      ),
    ]
  );
const feedbackExamples = (html: Builder): Html =>
  html.section(
    [html.AriaLabelledBy("feedback-heading"), html.Class("flex flex-col gap-4")],
    [
      html.h2(
        [html.Id("feedback-heading"), html.Class("text-2xl font-semibold tracking-tight")],
        ["Cada estado explica qué sigue"]
      ),
      html.div(
        [html.Class("grid gap-4 md:grid-cols-2")],
        feedback.map(({ variant, title, description }) =>
          html.div(
            [
              html.Key(variant),
              html.Role("note"),
              html.Class(`flex gap-3 rounded-lg p-4 ${feedbackClass[variant]}`),
            ],
            [
              icon({
                html,
                data: variant === "success" ? CheckmarkCircle02Icon : InformationCircleIcon,
                size: 20,
                className: "shrink-0",
              }),
              html.div(
                [],
                [
                  html.h3([html.Class("font-semibold")], [title]),
                  html.p([html.Class("text-sm")], [description]),
                ]
              ),
            ]
          )
        )
      ),
    ]
  );
const transaction = (html: Builder): Html =>
  panel({
    html,
    title: "Transacciones fáciles de leer",
    children: [
      html.div(
        [html.Class("flex flex-wrap items-center justify-between gap-4 border-b pb-4")],
        [
          html.div(
            [],
            [
              html.p([html.Class("font-semibold")], ["La Cocina"]),
              html.p(
                [html.Class("text-sm text-muted-foreground")],
                ["Restaurantes · 9 de octubre de 2026"]
              ),
            ]
          ),
          html.div(
            [html.Class("flex flex-col items-end gap-2")],
            [
              html.p([html.Class("font-semibold tabular-nums")], ["− COP 28.000,00"]),
              html.span([html.Class("rounded-md border px-2 py-1 text-sm")], ["Gasto"]),
            ]
          ),
        ]
      ),
      html.p(
        [html.Class("text-sm text-muted-foreground")],
        ["El signo y la etiqueta explican la dirección. Un gasto normal no es un error."]
      ),
    ],
  });
const empty = (html: Builder): Html =>
  panel({
    html,
    title: "Vacío y carga son estados distintos",
    children: [
      html.div(
        [html.Class("flex flex-col items-center gap-2 rounded-lg border p-6")],
        [
          html.h3([html.Class("font-semibold")], ["Aún no hay transacciones este mes"]),
          html.p(
            [html.Class("text-sm text-muted-foreground")],
            ["Registra tu primera transacción para empezar a ver tu historial."]
          ),
        ]
      ),
      html.div(
        [html.AriaLabel("Ejemplo de carga"), html.Class("flex flex-col gap-3")],
        [
          html.p([html.Class("text-sm text-muted-foreground")], ["Cargando transacciones…"]),
          html.div([html.Class("h-16 w-full animate-pulse rounded-lg bg-muted")], []),
          html.div([html.Class("h-16 w-full animate-pulse rounded-lg bg-muted")], []),
        ]
      ),
    ],
  });
export const referenceExamples = (html: Builder): ReadonlyArray<Html> => [
  paletteExamples(html),
  html.div([html.Class("grid gap-6 lg:grid-cols-2")], [actions(html), fields(html)]),
  feedbackExamples(html),
  html.div([html.Class("grid gap-6 lg:grid-cols-2")], [transaction(html), empty(html)]),
];
