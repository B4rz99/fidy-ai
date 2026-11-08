import { RecurringSeriesPage } from "../../../src/core/recurring/contract";
import { ApproveBrowserLoginPairingPayload } from "../../../src/shell/browser-login/contract";

import { collectLayoutWidgets } from "../../../src/core/dashboard/operations";
import { type UserId, UserPreferences } from "../../../src/core/identity/contract";
import {
  DashboardDocument,
  DashboardEdit,
  type Widget,
} from "../../../src/core/dashboard/contract";
import {
  RecurringCommand,
  type RecurringPlanInput,
} from "../../../src/core/recurring-plans/contract";
import { RecurringWorkspace } from "../../../src/shell/recurring-plans/contract";
import { describeRecurringLifecycle } from "../../recurring-plans/operations";
import { findInsight } from "../../insights/operations";
import { InsightEventId, ReminderScheduleEdit } from "../../../src/core/insights/contract";
import {
  NeedsReviewItem,
  ReviewCommand,
  ReviewDetail,
  StatementSubmission,
  SubmitForExtractionInput,
} from "../../../src/core/ingestion/contract";
import { ResolveNeedsReviewItemInput } from "../../../src/shell/ingestion/contract";
import { CanonicalToolEvidence } from "../../../src/core/agent/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { Budget, CreateBudgetInput, UpdateBudgetInput } from "../../../src/core/budgets/contract";
import { CreateKeywordRuleInput, KeywordRule } from "../../../src/core/categories/contract";
import { Memory, RememberInput, ReviseInput } from "../../../src/core/memory/contract";
import {
  CreateTransactionInput,
  Transaction,
  TransactionPairInput,
  UpdateTransactionInput,
} from "../../../src/core/transactions/contract";
import { AtomicBatchAdmission } from "../../../src/shell/operations/contract";
import {
  formatWhatsAppCategory as categoryText,
  formatWhatsAppDate as dateText,
  formatWhatsAppLocalDate as localDateText,
  formatWhatsAppMoney as moneyText,
} from "../../../src/shell/channels/whatsapp/operations";

export type ConfirmationRead = (
  operation: CanonicalOperationId,
  input: Schema.Json
) => Effect.Effect<Option.Option<Schema.Json>>;
type Context = Readonly<{
  read: ConfirmationRead;
  timeZone: string;
  db: D1Database;
  userId: UserId;
}>;
const addressed = Schema.Struct({ params: Schema.Struct({ id: Schema.String }) });
const quote = (text: string): string => `«${text}»`;
const decode = <A>(schema: Schema.Decoder<A>, input: unknown): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(input);
const load =
  (context: Context) =>
  <A>(
    operation: string,
    input: Schema.Json,
    schema: Schema.Codec<A, Schema.Json>
  ): Effect.Effect<Option.Option<A>> =>
    context
      .read(CanonicalOperationId.make(operation), input)
      .pipe(Effect.map(Option.flatMap(Schema.decodeUnknownOption(schema))));
const budgetName = (budget: Budget): Option.Option<string> =>
  Option.map(
    categoryText(budget.categoryId),
    (name) =>
      `${name}, de ${moneyText(budget.cap)}${budget.groupName === undefined ? "" : `, grupo ${quote(budget.groupName)}`}`
  );
const budgetChange = (budget: CreateBudgetInput | UpdateBudgetInput): Option.Option<string> =>
  Option.gen(function* () {
    const name = yield* categoryText(budget.categoryId);
    const groups =
      "groupCategoryIds" in budget && budget.groupCategoryIds !== undefined
        ? yield* Option.all(budget.groupCategoryIds.map(categoryText))
        : [];
    return `${name}: ${moneyText(budget.cap)}${budget.month === undefined ? "" : ` para ${dateText(`${budget.month}-01`).replace(/^1 de /u, "")}`}${budget.groupName === undefined ? "" : `, grupo ${quote(budget.groupName)}`}${groups.length === 0 ? "" : `. El grupo incluye ${groups.join(", ")}`}${"groupCurrency" in budget && budget.groupCurrency !== undefined ? `. La moneda del grupo será ${budget.groupCurrency}; se conservan los importes sin conversión` : ""}`;
  });
const transactionName = (transaction: Transaction, timeZone: string): Option.Option<string> =>
  Option.gen(function* () {
    const date = yield* localDateText({ date: transaction.occurredAt, timeZone });
    const category = yield* categoryText(transaction.categoryId);
    return `${transaction.direction === "inflow" ? "ingreso" : "gasto"} de ${moneyText(transaction.money)} en ${category}, del ${date}${Option.isSome(transaction.counterparty) ? `, con ${quote(transaction.counterparty.value)}` : ""}${Option.isSome(transaction.notes) ? `, nota ${quote(transaction.notes.value)}` : ""}`;
  });

