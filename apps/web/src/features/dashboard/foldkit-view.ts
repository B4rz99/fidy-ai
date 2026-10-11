import { GripVerticalIcon, PencilIcon, Tick02Icon, XIcon } from "@hugeicons/core-free-icons";
import { Option } from "effect";
import type { Mount } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { maximumSplitWeight, minimumSplitWeight } from "@/transport/client";
import { buttonVariants } from "@/ui/button-variants";
import { type IconData, icon } from "@/ui/icon";
import type { DashboardDragSource, DashboardDropTarget } from "./drag-data";
import { Message, type Model, canEditDashboard } from "./model";
import type { DashboardLayout, DashboardView, DashboardWidget } from "./presentation";
import { responsiveSplitClass } from "./presentation";
import { widgetContent, widgetTitle } from "./widget-view";

type Builder = HtmlBuilder<Message>;
export type DashboardMounts = Readonly<{
  source: (args: Readonly<{ data: DashboardDragSource }>) => Mount.MountAction<Message>;
  target: (
    args: Readonly<{ data: DashboardDropTarget; depth: number }>
  ) => Mount.MountAction<Message>;
  resize: (
    args: Readonly<{
      axis: "row" | "column";
      weight: number;
      adjacentWeight: number;
      widgetIds: ReadonlyArray<DashboardWidget["id"]>;
    }>
  ) => Mount.MountAction<Message>;
}>;
type Configuration = Readonly<{
  targetLabel: Option.Option<string>;
  model: Model;
  html: Builder;
  mounts: DashboardMounts;
}>;
const iconSize = 16;
const maximumWidgetTitleLength = 80;
const dropClasses = {
  top: "inset-x-0 top-0 h-1/4",
  right: "inset-y-1/4 right-0 w-1/4",
  bottom: "inset-x-0 bottom-0 h-1/4",
  left: "inset-y-1/4 left-0 w-1/4",
  center: "inset-1/4",
};
const dropLabels = {
  top: "arriba de",
  right: "a la derecha de",
  bottom: "debajo de",
  left: "a la izquierda de",
  center: "sobre",
};
const editing = (model: Model): boolean => model.editing && model.query.status === "Ready";
const control = (
  configuration: Readonly<{
    html: Builder;
    label: string;
    data: IconData;
    message: Message;
    disabled: boolean;
  }>
): Html => {
  const { html, label, data, message, disabled } = configuration;
  return html.button(
    [
      html.Type("button"),
      html.AriaLabel(label),
      html.Disabled(disabled),
      html.OnClick(message),
      html.Class(buttonVariants({ variant: "ghost", size: "icon" })),
    ],
    [icon({ html, data, size: iconSize, className: "size-4" })]
  );
};
const source = (configuration: Configuration, data: DashboardDragSource, label: string): Html => {
  const { html, model, mounts } = configuration;
  return html.button(
    [
      html.Type("button"),
      html.AriaLabel(label),
      html.Disabled(!canEditDashboard(model)),
      html.Class(
        "inline-flex size-8 touch-none items-center justify-center rounded-md border bg-background focus-visible:ring-2 focus-visible:ring-ring"
      ),
      html.OnMount(mounts.source({ data })),
    ],
    [icon({ html, data: GripVerticalIcon, size: iconSize, className: "size-4" })]
  );
};
const dropClass = (data: DashboardDropTarget): string => {
  if (data.kind === "widget-edge") return dropClasses[data.edge];
  return data.edge === "top" ? "inset-x-0 top-0 h-16" : "inset-x-0 bottom-0 h-16";
};
const target = (configuration: Configuration, data: DashboardDropTarget, depth: number): Html => {
  const { html, mounts } = configuration;
  const classes = dropClass(data);
  const label = Option.getOrElse(configuration.targetLabel, () =>
    data.kind === "widget-edge"
      ? `Colocar ${dropLabels[data.edge]} Widget`
      : `Colocar al ${data.edge === "top" ? "inicio" : "final"} del tablero`
  );
  return html.section(
    [
      html.Key(`${data.kind}-${data.edge}`),
      html.AriaLabel(label),
      html.Class(`dashboard-drop-zone pointer-events-none absolute z-20 ${classes}`),
      html.OnMount(mounts.target({ data, depth })),
    ],
    [
      html.span([
        html.AriaHidden(true),
        html.Class(
          "absolute inset-1 rounded-lg border-2 border-transparent bg-primary/10 opacity-0"
        ),
      ]),
    ]
  );
};
const titleEditor = (configuration: Configuration, widget: DashboardWidget): Html => {
  const { html, model } = configuration;
  const disabled = !canEditDashboard(model);
  return html.form(
    [
      html.AriaLabel(`Renombrar ${widgetTitle(widget)}`),
      html.Class("flex min-w-0 items-center gap-1"),
      html.OnSubmit(Message.SaveTitle()),
    ],
    [
      html.input([
        html.Type("text"),
        html.AriaLabel("Nuevo nombre del Widget"),
        html.Value(model.titleDraft),
        html.Maxlength(maximumWidgetTitleLength),
        html.Disabled(disabled),
        html.OnInput((title) => Message.ChangedTitle({ title })),
        html.OnKeyDownPreventDefault((key) =>
          key === "Escape" ? Option.some(Message.CancelTitle()) : Option.none()
        ),
        html.Class("min-w-0 rounded-md border px-2 py-1"),
      ]),
      html.button(
        [
          html.Type("submit"),
          html.AriaLabel("Guardar nombre del Widget"),
          html.Disabled(disabled || model.titleDraft.trim().length === 0),
          html.Class(buttonVariants({ variant: "ghost", size: "icon" })),
        ],
        [icon({ html, data: Tick02Icon, size: iconSize, className: "size-4" })]
      ),
    ]
  );
};
const widgetActions = (configuration: Configuration, widget: DashboardWidget): Html => {
  const { html, model } = configuration;
  const label = widgetTitle(widget);
  return html.div(
    [html.Class("absolute right-3 top-3 z-40 flex")],
    [
      control({
        html,
        label: `Renombrar ${label}`,
        data: PencilIcon,
        message: Message.Rename({ id: widget.id, title: label }),
        disabled: !canEditDashboard(model),
      }),
      control({
        html,
        label: `Eliminar ${label}`,
        data: XIcon,
        message: Message.RequestedEdit({ edit: { op: "remove-widget", widgetId: widget.id } }),
        disabled: !canEditDashboard(model),
      }),
    ]
  );
};
type LayoutConfiguration = Configuration &
  Readonly<{ layout: DashboardLayout; context: DashboardView["context"]; depth: number }>;
