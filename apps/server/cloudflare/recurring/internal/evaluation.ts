import { DateTime, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { RecurringTransactionFact } from "../../../src/core/transactions/contract";
import {
  RecurringConfirmationId,
  type RecurringProposal,
  RecurringSeries,
  RecurringSeriesConfirmed,
  RecurringSeriesId,
} from "../../../src/core/recurring/contract";
import {
  comparableMoney,
  decideAnnouncement,
  detectMonthlySeries,
  normalizeCounterparty,
} from "../../../src/core/recurring/operations";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { Money } from "../../../src/core/_shared/money";
import type {
  BudgetContributionCursor,
  RecurringFactPage,
  RecurringFactSnapshot,
} from "../../transactions/contract";
import { transactionId } from "../../canonical-work/operations";
import { RecurringUnavailable } from "../contract";
import {
  Evidence,
  Progress,
  Proposal,
  StoredSeries,
  StringRow,
  maximumGroupFacts,
  maximumSeries,
} from "./models";

type Statement = Readonly<{ sql: string; params: ReadonlyArray<SqlStorageValue> }>;

const statement = (sql: string, ...params: Statement["params"]): Statement => ({ sql, params });

export type EvaluationStore = Readonly<{
  userId: UserId;
  select: (
    sql: string,
    values: ReadonlyArray<string | number>
  ) => Effect.Effect<ReadonlyArray<unknown>, RecurringUnavailable>;
  commit: (
    revision: number,
    statements: ReadonlyArray<Statement>
  ) => Effect.Effect<void, RecurringUnavailable>;
  facts: (
    revision: number,
    cursor: BudgetContributionCursor
  ) => Effect.Effect<Option.Option<RecurringFactPage>, RecurringUnavailable>;
  context: Effect.Effect<UserContext, RecurringUnavailable>;
}>;

type Work = EvaluationStore;

const jsonCodec = <Model extends Schema.Top>(
  schema: Model
): Schema.fromJsonString<Schema.toCodecJson<Model>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));

export const decode = <Model extends Schema.Top>({
  schema,
  input,
}: Readonly<{ schema: Model; input: unknown }>): Effect.Effect<
  Model["Type"],
  RecurringUnavailable,
  Model["DecodingServices"]
> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new RecurringUnavailable({ cause: Option.some(cause) }))
  );

export const initialize = ({
  work,
  snapshot,
}: Readonly<{ work: Work; snapshot: RecurringFactSnapshot }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  work.commit(snapshot.revision, [
    statement(
      "DELETE FROM recurring_evaluation_records WHERE kind IN ('fact','proposal') AND user_id = ?",
      work.userId
    ),
    statement(
      `INSERT INTO recurring_evaluation_records (kind,id,user_id,revision,phase,first_captured_at_ms,time_zone,cursor_at_ms,cursor_id,group_key,evaluated_revision) VALUES ('progress','progress',?,?,'scan',?,?,NULL,'','',0) ON CONFLICT(user_id,kind,id) DO UPDATE SET revision = excluded.revision, phase = 'scan', cursor_at_ms = NULL, cursor_id = '', group_key = '', first_captured_at_ms = excluded.first_captured_at_ms, time_zone = excluded.time_zone`,
      work.userId,
      snapshot.revision,
      snapshot.firstCapturedAt.epochMilliseconds,
      snapshot.timeZone
    ),
  ]);

export const scan = ({
  work,
  progress,
}: Readonly<{ work: Work; progress: Progress }>): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const read = yield* work.facts(progress.revision, {
      occurredAt: progress.cursor_at_ms === null ? "" : DateTime.formatIso(progress.cursor_at_ms),
      transactionId: progress.cursor_id,
    });

    if (Option.isNone(read)) return yield* new RecurringUnavailable({ cause: Option.none() });

    const named = read.value.facts.flatMap((fact) =>
      Option.match(fact.counterparty, {
        onNone: () => [],
        onSome: (counterparty) => [{ fact, counterparty }],
      })
    );

    const statements: Statement[] = yield* Effect.forEach(named, ({ fact, counterparty }) =>
      Schema.encodeEffect(jsonCodec(RecurringTransactionFact))(fact).pipe(
        Effect.map((encoded) =>
          statement(
            "INSERT INTO recurring_evaluation_records (kind,user_id,id,group_key,occurred_at_ms,fact_json) VALUES ('fact',?,?,?,?,?) ON CONFLICT(user_id,kind,id) DO NOTHING",
            work.userId,
            fact.id,
            `${fact.money.currency}|${normalizeCounterparty(counterparty)}`,
            fact.occurredAt.epochMilliseconds,
            encoded
          )
        )
      )
    );

    const cursorAt =
      read.value.cursor.occurredAt === ""
        ? null
        : (yield* decode({ schema: UtcTimestamp, input: read.value.cursor.occurredAt }))
            .epochMilliseconds;

    statements.push(
      statement(
        "UPDATE recurring_evaluation_records SET cursor_at_ms = ?, cursor_id = ?, phase = ? WHERE kind='progress' AND user_id = ? AND revision = ?",
        cursorAt,
        read.value.cursor.transactionId,
        read.value.complete ? "detect" : "scan",
        work.userId,
        progress.revision
      )
    );
    yield* work.commit(progress.revision, statements);
  }).pipe(Effect.mapError((cause) => new RecurringUnavailable({ cause: Option.some(cause) })));