const describeBudgetCreation = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() =>
    Option.flatMap(
      decode(Schema.Struct({ payload: Schema.toCodecJson(CreateBudgetInput) }), input),
      ({ payload }) =>
        Option.map(budgetChange(payload), (text) => `Crear el presupuesto de ${text}.`)
    )
  );
const describeBudgetChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const target = decode(addressed, input);
    if (Option.isNone(target)) return Option.none();
    const found = yield* load(context)(
      "budgets.getBudget",
      { params: target.value.params },
      Schema.Struct({ data: Schema.toCodecJson(Budget) })
    );
    if (Option.isNone(found)) return Option.none();
    const current = budgetName(found.value.data);
    if (Option.isNone(current)) return Option.none();
    if (operation === "budgets.deleteBudget") {
      return Option.some(
        `Eliminar el presupuesto de ${current.value}. Se borrará definitivamente.`
      );
    }
    const change = decode(Schema.Struct({ payload: Schema.toCodecJson(UpdateBudgetInput) }), input);
    return Option.flatMap(change, ({ payload }) =>
      Option.map(
        budgetChange(payload),
        (text) => `Cambiar el presupuesto de ${current.value}. Nuevo presupuesto: ${text}.`
      )
    );
  });
const describeRemember = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() =>
    Option.map(
      decode(Schema.Struct({ payload: RememberInput }), input),
      ({ payload }) => `Recordar ${quote(payload.text)}.`
    )
  );
const describeMemoryChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const target = decode(addressed, input);
    if (Option.isNone(target)) return Option.none();
    const found = yield* load(context)(
      "memory.recall",
      {},
      Schema.Struct({ data: Schema.Array(Schema.toCodecJson(Memory)) })
    );
    const memory = Option.flatMap(found, ({ data }) =>
      Option.fromUndefinedOr(data.find(({ id }) => id === target.value.params.id))
    );
    if (Option.isNone(memory)) return Option.none();
    if (operation === "memory.forget") {
      return Option.some(
        `Olvidar el recuerdo ${quote(memory.value.text)}. Se borrará definitivamente.`
      );
    }
    return Option.map(
      decode(Schema.Struct({ payload: ReviseInput }), input),
      ({ payload }) => `Cambiar el recuerdo ${quote(memory.value.text)} por ${quote(payload.text)}.`
    );
  });
const describeKeywordChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    let previous = Option.none<KeywordRule>();
    if (operation !== "categories.createKeywordRule") {
      const target = decode(addressed, input);
      if (Option.isNone(target)) return Option.none();
      const found = yield* load(context)(
        "categories.listKeywordRules",
        {},
        Schema.Struct({ data: Schema.Array(Schema.toCodecJson(KeywordRule)) })
      );
      previous = Option.flatMap(found, ({ data }) =>
        Option.fromUndefinedOr(data.find(({ id }) => id === target.value.params.id))
      );
      if (Option.isNone(previous)) return Option.none();
    }
    if (operation === "categories.deleteKeywordRule") {
      return Option.map(
        previous,
        (rule) =>
          `Eliminar la regla de clasificación para ${quote(rule.keyword)}. Los gastos ya guardados se conservan.`
      );
    }
    const change = decode(
      Schema.Struct({ payload: Schema.toCodecJson(CreateKeywordRuleInput) }),
      input
    );
    return Option.flatMap(change, ({ payload }) =>
      Option.map(
        categoryText(payload.categoryId),
        (category) =>
          `${Option.isSome(previous) ? `Cambiar la regla de ${quote(previous.value.keyword)}` : "Crear una regla"}: clasificar los próximos registros que incluyan ${quote(payload.keyword)} como ${category}. Los gastos ya guardados se conservan.`
      )
    );
  });
const describeTransactionCreation = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() => {
    const value = decode(
      Schema.Struct({ payload: Schema.toCodecJson(CreateTransactionInput) }),
      input
    );
    return Option.flatMap(value, ({ payload }) =>
      Option.gen(function* () {
        const date = yield* localDateText({
          date: payload.occurredAt,
          timeZone: context.timeZone,
        });
        return `Registrar ${payload.direction === "inflow" ? "un ingreso" : "un gasto"} de ${moneyText(payload.money)}, del ${date}${Option.isSome(payload.counterparty) ? `, con ${quote(payload.counterparty.value)}` : ""}${Option.isSome(payload.notes) ? `, nota ${quote(payload.notes.value)}` : ""}${Option.isNone(payload.categoryId) ? "" : `, en ${yield* categoryText(payload.categoryId.value)}`}.`;
      })
    );
  });