const leaf = (
  configuration: LayoutConfiguration &
    Readonly<{ layout: Extract<DashboardLayout, { kind: "leaf" }> }>
): Html => {
  const { layout, context, depth } = configuration;
  const { html, model } = configuration;
  const { widget } = layout.widget;
  const active = editing(model);
  return html.section(
    [
      html.Key(widget.id),
      html.Class(
        "relative flex min-h-72 min-w-0 flex-1 flex-col rounded-xl border bg-card shadow-sm"
      ),
    ],
    [
      ...(active
        ? [
            html.div(
              [html.Class("absolute left-3 top-3 z-30")],
              [
                source(
                  configuration,
                  { kind: "widget", widgetId: widget.id, label: widgetTitle(widget) },
                  `Arrastrar ${widgetTitle(widget)}`
                ),
              ]
            ),
            widgetActions(configuration, widget),
          ]
        : []),
      ...(active
        ? (["top", "right", "bottom", "left", "center"] as const).map((edge) =>
            target(
              {
                ...configuration,
                targetLabel: Option.some(`Colocar ${dropLabels[edge]} ${widgetTitle(widget)}`),
              },
              { kind: "widget-edge", widgetId: widget.id, edge },
              depth + 1
            )
          )
        : []),
      html.header(
        [html.Class(active ? "px-14 pr-28 pt-5" : "px-5 pt-5")],
        [
          Option.contains(model.renaming, widget.id)
            ? titleEditor(configuration, widget)
            : html.h2([html.Class("font-semibold")], [widgetTitle(widget)]),
        ]
      ),
      html.div(
        [html.Class("min-w-0 flex-1 p-5")],
        [widgetContent({ view: layout.widget, context, html })]
      ),
    ]
  );
};
const widgets = (layout: DashboardLayout): ReadonlyArray<DashboardWidget> =>
  layout.kind === "leaf"
    ? [layout.widget.widget]
    : layout.children.flatMap(({ node }) => widgets(node));
const layoutKey = (layout: DashboardLayout): string =>
  layout.kind === "leaf" ? layout.widget.widget.id : layoutKey(layout.children[0].node);
