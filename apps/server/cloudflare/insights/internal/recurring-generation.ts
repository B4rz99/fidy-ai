import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type InsightEventId,
  type RecurringDigestReport,
} from "../../../src/core/insights/contract";
import { captureConfirmationDay } from "../../../src/core/insights/operations";
import { prepareConsentAction } from "../../consent/operations";
import { findInstruction } from "./recurring-standing";
import {
  type RecurringDigestAdvanceResult as AdvanceResult,
  InsightUnavailable,
} from "../contract";
import { type Scope, Stage, type StageView, maximumItems } from "./recurring-models";
import { consumeEarlierDays, stageSource } from "./recurring-source";
import { decodeRecurringReport, recurringReportQuery } from "./recurring-report";
import { materializeDay } from "./recurring-materialization";

const noteIdleSource = (
  work: Readonly<{
    input: Scope;
    rows: ReadonlyArray<StageView>;
    sourceIdentity: string;
    version: number;
  }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { input, rows, sourceIdentity, version } = work;
    const closingTimes = rows.map(
      (row) =>
        captureConfirmationDay({
          confirmedAt: DateTime.makeUnsafe(row.confirmed_at_ms),
          timeZone: row.context_json.timeZone,
        }).toExclusive.epochMilliseconds
    );
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "UPDATE schedules SET last_source_identity=?,next_closed_at_ms=? WHERE kind='digest' AND user_id=? AND version=?"
        )
        .bind(
          sourceIdentity,
          closingTimes.length === 0 ? null : Math.min(...closingTimes),
          input.userId,
          version
        )
        .run()
    );
  });
const sameWindowRows = (
  first: StageView,
  closed: ReadonlyArray<StageView>
): ReadonlyArray<StageView> => {
  const selected = captureConfirmationDay({
    confirmedAt: DateTime.makeUnsafe(first.confirmed_at_ms),
    timeZone: first.context_json.timeZone,
  });
  const sameDay = closed.filter((row) => {
    const day = captureConfirmationDay({
      confirmedAt: DateTime.makeUnsafe(row.confirmed_at_ms),
      timeZone: row.context_json.timeZone,
    });
    return (
      day.localDate === selected.localDate &&
      day.from.epochMilliseconds === selected.from.epochMilliseconds &&
      day.toExclusive.epochMilliseconds === selected.toExclusive.epochMilliseconds
    );
  });
  return sameDay;
};
export const advance = (input: Scope): Effect.Effect<AdvanceResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const instruction = yield* findInstruction(input);
    if (Option.isNone(instruction) || instruction.value.enabled === 0) {
      return { _tag: "NoWork" } as const;
    }
    const page = yield* stageSource(input);
    if (!page.complete) return { _tag: "Progress" } as const;
    yield* consumeEarlierDays({
      input,
      checkpoint: page.checkpoint,
      instruction: instruction.value,
    });
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT s.confirmation_id,s.confirmed_at_ms,s.context_json,s.item_json,s.eligible FROM recurring_digest_items AS s WHERE s.user_id=? AND s.confirmed_at_ms IS NOT NULL AND s.disposition IS NULL ORDER BY s.confirmed_at_ms,s.confirmation_id LIMIT ?"
        )
        .bind(input.userId, maximumItems + 1)
        .all()
    );
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Stage).check(Schema.isMaxLength(maximumItems))
    )(raw.results);
    const closed = rows.filter(
      (row) =>
        captureConfirmationDay({
          confirmedAt: DateTime.makeUnsafe(row.confirmed_at_ms),
          timeZone: row.context_json.timeZone,
        }).toExclusive.epochMilliseconds <=
        Math.min(input.now.epochMilliseconds, page.cutoffAt.epochMilliseconds)
    );
    const first = closed[0];
    if (first === undefined) {
      yield* noteIdleSource({
        input,
        rows,
        sourceIdentity: page.sourceIdentity,
        version: instruction.value.version,
      });
      return { _tag: "NoWork" } as const;
    }
    const sameDay = sameWindowRows(first, closed);
    return yield* materializeDay({
      input,
      instruction: instruction.value,
      checkpoint: page.checkpoint,
      rows: sameDay,
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const findReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<RecurringDigestReport>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        ...input,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: recurringReportQuery(input),
      }).first()
    );
    if (raw === null) return Option.none();
    return Option.some(yield* decodeRecurringReport(raw));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