const transactionTextChanges = (changes: UpdateTransactionInput["changes"]): Array<string> => {
  const fields: Array<string> = [];
  if (changes.counterparty !== undefined) {
    fields.push(
      changes.counterparty === null
        ? "quitar la persona o negocio"
        : "persona o negocio: " + quote(changes.counterparty)
    );
  }
  if (changes.notes !== undefined) {
    fields.push(changes.notes === null ? "quitar la nota" : "nota: " + quote(changes.notes));
  }
  return fields;
};
const describeTransactionChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const target = decode(addressed, input);
    if (Option.isNone(target)) return Option.none();
    const found = yield* load(context)(
      "transactions.getTransaction",
      { params: target.value.params },
      Schema.Struct({ data: Schema.toCodecJson(Transaction) })
    );
    if (Option.isNone(found)) return Option.none();
    const current = transactionName(found.value.data, context.timeZone);
    if (Option.isNone(current)) return Option.none();
    if (operation === "transactions.deleteTransaction") {
      return Option.some(
        `Eliminar el ${current.value}. Se borrará definitivamente de tu historial.`
      );
    }
    const change = decode(
      Schema.Struct({ payload: Schema.toCodecJson(UpdateTransactionInput) }),
      input
    );
    return Option.flatMap(change, ({ payload }) =>
      Option.gen(function* () {
        const fields: Array<string> = [];
        const changes = payload.changes;
        if (changes.money !== undefined) fields.push(`importe: ${moneyText(changes.money)}`);
        if (changes.categoryId !== undefined) {
          fields.push(`categoría: ${yield* categoryText(changes.categoryId)}`);
        }
        if (changes.direction !== undefined) {
          fields.push(changes.direction === "inflow" ? "será un ingreso" : "será un gasto");
        }
        if (changes.occurredAt !== undefined) {
          fields.push(
            `fecha: ${yield* localDateText({ date: changes.occurredAt, timeZone: context.timeZone })}`
          );
        }
        fields.push(...transactionTextChanges(changes));
        return `Corregir el ${current.value}. Cambios: ${fields.join("; ")}.`;
      })
    );
  });
const recordDescriptions: Readonly<
  Record<
    string,
    (context: Context, operation: string, input: unknown) => Effect.Effect<Option.Option<string>>
  >
> = {
  "budgets.createBudget": describeBudgetCreation,
  "budgets.updateBudget": describeBudgetChange,
  "budgets.deleteBudget": describeBudgetChange,
  "memory.remember": describeRemember,
  "memory.forget": describeMemoryChange,
  "memory.revise": describeMemoryChange,
  "categories.createKeywordRule": describeKeywordChange,
  "categories.updateKeywordRule": describeKeywordChange,
  "categories.deleteKeywordRule": describeKeywordChange,
  "transactions.createTransaction": describeTransactionCreation,
  "transactions.updateTransaction": describeTransactionChange,
  "transactions.deleteTransaction": describeTransactionChange,
};
const describeRecord = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> => {
  const describe = recordDescriptions[operation];
  return describe === undefined ? Effect.succeedNone : describe(context, operation, input);
};

const periods = {
  "this-week": "esta semana",
  "this-month": "este mes",
  "last-week": "la semana pasada",
  "last-month": "el mes pasado",
  "last-7-days": "los últimos siete días",
  "last-30-days": "los últimos treinta días",
};
const widgetCategories = (widget: Widget): Option.Option<string> => {
  if (!("categories" in widget) || widget.categories === undefined) return Option.some("");
  return Option.map(
    Option.all(widget.categories.map(categoryText)),
    (names) => `, categorías ${names.join(", ")}`
  );
};
const widgetText = (widget: Widget): Option.Option<string> =>
  Option.gen(function* () {
    const categories = yield* widgetCategories(widget);
    const title = widget.title === undefined ? "" : ` ${quote(widget.title)}`;
    switch (widget.type) {
      case "budget-bar":
        return `presupuesto${title} de ${yield* categoryText(widget.categoryId)} en ${widget.currency}`;
      case "transaction-list":
        return `lista${title} de los últimos ${widget.limit} registros${categories}${widget.search === undefined ? "" : `, que contengan ${quote(widget.search)}`}`;
      case "spending-chart":
        return `gráfica${title} de ${periods[widget.period]}, agrupada por ${{ category: "categoría", day: "día", month: "mes" }[widget.groupBy]}${categories}`;
      case "custom-metric":
        return `indicador${title} ${quote(widget.label)}: ${{ sum: "total", average: "promedio", maximum: "máximo" }[widget.aggregation]} de ${periods[widget.period]}${categories}`;
    }
  });