export const processGroup = ({
  work,
  progress,
  group,
}: Readonly<{ work: Work; progress: Progress; group: string }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* work.select(
      `SELECT fact_json AS value FROM (SELECT rowid,user_id,id,group_key,occurred_at_ms,fact_json FROM recurring_evaluation_records WHERE kind='fact') WHERE user_id = ? AND group_key = ? ORDER BY occurred_at_ms, id LIMIT ${maximumGroupFacts + 1}`,
      [work.userId, group]
    );

    if (raw.length > maximumGroupFacts) {
      return yield* new RecurringUnavailable({ cause: Option.none() });
    }

    const rows = yield* decode({ schema: Schema.Array(StringRow), input: raw });

    const facts = yield* Effect.forEach(rows, (row) =>
      decode({ schema: jsonCodec(RecurringTransactionFact), input: row.value })
    );

    const proposals = detectMonthlySeries({ facts, timeZone: progress.time_zone });

    const statements: Statement[] = yield* Effect.forEach(proposals, (proposal) =>
      Schema.encodeEffect(jsonCodec(Proposal))(proposal).pipe(
        Effect.map((encoded) =>
          statement(
            "INSERT INTO recurring_evaluation_records (kind,user_id,id,proposal_json) VALUES ('proposal',?,?,?) ON CONFLICT(user_id,kind,id) DO UPDATE SET proposal_json = excluded.proposal_json",
            work.userId,
            `${group}|${DateTime.formatIso(proposal.firstOccurredAt)}`,
            encoded
          )
        )
      )
    );

    statements.push(
      statement(
        "UPDATE recurring_evaluation_records SET group_key = ? WHERE kind='progress' AND user_id = ? AND revision = ?",
        group,
        work.userId,
        progress.revision
      )
    );
    yield* work.commit(progress.revision, statements);
  }).pipe(Effect.mapError((cause) => new RecurringUnavailable({ cause: Option.some(cause) })));

type Retained = Readonly<{
  series: RecurringSeries;
  reference: Money;
  evidence: typeof Evidence.Type;
}>;

const retainedSeries = (work: Work): Effect.Effect<ReadonlyArray<Retained>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* work.select(
      `SELECT series_json, evidence_json, reference_json FROM recurring_series WHERE user_id = ? LIMIT ${maximumSeries + 1}`,
      [work.userId]
    );

    if (rows.length > maximumSeries) {
      return yield* new RecurringUnavailable({ cause: Option.none() });
    }

    const stored = yield* decode({ schema: Schema.Array(StoredSeries), input: rows });

    return yield* Effect.forEach(stored, (row) =>
      Effect.gen(function* () {
        return {
          series: yield* decode({ schema: jsonCodec(RecurringSeries), input: row.series_json }),
          evidence: yield* decode({ schema: jsonCodec(Evidence), input: row.evidence_json }),
          reference: yield* decode({ schema: jsonCodec(Money), input: row.reference_json }),
        };
      })
    );
  });

