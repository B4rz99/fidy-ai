import { Option, Schema } from "effect";
import { type DashboardEdit, type Placement, Widget } from "../../../src/core/dashboard/contract";

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const widgetJson = Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(Widget)));

const describePlacement = (placement: Placement): string => {
  if (placement === "top") return "al inicio del Dashboard";

  if (placement === "bottom") return "al final del Dashboard";
  const side = placement.side === "before" ? "antes" : "después";
  const axis = placement.axis === "row" ? "en fila" : "en columna";

  return `${side} del widget ${placement.besideWidget}, ${axis}`;
};

const describeSize = (size: Extract<DashboardEdit, { op: "resize-region" }>["size"]): string => {
  const ratios = {
    "one-quarter": "1/4",
    "one-third": "1/3",
    "one-half": "1/2",
    "two-thirds": "2/3",
    "three-quarters": "3/4",
  } as const;

  return size.kind === "weight"
    ? `peso relativo ${size.weight}`
    : `proporción ${ratios[size.ratio]} respecto a sus regiones hermanas`;
};

const describeEdit = (edit: DashboardEdit): string => {
  switch (edit.op) {
    case "set-title":
      return `Cambiar el título del Dashboard a ${quoted(edit.title)}.`;
    case "add-widget":
      return `Añadir el widget ${widgetJson(edit.widget)} ${describePlacement(edit.at)}.`;
    case "remove-widget":
      return `Eliminar del Dashboard el widget ${edit.widgetId}.`;
    case "move-widget":
      return `Mover el widget ${edit.widgetId} ${describePlacement(edit.at)}, sin cambiar su configuración.`;
    case "swap-widgets":
      return `Intercambiar las posiciones de los widgets ${edit.widgetId} y ${edit.withWidgetId}.`;
    case "resize-region":
      return `Cambiar el tamaño de la región con los widgets [${edit.widgetIds.join(", ")}] a ${describeSize(edit.size)}.`;
    case "update-widget":
      return `Reemplazar toda la configuración del widget ${edit.widget.id}, sin moverlo, por ${widgetJson(edit.widget)}.`;
  }
};

export const describeDashboardEffect = ({
  edit,
  firstEdit,
}: {
  edit: Option.Option<DashboardEdit>;
  firstEdit: boolean;
}): string =>
  Option.match(edit, {
    onNone: () => "Inicializar el Dashboard predeterminado.",
    onSome: (edit) =>
      `${firstEdit ? "Inicializar el Dashboard predeterminado y aplicar este cambio: " : ""}${describeEdit(edit)}`,
  });