const planText = (plan: RecurringPlanInput): Option.Option<string> =>
  plan.accountId !== undefined
    ? Option.none()
    : Option.gen(function* () {
        const frequency = {
          weekly: "cada semana",
          fortnightly: "cada dos semanas",
          "twice-monthly": "dos veces al mes",
          monthly: "cada mes",
          quarterly: "cada tres meses",
          "half-yearly": "cada seis meses",
          yearly: "cada año",
        };
        return `${quote(plan.name)}: ${{ income: "ingreso", expense: "gasto", transfer: "transferencia" }[plan.kind]}, ${plan.money === undefined ? `importe por definir en ${plan.currency}` : `${plan.amountMode === "estimated" ? "aproximadamente " : ""}${moneyText(plan.money)}`}, ${frequency[plan.frequency]}, hora de ${timeZoneName(plan.timeZone)}, desde el ${dateText(plan.firstDate)}${plan.endDate === undefined ? "" : ` hasta el ${dateText(plan.endDate)}`}${plan.monthDays === undefined ? "" : `, los días ${plan.monthDays.map((day) => (day === "last" ? "último" : day)).join(" y ")}`}${plan.categoryId === undefined ? "" : `, en ${yield* categoryText(plan.categoryId)}`}${plan.counterparty === undefined ? "" : `, con ${quote(plan.counterparty)}`}${plan.cardPayment === true ? ", pago de tarjeta" : ""}`;
      });
const describeDashboardChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const decoded = decode(Schema.Struct({ payload: Schema.toCodecJson(DashboardEdit) }), input);
    if (Option.isNone(decoded)) return Option.none();
    const edit = decoded.value.payload;
    if (edit.op === "set-title") {
      return Option.some(`Cambiar el nombre de tu tablero a ${quote(edit.title)}.`);
    }
    const observed = yield* load(context)(
      "dashboard.getDashboard",
      {},
      Schema.Struct({ data: Schema.toCodecJson(DashboardDocument) })
    );
    if (Option.isNone(observed)) return Option.none();
    const name = (id: string): Option.Option<string> =>
      Option.flatMap(
        Option.fromUndefinedOr(
          collectLayoutWidgets(observed.value.data.layout).find((widget) => widget.id === id)
        ),
        widgetText
      );
    const placement = (
      at: Extract<DashboardEdit, { op: "move-widget" }>["at"]
    ): Option.Option<string> =>
      typeof at === "string"
        ? Option.some(at === "top" ? "al principio del tablero" : "al final del tablero")
        : Option.map(
            name(at.besideWidget),
            (target) =>
              `${at.side === "before" ? "antes" : "después"} de ${target}, ${at.axis === "row" ? "en la misma fila" : "en la misma columna"}`
          );
    return Option.gen(function* () {
      switch (edit.op) {
        case "add-widget":
          return `Añadir ${yield* widgetText(edit.widget)} ${yield* placement(edit.at)}.`;
        case "update-widget":
          return `Cambiar ${yield* name(edit.widget.id)} por ${yield* widgetText(edit.widget)}.`;
        case "remove-widget":
          return `Quitar ${yield* name(edit.widgetId)} del tablero. Tus registros y presupuestos se conservan.`;
        case "move-widget":
          return `Mover ${yield* name(edit.widgetId)} ${yield* placement(edit.at)}.`;
        case "swap-widgets":
          return `Intercambiar la posición de ${yield* name(edit.widgetId)} y ${yield* name(edit.withWidgetId)}.`;
        case "resize-region":
          return `Cambiar el tamaño de ${(yield* Option.all(edit.widgetIds.map(name))).join(" y ")} a ${edit.size.kind === "weight" ? `${edit.size.weight} partes del espacio` : { "one-quarter": "un cuarto", "one-third": "un tercio", "one-half": "la mitad", "two-thirds": "dos tercios", "three-quarters": "tres cuartos" }[edit.size.ratio]}.`;
      }
    });
  });
const skipAction = (skipped: boolean): string => (skipped ? "Omitir" : "Restablecer");
const fulfillmentState = (settled: boolean): string =>
  settled ? ", como completado" : ", como parcial";
