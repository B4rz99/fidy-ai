import { DateTime, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  type InsightEventId,
  type RecurringDigestReport,
} from "../../../src/core/insights/contract";
import { captureConfirmationDay } from "../../../src/core/insights/operations";
import { prepareConsentAction, prepareProactivityConsentAction } from "../../consent/operations";
import { prepareRecurringDigestSourceGuard } from "../../recurring/operations";
import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import type { InstructionRow } from "./recurring-standing";
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
    checkpoint: string;
    instruction: typeof InstructionRow.Type;
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const { input, rows, sourceIdentity, checkpoint, instruction } = work;
    const closingTimes = rows.map(
      (row) =>
        captureConfirmationDay({
          confirmedAt: DateTime.makeUnsafe(row.confirmed_at_ms),
          timeZone: row.context_json.timeZone,
        }).toExclusive.epochMilliseconds
    );
    const statements = [...(yield* prepareRecurringDigestSourceGuard({ ...input, checkpoint }))];
    statements.push(
      prepareProactivityConsentAction({
        ...input,
        kind: "new-recurring-series",
        grantId: instruction.grant_id,
        statement: {
          sql: "UPDATE schedules SET last_source_identity=?,next_closed_at_ms=CASE WHEN ?=0 THEN NULL ELSE ? END WHERE kind='digest' AND user_id=? AND id=? AND version=? AND consent_grant_id=? AND enabled=1",
          params: [
            sourceIdentity,
            closingTimes.length,
            closingTimes.length === 0 ? 0 : Math.min(...closingTimes),
            input.userId,
            instruction.id,
            instruction.version,
            instruction.grant_id,
          ],
        },
      }),
      prepareChangedRowAssertion({ db: input.db, scope: "proactivity_message" })
    );
    yield* Effect.tryPromise(() => input.db.batch(statements));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
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
        checkpoint: page.checkpoint,
        instruction: instruction.value,
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