const matchingRetained = (proposal: RecurringProposal, retained: Retained): boolean =>
  normalizeCounterparty(proposal.counterparty) ===
    normalizeCounterparty(retained.series.counterparty) &&
  proposal.referenceMoney.currency === retained.reference.currency &&
  (proposal.supportingTransactionIds.some((id) =>
    retained.evidence.supportingTransactionIds.includes(id)
  ) ||
    (comparableMoney({ candidate: proposal.referenceMoney, reference: retained.reference }) &&
      proposal.firstOccurredAt.epochMilliseconds ===
        retained.series.firstOccurredAt.epochMilliseconds));

type SeriesInput = Readonly<{
  proposal: RecurringProposal;
  progress: Progress;
  current: DateTime.Utc;
  retained: Option.Option<Retained>;
  context: UserContext;
}>;

const makeSeries = ({ proposal, progress, current, retained }: SeriesInput): RecurringSeries =>
  RecurringSeries.make({
    id: Option.match(retained, {
      onNone: () => RecurringSeriesId.make(transactionId()),
      onSome: (old) => old.series.id,
    }),
    counterparty: proposal.counterparty,
    money: proposal.money,
    cadence: { kind: "monthly" },
    firstOccurredAt: proposal.firstOccurredAt,
    lastOccurredAt: proposal.lastOccurredAt,
    confirmedAt: Option.match(retained, {
      onNone: () => current,
      onSome: (old) => old.series.confirmedAt,
    }),
    announcement: Option.match(retained, {
      onNone: () =>
        decideAnnouncement({
          backfill: proposal.backfill,
          firstCapturedAt: progress.first_captured_at_ms.epochMilliseconds,
          confirmedAt: current.epochMilliseconds,
        }),
      onSome: (old) => old.series.announcement,
    }),
  });

const seriesStatement = (
  work: Work,
  input: SeriesInput & Readonly<{ context: UserContext }>
): Effect.Effect<Statement, RecurringUnavailable> =>
  Effect.gen(function* () {
    const { proposal, progress, retained, context } = input;
    const series = makeSeries(input);
    const encoded = yield* Schema.encodeEffect(jsonCodec(RecurringSeries))(series);

    const evidence = yield* Schema.encodeEffect(jsonCodec(Evidence))({
      supportingTransactionIds: proposal.supportingTransactionIds,
      latestTransactionId: proposal.latestTransactionId,
      detectorRevision: "monthly-v1",
      evaluatedFactRevision: progress.revision,
    });

    const reference = yield* Schema.encodeEffect(jsonCodec(Money))(proposal.referenceMoney);
    const eventId = Option.isNone(retained) ? RecurringConfirmationId.make(transactionId()) : null;

    const confirmation =
      eventId === null
        ? null
        : yield* Schema.encodeEffect(jsonCodec(RecurringSeriesConfirmed))({
            id: eventId,
            seriesId: series.id,
            confirmedAt: series.confirmedAt,
            money: series.money,
            counterparty: series.counterparty,
            cadence: series.cadence,
            announcement: series.announcement,
          });

    const contextJson =
      eventId === null ? null : yield* Schema.encodeEffect(jsonCodec(UserContext))(context);

    return statement(
      `INSERT INTO recurring_series (
      user_id,id,currency,counterparty_key,series_json,evidence_json,reference_json,valid,
      confirmation_id,confirmed_at_ms,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence
    ) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,
      CASE WHEN ? IS NOT NULL THEN (SELECT coalesce(max(confirmation_sequence),0)+1 FROM recurring_series WHERE confirmation_sequence IS NOT NULL) END)
    ON CONFLICT(user_id,id) DO UPDATE SET series_json=excluded.series_json,
      evidence_json=excluded.evidence_json,reference_json=excluded.reference_json,valid=1`,
      work.userId,
      series.id,
      series.money.currency,
      normalizeCounterparty(series.counterparty),
      encoded,
      evidence,
      reference,
      eventId,
      eventId === null ? null : series.confirmedAt.epochMilliseconds,
      contextJson,
      confirmation,
      eventId === null ? null : 0,
      eventId
    );
  }).pipe(Effect.mapError((cause) => new RecurringUnavailable({ cause: Option.some(cause) })));

const retainedAssignments = ({
  proposals,
  retained,
}: Readonly<{
  proposals: ReadonlyArray<RecurringProposal>;
  retained: ReadonlyArray<Retained>;
}>): Effect.Effect<
  ReadonlyArray<Pick<SeriesInput, "proposal" | "retained">>,
  RecurringUnavailable
