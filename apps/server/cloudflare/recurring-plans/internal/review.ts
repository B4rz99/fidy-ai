import { Effect, Option, Schema } from "effect";
import {
  formatWhatsAppCategory,
  formatWhatsAppDate,
  formatWhatsAppMoney,
} from "../../../src/shell/channels/whatsapp/operations";
import { RecurringSeriesPage } from "../../../src/core/recurring/contract";
import {
  type RecurringDocument,
  type RecurringEdit,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { readLocalRecurringSeries } from "../../recurring/operations";

const quote = (text: string): string => `«${text}»`;

const categoryLabel = (id: string): string =>
  Option.getOrElse(formatWhatsAppCategory(id), () => id);

const timeZoneName = (zone: string): string => zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;

const frequencyText: Readonly<Record<RecurringPlanInput["frequency"], string>> = {
  weekly: "cada semana",
  fortnightly: "cada dos semanas",
  "twice-monthly": "dos veces al mes",
  monthly: "cada mes",
  quarterly: "cada tres meses",
  "half-yearly": "cada seis meses",
  yearly: "cada año",
};

const kindText: Readonly<Record<RecurringPlanInput["kind"], string>> = {
  income: "ingreso",
  expense: "gasto",
  transfer: "transferencia",
};

const lifecycleActionText: Readonly<
  Record<Extract<RecurringEdit, { kind: "lifecycle" }>["action"], string>
> = {
  pause: "Pausar",
  resume: "Reactivar",
  stop: "Detener",
};

const suggestionActionText: Readonly<
  Record<Extract<RecurringEdit, { kind: "suggestion" }>["action"], string>
> = {
  dismiss: "Ocultar",
  restore: "Restablecer",
  link: "Vincular",
};

const amountText = (plan: RecurringPlanInput): string =>
  plan.money === undefined
    ? `importe por definir en ${plan.currency}`
    : `${plan.amountMode === "estimated" ? "aproximadamente " : ""}${formatWhatsAppMoney(plan.money)}`;

const scheduleText = (plan: RecurringPlanInput): string =>
  `hora de ${timeZoneName(plan.timeZone)}, desde el ${formatWhatsAppDate(plan.firstDate)}${plan.endDate === undefined ? "" : ` hasta el ${formatWhatsAppDate(plan.endDate)}`}${plan.monthDays === undefined ? "" : `, los días ${plan.monthDays.map((day) => (day === "last" ? "último" : day)).join(" y ")}`}`;

const planDetailText = (plan: RecurringPlanInput): string =>
  `${plan.categoryId === undefined ? "" : `, en ${categoryLabel(plan.categoryId)}`}${plan.counterparty === undefined ? "" : `, con ${quote(plan.counterparty)}`}${plan.cardPayment === true ? ", pago de tarjeta" : ""}${plan.accountId === undefined ? "" : ", cuenta vinculada"}`;

const planText = (plan: RecurringPlanInput): string =>
  `${quote(plan.name)}: ${kindText[plan.kind]}, ${amountText(plan)}, ${frequencyText[plan.frequency]}, ${scheduleText(plan)}${planDetailText(plan)}`;

const planName = (document: RecurringDocument, id: string, date: string): string =>
  document.plans
    .find((plan) => plan.id === id)
    ?.revisions.findLast((revision) => revision.from <= date)?.plan.name ?? id;

const currentPlanName = (document: RecurringDocument, id: string): string =>
  document.plans.find((plan) => plan.id === id)?.revisions.at(-1)?.plan.name ?? id;

const seriesText = Effect.fnUntraced(function* (user: UserId, id: string) {
  const page = yield* Effect.option(readLocalRecurringSeries(Option.none(), user));

  const observed = Option.flatMap(
    Option.flatMap(
      Option.flatMap(page, (result) =>
        result.outcome === "success" ? Option.some(result.body) : Option.none<Schema.Json>()
      ),
      Schema.decodeUnknownOption(Schema.Struct({ data: Schema.toCodecJson(RecurringSeriesPage) }))
    ),
    ({ data }) => Option.fromUndefinedOr(data.series.find((series) => series.id === id))
  );

  return Option.match(observed, {
    onNone: () => id,
    onSome: (series) =>
      `${quote(series.counterparty)}, por ${formatWhatsAppMoney(series.money)} al mes`,
  });
});

const createText = Effect.fnUntraced(function* (
  user: UserId,
  edit: Extract<RecurringEdit, { kind: "create" }>
) {
  const suggestion =
    edit.seriesId === undefined
      ? ""
      : `, a partir de la sugerencia de ${yield* seriesText(user, edit.seriesId)}`;

  return `Crear el compromiso recurrente ${planText(edit.plan)}${suggestion}. No hará pagos por ti.`;
});

const changeText = (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "edit" }>
): string =>
  `Cambiar ${quote(planName(base, edit.planId, edit.date))} ${edit.scope === "once" ? "solo para" : "a partir de"} el ${formatWhatsAppDate(edit.date)}. Nuevos datos: ${planText(edit.plan)}.`;