const recurringEditText = ({
  edit,
  document,
  month,
  suggestionName,
}: Readonly<{
  edit: Exclude<RecurringCommand["edit"], { kind: "create" | "lifecycle" }>;
  document: (typeof RecurringWorkspace.Type)["document"];
  month: string;
  suggestionName: Option.Option<string>;
}>): Option.Option<string> => {
  const name = (id: string, date: string): Option.Option<string> =>
    Option.flatMap(Option.fromUndefinedOr(document.plans.find((plan) => plan.id === id)), (plan) =>
      Option.map(
        Option.fromUndefinedOr(plan.revisions.filter((revision) => revision.from <= date).at(-1)),
        (revision) => quote(revision.plan.name)
      )
    );
  return Option.gen(function* () {
    switch (edit.kind) {
      case "edit":
        return `Cambiar ${yield* name(edit.planId, edit.date)} ${edit.scope === "once" ? "solo para" : "a partir de"} el ${dateText(edit.date)}. Nuevos datos: ${yield* planText(edit.plan)}.`;
      case "skip":
        return `${skipAction(edit.skipped)} ${yield* name(edit.planId, edit.date)} para el ${dateText(edit.date)}.`;
      case "fulfill":
        return `Marcar ${yield* name(edit.fulfillment.planId, edit.fulfillment.date)} del ${dateText(edit.fulfillment.date)} con ${moneyText(edit.fulfillment.money)}, realizado el ${dateText(edit.fulfillment.actualDate)}${fulfillmentState(edit.fulfillment.settled)}. No hace un pago ni crea otro gasto.`;
      case "reverse": {
        const fulfillment = yield* Option.fromUndefinedOr(
          document.fulfillments.find((value) => value.id === edit.fulfillmentId)
        );
        return `Quitar el seguimiento de ${moneyText(fulfillment.money)} en ${yield* name(fulfillment.planId, fulfillment.date)}, del ${dateText(fulfillment.date)}. Los gastos guardados se conservan.`;
      }
      case "suggestion":
        return `${{ dismiss: "Ocultar", restore: "Restablecer", link: "Vincular" }[edit.action]} la sugerencia de ${yield* suggestionName}${edit.planId === undefined ? "" : ` con ${yield* name(edit.planId, `${month}-01`)}`}. No cancela servicios ni hace pagos.`;
    }
  });
};
const recurringSeriesName = (context: Context, id: string): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const observed = yield* load(context)(
      "recurring.listRecurringSeries",
      { query: {} },
      Schema.Struct({ data: Schema.toCodecJson(RecurringSeriesPage) })
    );
    if (Option.isNone(observed)) return Option.none();
    const found = observed.value.data.series.find((series) => series.id === id);
    if (found === undefined) return Option.none();
    return Option.map(
      localDateText({ date: found.lastOccurredAt, timeZone: context.timeZone }),
      (date) =>
        `${quote(found.counterparty)}, por ${moneyText(found.money)} al mes, observado hasta el ${date}`
    );
  });
const describeRecurringCreation = (
  context: Context,
  edit: Extract<RecurringCommand["edit"], { kind: "create" }>
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const plan = planText(edit.plan);
    if (Option.isNone(plan)) return Option.none();
    if (edit.seriesId === undefined) {
      return Option.some(`Crear el compromiso recurrente ${plan.value}. No hará pagos por ti.`);
    }
    const series = yield* recurringSeriesName(context, edit.seriesId);
    return Option.map(
      series,
      (name) =>
        `Crear el compromiso recurrente ${plan.value}, a partir de la sugerencia de ${name}. No hará pagos por ti.`
    );
  });
const recurringSuggestionName = (
  context: Context,
  edit: RecurringCommand["edit"]
): Effect.Effect<Option.Option<string>> =>
  edit.kind === "suggestion" ? recurringSeriesName(context, edit.seriesId) : Effect.succeedNone;
const describeRecurringChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const decoded = decode(Schema.Struct({ payload: Schema.toCodecJson(RecurringCommand) }), input);
    if (Option.isNone(decoded)) return Option.none();
    const command = decoded.value.payload;
    const edit = command.edit;
    if (edit.kind === "create") {
      return yield* describeRecurringCreation(context, edit);
    }
    if (edit.kind === "lifecycle") {
      return yield* describeRecurringLifecycle({ ...context, command });
    }
    const today = yield* DateTime.now;
    let date = DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(today, context.timeZone));
    if ("date" in edit) date = edit.date;
    if ("fulfillment" in edit) date = edit.fulfillment.date;
    const month = date.slice(0, "YYYY-MM".length);
    const observed = yield* load(context)(
      "recurringPlans.getRecurringWorkspace",
      { query: { month } },
      Schema.Struct({ data: Schema.toCodecJson(RecurringWorkspace) })
    );
    if (
      Option.isNone(observed) ||
      observed.value.data.document.revision !== command.expectedRevision
    ) {
      return Option.none();
    }
    const suggestionName = yield* recurringSuggestionName(context, edit);
    return recurringEditText({
      edit,
      document: observed.value.data.document,
      month,
      suggestionName,
    });
  });