> => {
  const assignments: Array<Pick<SeriesInput, "proposal" | "retained">> = [];
  const used = new Set<string>();
  let retainedCount = retained.length;

  for (const proposal of proposals) {
    const matches = retained.filter((old) => matchingRetained(proposal, old));

    if (matches.length > 1) return Effect.fail(new RecurringUnavailable({ cause: Option.none() }));
    const old = Option.fromUndefinedOr(matches[0]);

    if (Option.isSome(old) && used.has(old.value.series.id)) {
      return Effect.fail(new RecurringUnavailable({ cause: Option.none() }));
    }

    if (Option.isSome(old)) used.add(old.value.series.id);
    else retainedCount += 1;

    if (retainedCount > maximumSeries) {
      return Effect.fail(new RecurringUnavailable({ cause: Option.none() }));
    }

    assignments.push({ proposal, retained: old });
  }

  return Effect.succeed(assignments);
};

export const cutover = ({
  work,
  progress,
}: Readonly<{ work: Work; progress: Progress }>): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* work.select(
      `SELECT proposal_json AS value FROM (SELECT rowid,user_id,id AS proposal_key,proposal_json FROM recurring_evaluation_records WHERE kind='proposal') WHERE user_id = ? ORDER BY proposal_key LIMIT ${maximumSeries + 1}`,
      [work.userId]
    );

    if (rows.length > maximumSeries) {
      return yield* new RecurringUnavailable({ cause: Option.none() });
    }

    const stored = yield* decode({ schema: Schema.Array(StringRow), input: rows });

    const proposals = yield* Effect.forEach(stored, (row) =>
      decode({ schema: jsonCodec(Proposal), input: row.value })
    );

    const retained = yield* retainedSeries(work);
    const assignments = yield* retainedAssignments({ proposals, retained });
    const context = yield* work.context;
    const current = yield* DateTime.now;

    const statements: Statement[] = [
      statement("UPDATE recurring_series SET valid = 0 WHERE user_id = ?", work.userId),
    ];

    const series = yield* Effect.forEach(assignments, ({ proposal, retained: old }) =>
      seriesStatement(work, { proposal, progress, current, retained: old, context })
    );

    statements.push(...series);

    statements.push(
      statement(
        "UPDATE recurring_evaluation_records SET phase = 'complete', evaluated_at_ms = ?, evaluated_revision = revision WHERE kind='progress' AND user_id = ? AND revision = ?",
        current.epochMilliseconds,
        work.userId,
        progress.revision
      ),
      statement(
        "DELETE FROM recurring_evaluation_records WHERE kind IN ('fact','proposal') AND user_id = ?",
        work.userId
      )
    );
    yield* work.commit(progress.revision, statements);
  });

export const advanceEvaluation = ({
  work,
  snapshot,
}: {
  work: EvaluationStore;
  snapshot: RecurringFactSnapshot;
}): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* work.select(
      "SELECT revision, phase, cursor_at_ms, cursor_id, group_key, evaluated_at_ms, first_captured_at_ms, time_zone FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') WHERE user_id = ?",
      [work.userId]
    );

    const first = rows[0];

    if (first === undefined) return yield* initialize({ work, snapshot });
    const progress = yield* decode({ schema: Progress, input: first });

    if (progress.revision !== snapshot.revision) {
      return yield* initialize({ work, snapshot });
    }

    if (progress.phase === "scan") return yield* scan({ work, progress });

    if (progress.phase === "complete") return;

    const groups = yield* work.select(
      "SELECT group_key AS value FROM (SELECT rowid,user_id,id,group_key,occurred_at_ms,fact_json FROM recurring_evaluation_records WHERE kind='fact') WHERE user_id = ? AND group_key > ? GROUP BY group_key ORDER BY group_key LIMIT 1",
      [work.userId, progress.group_key]
    );

    const group = groups[0];

    if (group === undefined) return yield* cutover({ work, progress });

    return yield* processGroup({
      work,
      progress,
      group: (yield* decode({ schema: StringRow, input: group })).value,
    });
  }).pipe(Effect.mapError((cause) => new RecurringUnavailable({ cause: Option.some(cause) })));