const resizeBoundary = (
  configuration: Configuration,
  layout: Extract<DashboardLayout, { kind: "split" }>,
  index: number
): Html => {
  const { html, model, mounts } = configuration;
  const child = layout.children[index];
  const following = layout.children[index + 1];
  if (child === undefined || following === undefined) return html.span([]);
  const members = widgets(child.node);
  const label = members[0] === undefined ? "Widget" : widgetTitle(members[0]);
  return html.hr([
    html.Key(
      `resize-${layout.axis}-${members.map(({ id }) => id).join("-")}-${child.weight}-${following.weight}`
    ),
    html.AriaLabel(`Redimensionar límite después de ${label}`),
    html.AriaDisabled(!canEditDashboard(model)),
    html.AriaOrientation(layout.axis === "row" ? "vertical" : "horizontal"),
    html.AriaValuemax(maximumSplitWeight),
    html.AriaValuemin(minimumSplitWeight),
    html.AriaValuenow(child.weight),
    html.Tabindex(canEditDashboard(model) ? 0 : -1),
    html.Class(
      layout.axis === "row"
        ? "pointer-events-none h-4 w-full flex-none touch-none border-0 bg-transparent focus-visible:ring-2 md:pointer-events-auto md:h-auto md:w-4 md:cursor-col-resize"
        : "h-4 w-full flex-none cursor-row-resize touch-none border-0 bg-transparent focus-visible:ring-2"
    ),
    html.OnMount(
      mounts.resize({
        axis: layout.axis,
        weight: child.weight,
        adjacentWeight: following.weight,
        widgetIds: members.map(({ id }) => id),
      })
    ),
  ]);
};
const responsiveLayout = (configuration: LayoutConfiguration): Html => {
  const { layout, context, depth } = configuration;
  const { html, model } = configuration;
  if (layout.kind === "leaf") return leaf({ ...configuration, layout });
  return html.div(
    [
      html.Key(`split-${layoutKey(layout)}`),
      html.Class(
        `flex min-h-0 min-w-0 flex-1 ${editing(model) ? "gap-0" : "gap-4"} ${responsiveSplitClass(layout.axis)}`
      ),
    ],
    layout.children.flatMap(({ node, weight }, index) => [
      html.div(
        [
          html.Key(layoutKey(node)),
          html.Class(
            "relative flex min-h-0 min-w-0 flex-none flex-col md:[flex:var(--dashboard-weight)_1_0%]"
          ),
          html.DataAttribute("testid", `responsive-weight-${weight}`),
          html.Style({ "--dashboard-weight": String(weight) }),
        ],
        [responsiveLayout({ ...configuration, layout: node, context, depth: depth + 1 })]
      ),
      ...(editing(model) && index < layout.children.length - 1
        ? [resizeBoundary(configuration, layout, index)]
        : []),
    ])
  );
};
const catalogTray = (configuration: Configuration): Html => {
  const { html, model } = configuration;
  return html.section(
    [html.Key("catalog"), html.Class("grid gap-3 rounded-xl border p-4")],
    [
      html.h2([html.Class("font-medium")], ["Widgets disponibles"]),
      html.ul(
        [
          html.AriaLabel("Widgets disponibles para arrastrar"),
          html.Class("grid gap-2 sm:grid-cols-2 lg:grid-cols-4"),
        ],
        model.query.catalog.map((entry) =>
          html.li(
            [
              html.Key(entry.id),
              html.Class("flex items-center justify-between gap-3 rounded-lg border bg-card p-3"),
            ],
            [
              html.div(
                [],
                [
                  html.span([html.Class("block text-sm font-medium")], [entry.name]),
                  html.span(
                    [html.Class("block text-xs text-muted-foreground")],
                    [entry.description]
                  ),
                ]
              ),
              source(configuration, { kind: "catalog", entry }, `Arrastrar ${entry.name}`),
            ]
          )
        )
      ),
    ]
  );
};
const refreshButton = ({
  html,
  model,
  label,
  catalog,
}: Readonly<{ html: Builder; model: Model; label: string; catalog: boolean }>): Html =>
  html.button(
    [
      html.Type("button"),
      html.Disabled(catalog ? model.query.catalogWaiting : model.query.waiting || model.submitting),
      html.OnClick(catalog ? Message.RefreshCatalog() : Message.Refresh()),
      html.Class(buttonVariants({ variant: "outline" })),
    ],
    [label]
  );