const reminderCadence = (cadence: ReminderScheduleEdit["cadence"]): string => {
  switch (cadence.kind) {
    case "every-three-days":
      return `cada tres días desde el ${dateText(cadence.anchorDate)}`;
    case "weekly":
      return `cada ${["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][cadence.weekday]}`;
    case "weekdays":
      return "de lunes a viernes";
    case "daily":
      return "cada día";
  }
};
const timeZoneName = (zone: string): string => zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;
const describeInsightChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (operation === "insights.updateReminderSchedule") {
      return Option.map(
        decode(Schema.Struct({ payload: Schema.toCodecJson(ReminderScheduleEdit) }), input),
        ({ payload }) =>
          `Cambiar tus recordatorios para recibirlos ${reminderCadence(payload.cadence)} a las ${String(payload.timing.hour).padStart(2, "0")}:${String(payload.timing.minute).padStart(2, "0")}, hora de ${timeZoneName(payload.timeZone)}.`
      );
    }
    const target = decode(Schema.Struct({ params: Schema.Struct({ id: InsightEventId }) }), input);
    if (Option.isNone(target)) return Option.none();
    const found = yield* findInsight({
      db: context.db,
      userId: context.userId,
      id: target.value.params.id,
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(found)) return Option.none();
    const date = localDateText({ date: found.value.scheduledAt, timeZone: found.value.timeZone });
    if (Option.isNone(date)) return Option.none();
    const kinds = {
      "weekly-summary": "resumen semanal",
      "budget-threshold": "aviso de presupuesto",
      "manual-entry-reminder": "recordatorio de gastos",
      "new-recurring-series": "aviso de gasto recurrente",
    };
    const label = kinds[found.value.kind];
    const action = {
      "insights.markInsightRead": "Marcar como leído",
      "insights.dismissInsight": "Descartar",
      "insights.markInsightDelivered": "Marcar como entregado",
    }[operation];
    return action === undefined
      ? Option.none()
      : Option.some(`${action} el ${label} del ${date.value}.`);
  });
const reviewSource = (item: NeedsReviewItem): string => {
  if ("recordNumber" in item) return `de la fila ${item.recordNumber} del extracto`;
  return item.sourceChannel === "forwarded-email" ? "del correo" : "del archivo";
};
const heldReviewName = (item: NeedsReviewItem): Option.Option<string> =>
  Option.map(
    localDateText({ date: item.createdAt, timeZone: item.timeZone }),
    (date) =>
      `registro pendiente ${reviewSource(item)}, recibido el ${date}${"knownMoney" in item && Option.isSome(item.knownMoney) ? `, por ${moneyText(item.knownMoney.value)}` : ""}`
  );
const previewText = (preview: ReviewDetail["item"]["preview"]): string =>
  Option.match(preview, {
    onNone: () => "",
    onSome: (value) =>
      `, con importe ${quote(value.amount)}${Option.isSome(value.currency) ? ` ${value.currency.value}` : ""}${value.counterparty === "" ? "" : `, de ${quote(value.counterparty)}`}`,
  });
const reviewName = (context: Context, id: string): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const observed = yield* load(context)(
      "ingestion.getReviewItem",
      { params: { id } },
      Schema.Struct({ data: Schema.toCodecJson(ReviewDetail) })
    );
    if (Option.isSome(observed)) {
      const { item } = observed.value.data;
      return Option.map(
        localDateText({ date: item.createdAt, timeZone: item.timeZone }),
        (date) =>
          `registro pendiente de ${{ statement: "un extracto", email: "un correo", media: "un archivo" }[item.source]}, recibido el ${date}${previewText(item.preview)}`
      );
    }
    const rows = yield* load(context)(
      "ingestion.listNeedsReviewItems",
      { query: { status: "pending", limit: 100 } },
      Schema.Struct({ data: Schema.Array(Schema.toCodecJson(NeedsReviewItem)) })
    );
    if (Option.isNone(rows)) return Option.none();
    const item = Option.fromUndefinedOr(rows.value.data.find((item) => item.id === id));
    return Option.flatMap(item, heldReviewName);
  });
