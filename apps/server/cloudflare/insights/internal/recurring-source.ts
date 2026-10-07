import { prepareProactivityConsentAction } from "../../consent/operations";
import type { InstructionRow } from "./recurring-standing";
import { InsightUnavailable } from "../contract";
import { type Cause, Effect, Option, Schema } from "effect";
import type { RecurringDigestItem } from "../../../src/core/insights/contract";
import type { RecurringDigestSourcePage, RecurringUnavailable } from "../../recurring/contract";
import {
  prepareRecurringDigestSourceGuard,
  readRecurringDigestSource,
} from "../../recurring/operations";
import { ContextJson, ItemJson, Scan, type Scope } from "./recurring-models";

const sourceDisposition = (source: RecurringDigestSourcePage["confirmations"][number]): string => {
  if (Option.isNone(source.snapshot)) return "legacy";
  if (!source.valid) return "invalid";
  return source.snapshot.value.occurrence.announcement.kind === "eligible"
    ? "eligible"
    : "suppressed";
};
const stageConfirmation = (
  input: Scope,
  source: RecurringDigestSourcePage["confirmations"][number]
): Effect.Effect<D1PreparedStatement, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    let item: Option.Option<RecurringDigestItem> = Option.none();
    if (Option.isSome(source.snapshot)) {
      const occurrence = source.snapshot.value.occurrence;
      item = Option.some({
        confirmationId: occurrence.id,
        seriesId: occurrence.seriesId,
        counterparty: occurrence.counterparty,
        money: occurrence.money,
        cadence: occurrence.cadence,
        confirmedAt: occurrence.confirmedAt,
      });
    }
    const encoded = Option.isSome(item) ? yield* Schema.encodeEffect(ItemJson)(item.value) : null;
    const context = yield* Schema.encodeEffect(ContextJson)(source.context);
    return input.db
      .prepare(
        "INSERT INTO recurring_digest_staging(user_id,confirmation_id,confirmed_at_ms,context_json,item_json,eligible) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,confirmation_id) DO UPDATE SET item_json=excluded.item_json,eligible=excluded.eligible"
      )
      .bind(
        input.userId,
        source.id,
        source.confirmedAt.epochMilliseconds,
        context,
        encoded,
        sourceDisposition(source)
      );
  });
const readCursor = (
  input: Scope
): Effect.Effect<Option.Option<string>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare("SELECT cursor,complete FROM recurring_digest_scans WHERE user_id=?")
        .bind(input.userId)
        .first()
    );
    const previous =
      raw === null ? Option.none() : Option.some(yield* Schema.decodeUnknownEffect(Scan)(raw));
    const cursor = Option.flatMap(previous, (scan) =>
      scan.complete === 1 ? Option.none<string>() : scan.cursor
    );
    return cursor;
  });
export const stageSource = (
  input: Scope
): Effect.Effect<
  RecurringDigestSourcePage,
  Cause.UnknownError | Schema.SchemaError | RecurringUnavailable
> =>
  Effect.gen(function* () {
    const cursor = yield* readCursor(input);
    const page = yield* readRecurringDigestSource({ ...input, cursor }).pipe(
      Effect.tapError(() =>
        Effect.tryPromise(() =>
          input.db
            .prepare("DELETE FROM recurring_digest_scans WHERE user_id=?")
            .bind(input.userId)
            .run()
        ).pipe(Effect.ignore)
      )
    );
    const statements = [
      ...(yield* prepareRecurringDigestSourceGuard({ ...input, checkpoint: page.checkpoint })),
    ];
    if (Option.isNone(cursor)) {
      statements.push(
        input.db.prepare("DELETE FROM recurring_digest_staging WHERE user_id=?").bind(input.userId)
      );
    }
    statements.push(
      ...(yield* Effect.forEach(page.confirmations, (source) => stageConfirmation(input, source)))
    );
    statements.push(
      input.db
        .prepare(
          "INSERT INTO recurring_digest_scans(user_id,checkpoint,cursor,cutoff_at_ms,complete) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET checkpoint=excluded.checkpoint,cursor=excluded.cursor,cutoff_at_ms=excluded.cutoff_at_ms,complete=excluded.complete"
        )
        .bind(
          input.userId,
          page.checkpoint,
          Option.getOrNull(page.cursor),
          page.cutoffAt.epochMilliseconds,
          page.complete ? 1 : 0
        )
    );
    if (page.complete) {
      statements.push(
        input.db
          .prepare(
            "INSERT INTO proactivity_message_assertion(id,accepted) VALUES(1,CASE WHEN (SELECT count(*) FROM recurring_digest_staging WHERE user_id=?)=? THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
          )
          .bind(input.userId, page.total)
      );
    }
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return page;
  });

/** A complete guarded cutoff permanently excludes earlier-day backlog in one bounded owner write. */
export const consumeEarlierDays = (
  work: Readonly<{ input: Scope; checkpoint: string; instruction: typeof InstructionRow.Type }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const { input, checkpoint, instruction } = work;
    const statements = [...(yield* prepareRecurringDigestSourceGuard({ ...input, checkpoint }))];
    statements.push(
      prepareProactivityConsentAction({
        ...input,
        kind: "new-recurring-series",
        grantId: instruction.grant_id,
        statement: {
          sql: "INSERT OR IGNORE INTO recurring_digest_consumption(user_id,confirmation_id,disposition) SELECT user_id,confirmation_id,'excluded' FROM recurring_digest_staging WHERE user_id=? AND confirmed_at_ms<? AND EXISTS(SELECT 1 FROM recurring_digest_instructions WHERE user_id=? AND version=? AND enabled=1)",
          params: [input.userId, instruction.acceptance_from_ms, input.userId, instruction.version],
        },
      })
    );
    yield* Effect.tryPromise(() => input.db.batch(statements));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
