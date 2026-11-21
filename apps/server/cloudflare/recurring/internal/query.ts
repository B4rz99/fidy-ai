import { Effect, Option, Schema } from "effect";
import { Currency } from "../../../src/core/_shared/money";
import {
  RecurringSeries,
  RecurringSeriesId,
  RecurringSeriesPage,
} from "../../../src/core/recurring/contract";
import { pageSize } from "./models";

export const maximumCursorLength = 1024;

export const Cursor = Schema.Struct({
  currency: Currency,
  key: Schema.String.check(Schema.isMaxLength(maximumCursorLength)),
  id: RecurringSeriesId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});

const Status = Schema.Struct({
  factRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  evaluatedRevision: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  phase: Schema.NullOr(Schema.Literals(["scan", "detect", "complete"])),
  evaluatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
});

const Row = Schema.Struct({
  currency: Currency,
  counterparty_key: Schema.String,
  id: RecurringSeriesId,
  series_json: Schema.String,
});

const statusOf = (
  status: Option.Option<typeof Status.Type>
): (typeof RecurringSeriesPage.Type)["evaluation"] => {
  if (Option.isNone(status) || status.value.evaluatedRevision === null) {
    return { kind: "not-evaluated" };
  }

  if (
    status.value.factRevision !== status.value.evaluatedRevision ||
    status.value.phase !== "complete"
  ) {
    return { kind: "updating" };
  }

  return Option.match(status.value.evaluatedAt, {
    onNone: () => ({ kind: "updating" }) as const,
    onSome: (asOf) => ({ kind: "current", asOf }) as const,
  });
};

export const readStatus = (
  raw: unknown
): Effect.Effect<Option.Option<typeof Status.Type>, Schema.SchemaError> =>
  raw === undefined
    ? Effect.succeedNone
    : Schema.decodeUnknownEffect(Status)(raw).pipe(Effect.asSome);

export const pageData = ({
  raw,
  status,
}: Readonly<{ raw: unknown; status: Option.Option<typeof Status.Type> }>): Effect.Effect<
  Schema.Json,
  Schema.SchemaError
> =>
  Effect.gen(function* () {
    const revision = Option.map(status, (value) => value.evaluatedRevision ?? value.factRevision);
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(raw);

    const series = yield* Effect.forEach(rows.slice(0, pageSize), (row) =>
      Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(RecurringSeries)))(
        row.series_json
      )
    );

    const last = rows.slice(0, pageSize).at(-1);

    const nextCursor =
      rows.length > pageSize && last !== undefined && Option.isSome(revision)
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(Cursor))({
              currency: last.currency,
              key: last.counterparty_key,
              id: last.id,
              revision: revision.value,
            })
          )
        : Option.none<string>();

    const data = yield* Schema.encodeEffect(Schema.toCodecJson(RecurringSeriesPage))({
      series,
      evaluation: statusOf(status),
      cursor: nextCursor,
    });

    return data;
  });