const describeReviewSelection = (
  context: Context,
  edit: Extract<ReviewCommand, { _tag: "Skip" | "Restore" }>
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const rows: Array<string> = [];
    for (const item of edit.items) {
      const name = yield* reviewName(context, item.id);
      if (Option.isNone(name)) return Option.none();
      rows.push(name.value);
    }
    return Option.some(`${edit._tag === "Skip" ? "Omitir" : "Restablecer"} estos registros:
${rows.map((name) => `- ${name}`).join("\n")}.`);
  });
const describeReviewEdit = (
  context: Context,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const decoded = decode(Schema.Struct({ payload: Schema.toCodecJson(ReviewCommand) }), input);
    if (Option.isNone(decoded)) return Option.none();
    const edit = decoded.value.payload;
    if (edit._tag === "Skip" || edit._tag === "Restore") {
      return yield* describeReviewSelection(context, edit);
    }
    const name = yield* reviewName(context, edit.id);
    if (Option.isNone(name)) return Option.none();
    if (edit._tag === "Create") {
      return Option.map(
        localDateText({ date: edit.extraction.occurredAt, timeZone: context.timeZone }),
        (date) =>
          `Guardar el ${name.value} como ${edit.extraction.direction === "inflow" ? "ingreso" : "gasto"} de ${moneyText(edit.extraction.money)}, del ${date}${Option.isSome(edit.extraction.counterparty) ? `, con ${quote(edit.extraction.counterparty.value)}` : ""}${Option.isSome(edit.categoryId) ? `, en ${Option.getOrElse(categoryText(edit.categoryId.value), () => "la categoría elegida")}` : ""}.`
      );
    }
    return Option.some(
      `Guardar un borrador para el ${name.value}: importe ${quote(edit.draft.amount)}, moneda ${Option.getOrElse(edit.draft.currency, () => "por definir")}, ${Option.match(edit.draft.direction, { onNone: () => "tipo por definir", onSome: (direction) => (direction === "inflow" ? "ingreso" : "gasto") })}, persona o negocio ${quote(edit.draft.counterparty)}, fecha ${quote(edit.draft.occurredAt)}${Option.isSome(edit.draft.categoryId) ? `, categoría ${Option.getOrElse(categoryText(edit.draft.categoryId.value), () => "por definir")}` : ""}. Todavía no se registra como gasto o ingreso.`
    );
  });
const describeReviewChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (operation === "ingestion.applyReviewEdit") {
      return yield* describeReviewEdit(context, input);
    }
    const target = decode(addressed, input);
    if (Option.isNone(target)) return Option.none();
    if (operation === "ingestion.abandonStatementSubmission") {
      const found = yield* load(context)(
        "ingestion.getStatementSubmission",
        { params: target.value.params },
        Schema.Struct({ data: Schema.toCodecJson(StatementSubmission) })
      );
      return Option.map(
        found,
        ({ data }) =>
          `Dejar de procesar el extracto recibido el ${Option.getOrElse(localDateText({ date: data.submittedAt, timeZone: context.timeZone }), () => "día indicado")}. Los gastos e ingresos ya registrados se conservan.`
      );
    }
    const name = yield* reviewName(context, target.value.params.id);
    if (Option.isNone(name)) return Option.none();
    if (operation === "ingestion.skipNeedsReviewItem") {
      return Option.some(
        `Omitir el ${name.value}. Se eliminará la información pendiente de esa fila; los gastos ya registrados se conservan.`
      );
    }
    if (operation === "ingestion.resolveNeedsReviewItem") {
      const value = decode(
        Schema.Struct({ payload: Schema.toCodecJson(ResolveNeedsReviewItemInput) }),
        input
      );
      return Option.flatMap(value, ({ payload }) =>
        Option.map(
          localDateText({ date: payload.extraction.occurredAt, timeZone: context.timeZone }),
          (date) =>
            `Guardar el ${name.value} como ${payload.extraction.direction === "inflow" ? "ingreso" : "gasto"} de ${moneyText(payload.extraction.money)}, del ${date}${Option.isSome(payload.extraction.counterparty) ? `, con ${quote(payload.extraction.counterparty.value)}` : ""}. Se eliminará la información original de esa fila.`
        )
      );
    }
    return Option.none();
  });