const lifecycleText = (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "lifecycle" }>
): string =>
  `${lifecycleActionText[edit.action]} ${quote(planName(base, edit.planId, edit.date))} desde el ${formatWhatsAppDate(edit.date)}.`;

const skipText = (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "skip" }>
): string =>
  `${edit.skipped ? "Omitir" : "Restablecer"} ${quote(planName(base, edit.planId, edit.date))} para el ${formatWhatsAppDate(edit.date)}.`;

const fulfillText = (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "fulfill" }>
): string =>
  `Marcar ${quote(planName(base, edit.fulfillment.planId, edit.fulfillment.date))} del ${formatWhatsAppDate(edit.fulfillment.date)} con ${formatWhatsAppMoney(edit.fulfillment.money)}, realizado el ${formatWhatsAppDate(edit.fulfillment.actualDate)}${edit.fulfillment.settled ? ", como completado" : ", como parcial"}. No hace un pago ni crea otro gasto.`;

const reverseText = (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "reverse" }>
): string => {
  const fulfillment = base.fulfillments.find((mark) => mark.id === edit.fulfillmentId);

  return fulfillment === undefined
    ? `Quitar el seguimiento del cumplimiento ${edit.fulfillmentId}. Los gastos guardados se conservan.`
    : `Quitar el seguimiento de ${formatWhatsAppMoney(fulfillment.money)} en ${quote(planName(base, fulfillment.planId, fulfillment.date))}, del ${formatWhatsAppDate(fulfillment.date)}. Los gastos guardados se conservan.`;
};

const suggestionText = Effect.fnUntraced(function* (
  base: RecurringDocument,
  edit: Extract<RecurringEdit, { kind: "suggestion" }>,
  user: UserId
) {
  const linked =
    edit.planId === undefined ? "" : ` con ${quote(currentPlanName(base, edit.planId))}`;

  return `${suggestionActionText[edit.action]} la sugerencia de ${yield* seriesText(user, edit.seriesId)}${linked}. No cancela servicios ni hace pagos.`;
});

const editEffectText = Effect.fnUntraced(function* ({
  base,
  edit,
  user,
}: Readonly<{ base: RecurringDocument; edit: RecurringEdit; user: UserId }>) {
  switch (edit.kind) {
    case "create":
      return yield* createText(user, edit);
    case "edit":
      return changeText(base, edit);
    case "lifecycle":
      return lifecycleText(base, edit);
    case "skip":
      return skipText(base, edit);
    case "fulfill":
      return fulfillText(base, edit);
    case "reverse":
      return reverseText(base, edit);
    case "suggestion":
      return yield* suggestionText(base, edit, user);
  }
});

export const recurringReview = Effect.fn(function* ({
  base,
  edit,
  user,
}: Readonly<{ base: RecurringDocument; edit: RecurringEdit; user: UserId }>) {
  return {
    revision: String(base.revision),
    effect: yield* editEffectText({ base, edit, user }),
  };
});
