import { Effect, Option, Schema } from "effect";
import {
  type DashboardDocument,
  type DashboardEdit,
  type Placement,
  Widget,
  WidgetId,
} from "../../../src/core/dashboard/contract";
import { categoryIds } from "../../../src/core/categories/contract";
import {
  collectDashboardCategoryReferences,
  makeDefaultDashboard,
} from "../../../src/core/dashboard/operations";
import { DashboardGroup } from "../../../src/shell/dashboard/contract";
import { getOperationPolicy } from "../../../src/shell/canonical-policy/contract";
import { type TransactionCaller, isOAuthCaller } from "../../canonical-work/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import type { DashboardMutationOperation } from "../contract";

// Fixed identities keep first-edit review/resume stable; WidgetIds are document-local.
export const oauthDefaultDashboard = (): DashboardDocument =>
  makeDefaultDashboard({
    restaurantCategoryId: categoryIds.restaurantes,
    widgetIds: [
      WidgetId.make("98800000-0000-4000-8000-000000000001"),
      WidgetId.make("98800000-0000-4000-8000-000000000002"),
      WidgetId.make("98800000-0000-4000-8000-000000000003"),
      WidgetId.make("98800000-0000-4000-8000-000000000004"),
    ],
  });

const Revision = Schema.fromJsonString(
  Schema.Union([
    Schema.TaggedStruct("Absent", {}),
    Schema.TaggedStruct("Present", { revision: Schema.Int, document: Schema.String }),
  ])
);

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

const describeEffect = (edit: Option.Option<DashboardEdit>, firstEdit: boolean): string =>
  Option.match(edit, {
    onNone: () => "Inicializar el Dashboard predeterminado.",
    onSome: (edit) =>
      `${firstEdit ? "Inicializar el Dashboard predeterminado y aplicar este cambio: " : ""}${describeEdit(edit)}`,
  });

export const dashboardOAuthReview = (
  input: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    operation: DashboardMutationOperation;
    existing: Option.Option<Readonly<{ revision: number; encoded: string }>>;
    document: DashboardDocument;
    edit: Option.Option<DashboardEdit>;
  }>
): Effect.Effect<Option.Option<OAuthMutationReview>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const endpoint =
      input.operation === "dashboard.applyDashboardEdit"
        ? DashboardGroup.endpoints.applyDashboardEdit
        : DashboardGroup.endpoints.initializeDashboard;
    if (
      !isOAuthCaller(input.subject) ||
      getOperationPolicy(endpoint).agentConfirmation !== "required"
    ) {
      return Option.none();
    }
    const references = [
      ...new Set(collectDashboardCategoryReferences(input.document).map((item) => item.categoryId)),
    ];
    const guard = Option.isSome(input.existing)
      ? {
          sql: "SELECT 1 FROM dashboard_documents WHERE user_id = ? AND revision = ? AND document_json = ?",
          params: [
            input.subject.userId,
            input.existing.value.revision,
            input.existing.value.encoded,
          ],
        }
      : {
          sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM dashboard_documents WHERE user_id = ?)",
          params: [input.subject.userId],
        };
    return Option.some(
      oauthMutationReview({
        db: input.db,
        revision: yield* Schema.encodeEffect(Revision)(
          Option.isSome(input.existing)
            ? {
                _tag: "Present",
                revision: input.existing.value.revision,
                document: input.existing.value.encoded,
              }
            : { _tag: "Absent" }
        ),
        effect: describeEffect(input.edit, Option.isNone(input.existing)),
        guard: {
          sql: `${guard.sql} ${references.map(() => "AND EXISTS (SELECT 1 FROM categories WHERE id = ?)").join(" ")}`,
          params: [...guard.params, ...references],
        },
      })
    );
  });