const editNotice = (configuration: Configuration): Html => {
  const { html, model } = configuration;
  const uncertain = model.error === "Uncertain";
  return html.div(
    [
      html.Key("edit-error"),
      html.Role("alert"),
      html.Class("rounded-lg border border-destructive p-4"),
    ],
    [
      html.h2([], [uncertain ? "No pudimos confirmar el cambio" : "No pudimos guardar el cambio"]),
      html.p(
        [],
        [
          uncertain
            ? "El cambio podría haberse guardado. Actualiza el tablero y revísalo antes de intentar otro cambio."
            : "El cambio fue rechazado. Revisa los valores e intenta de nuevo.",
        ]
      ),
      ...(uncertain
        ? [refreshButton({ html, model, label: "Actualizar tablero", catalog: false })]
        : []),
    ]
  );
};
const notices = (configuration: Configuration): ReadonlyArray<Html> => {
  const { html, model } = configuration;
  return [
    ...(model.error !== "None" ? [editNotice(configuration)] : []),
    ...(model.query.stale
      ? [
          html.div(
            [html.Key("stale"), html.Role("alert")],
            [
              html.p(
                [],
                ["No pudimos actualizar el tablero. Mostramos el último tablero disponible."]
              ),
              refreshButton({
                html,
                model,
                label: "Reintentar actualización del tablero",
                catalog: false,
              }),
            ]
          ),
        ]
      : []),
    ...(model.query.catalogFailed
      ? [
          html.div(
            [html.Key("catalog-error"), html.Role("alert")],
            [
              html.p(
                [],
                ["No pudimos cargar el catálogo. Los demás controles siguen disponibles."]
              ),
              refreshButton({ html, model, label: "Reintentar carga del catálogo", catalog: true }),
            ]
          ),
        ]
      : []),
    ...(model.query.waiting
      ? [html.p([html.Key("waiting"), html.Role("status")], ["Actualizando tablero…"])]
      : []),
    ...(model.query.catalogWaiting
      ? [
          html.p(
            [html.Key("catalog-waiting"), html.Role("status")],
            ["Cargando catálogo del tablero…"]
          ),
        ]
      : []),
  ];
};
const loadingText = (model: Model): string => {
  if (model.query.phase === "initializing") return "Inicializando tablero…";
  return model.query.phase === "reading-initialized"
    ? "Leyendo el tablero inicializado…"
    : "Cargando tablero…";
};
const loadNotice = (configuration: Configuration): Html => {
  const { html, model } = configuration;
  return html.main(
    [html.AriaLabel("Cargando tablero"), html.Class("p-6")],
    [
      model.query.status === "Failed"
        ? html.div(
            [html.Role("alert")],
            [
              html.h1(
                [],
                [
                  model.query.boundaryFailure
                    ? "No pudimos comunicarnos con Fidy"
                    : "No pudimos cargar tu tablero",
                ]
              ),
              ...(model.query.phase === "reading"
                ? []
                : [
                    html.p(
                      [],
                      [
                        model.query.phase === "initializing"
                          ? "No pudimos inicializar el tablero."
                          : "El tablero se inicializó, pero no pudimos leerlo.",
                      ]
                    ),
                  ]),
              refreshButton({ html, model, label: "Reintentar carga del tablero", catalog: false }),
            ]
          )
        : html.p([html.Role("status")], [loadingText(model)]),
    ]
  );
};
const header = (configuration: Configuration, title: string): Html => {
  const { html, model } = configuration;
  return html.header(
    [html.Key("header"), html.Class("flex flex-wrap items-center justify-between gap-4")],
    [
      html.div(
        [],
        [
          html.h1([html.Class("font-heading text-3xl font-semibold tracking-tight")], [title]),
          html.p([html.Class("text-muted-foreground")], ["Lectura actual de tus finanzas."]),
        ]
      ),
      html.button(
        [
          html.Type("button"),
          html.Disabled(model.submitting),
          html.OnClick(Message.ToggleEditing()),
          html.Class(buttonVariants({ variant: model.editing ? "outline" : "default" })),
        ],
        [model.editing ? "Guardar" : "Personalizar"]
      ),
    ]
  );
};
/** Native recursive canvas with one canonical read owner and scoped interaction mounts. */
export const dashboardView = (configuration: Configuration): Html => {
  const { html, model } = configuration;
  if (Option.isNone(model.query.view)) return loadNotice(configuration);
  const view = model.query.view.value;
  return html.main(
    [html.Class("flex w-full flex-col gap-5 p-4 sm:p-6")],
    [
      header(configuration, view.title),
      ...notices(configuration),
      ...(editing(model) ? [catalogTray(configuration)] : []),
      html.section(
        [
          html.Key(`canvas-${model.editing}`),
          html.AriaLabel("Diseño responsivo del tablero"),
          html.Class("relative flex min-h-[calc(100svh-9rem)] flex-col"),
        ],
        [
          ...(editing(model)
            ? [target(configuration, { kind: "dashboard-edge", edge: "top" }, 0)]
            : []),
          responsiveLayout({
            ...configuration,
            layout: view.layout,
            context: view.context,
            depth: 0,
          }),
          ...(editing(model)
            ? [target(configuration, { kind: "dashboard-edge", edge: "bottom" }, 0)]
            : []),
        ]
      ),
    ]
  );
};