const describeFeature = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (operation === "dashboard.applyDashboardEdit") {
      return yield* describeDashboardChange(context, operation, input);
    }
    if (operation === "recurringPlans.applyRecurringEdit") {
      return yield* describeRecurringChange(context, operation, input);
    }
    if (operation.startsWith("insights.")) {
      return yield* describeInsightChange(context, operation, input);
    }
    if (operation.startsWith("ingestion.")) {
      return yield* describeReviewChange(context, operation, input);
    }
    return Option.none();
  });
const describeTransactionPair = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const decoded = decode(Schema.Struct({ payload: TransactionPairInput }), input);
    if (Option.isNone(decoded)) return Option.none();
    const names: Array<string> = [];
    for (const id of [
      decoded.value.payload.firstTransactionId,
      decoded.value.payload.secondTransactionId,
    ]) {
      const found = yield* load(context)(
        "transactions.getTransaction",
        { params: { id } },
        Schema.Struct({ data: Schema.toCodecJson(Transaction) })
      );
      if (Option.isNone(found)) return Option.none();
      const name = transactionName(found.value.data, context.timeZone);
      if (Option.isNone(name)) return Option.none();
      names.push(name.value);
    }
    return Option.some(
      `${operation === "transactions.linkTransactions" ? "Vincular" : "Separar"} estos dos registros: ${names.join("; ")}. Los importes guardados se conservan.`
    );
  });
const describeAdditionalChange = (operation: string, input: unknown): Option.Option<string> => {
  if (operation === "subscription.cancelSubscription") {
    return Option.some(
      "Cancelar la renovación de tu suscripción de Fidy. Conservarás Pro hasta que termine el periodo que ya pagaste; esto no solicita una devolución."
    );
  }
  if (operation === "ingestion.submitForExtraction") {
    return Option.map(
      decode(Schema.Struct({ payload: SubmitForExtractionInput }), input),
      () =>
        "Procesar el extracto que adjuntaste a esta conversación. Guardaré los gastos e ingresos que pueda leer y dejaré los demás para que los revises."
    );
  }
  return Option.none();
};
const describeOtherChange = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (operation === "browserLogin.approvePairing") {
      return Option.map(
        decode(Schema.Struct({ payload: ApproveBrowserLoginPairingPayload }), input),
        ({ payload }) =>
          `Permitir el acceso a tu cuenta de Fidy en el navegador que muestra el código ${quote(payload.publicCode)}. Confirma solo si es tu navegador.`
      );
    }
    if (operation === "dashboard.initializeDashboard") {
      return Option.some("Preparar tu tablero inicial. Si ya tienes uno, conservará tus cambios.");
    }
    if (operation === "identity.updateUserPreferences") {
      return Option.map(
        decode(Schema.Struct({ payload: UserPreferences }), input),
        ({ payload }) =>
          `Usar español de Colombia y cambiar tu horario al de ${timeZoneName(payload.timeZone)}.`
      );
    }
    if (operation === "ingestion.enableEmailForwarding") {
      return Option.some(
        "Activar tu dirección de correo de Fidy para recibir los comprobantes que reenvíes."
      );
    }
    if (
      operation === "transactions.linkTransactions" ||
      operation === "transactions.unlinkTransactions"
    ) {
      return yield* describeTransactionPair(context, operation, input);
    }
    return describeAdditionalChange(operation, input);
  });
const describeSingle = (
  context: Context,
  operation: string,
  input: unknown
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const description = yield* describeRecord(context, operation, input);
    if (Option.isSome(description)) return description;
    const feature = yield* describeFeature(context, operation, input);
    return Option.isSome(feature) ? feature : yield* describeOtherChange(context, operation, input);
  });

export const describeConfirmation = ({
  context,
  operation,
  input,
}: Readonly<{ context: Context; operation: string; input: unknown }>): Effect.Effect<
  Option.Option<string>
> =>
  Effect.gen(function* () {
    if (operation === "operations.executeAtomicBatch") {
      const batch = decode(AtomicBatchAdmission, input);
      if (Option.isNone(batch)) return Option.none();
      const descriptions: Array<string> = [];
      for (const raw of batch.value.payload.calls) {
        const call = decode(
          Schema.Struct({ operation: Schema.String, input: CanonicalToolEvidence }),
          raw
        );
        if (Option.isNone(call)) return Option.none();
        const description = yield* describeSingle(context, call.value.operation, call.value.input);
        if (Option.isNone(description)) return Option.none();
        descriptions.push(`${descriptions.length + 1}. ${description.value}`);
      }
      return Option.some(
        `Revisa estos cambios. Se aplicarán todos juntos:\n${descriptions.join("\n")}`
      );
    }
    return yield* describeSingle(context, operation, input);
  });
