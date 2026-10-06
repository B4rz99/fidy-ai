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
import { Money } from "../../../src/core/_shared/money";
import {
  type RecurringFactSnapshot,
  prepareRecurringFactGuard,
  readRecurringFacts,
} from "../../transactions/operations";
import { prepareUserContext } from "../../identity/user-context/operations";
import { transactionId } from "../../canonical-work/operations";
import { RecurringUnavailable } from "../contract";
import {
  Evidence,
  type Progress,
  Proposal,
  StoredSeries,
  StringRow,
  maximumGroupFacts,
  maximumSeries,
} from "./models";

type Work = Readonly<{ db: D1Database; userId: UserId }>;
const jsonCodec = <Shape extends Schema.Top>(
  schema: Shape
): Schema.fromJsonString<Schema.toCodecJson<Shape>> =>
  Schema.fromJsonString(Schema.toCodecJson(schema));
export const decode = <Shape extends Schema.Top>({
  schema,
  input,
}: Readonly<{ schema: Shape; input: unknown }>): Effect.Effect<
  Shape["Type"],
  RecurringUnavailable,
  Shape["DecodingServices"]
> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(() => new RecurringUnavailable()));
export const batch = ({
  db,
  statements,
}: Readonly<{ db: D1Database; statements: ReadonlyArray<D1PreparedStatement> }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  Effect.tryPromise({
    try: () => db.batch([...statements]),
    catch: () => new RecurringUnavailable(),
  }).pipe(Effect.asVoid);
export const query = ({
  db,
  sql,
  values,
}: Readonly<{
  db: D1Database;
  sql: string;
  values: ReadonlyArray<string | number>;
}>): Effect.Effect<ReadonlyArray<unknown>, RecurringUnavailable> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(sql)
        .bind(...values)
        .all(),
    catch: () => new RecurringUnavailable(),
  }).pipe(Effect.map((result) => result.results));

export const initialize = ({
  work,
  snapshot,
}: Readonly<{ work: Work; snapshot: RecurringFactSnapshot }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  batch({
    db: work.db,
    statements: [
      prepareRecurringFactGuard({ ...work, revision: snapshot.revision }),
      work.db.prepare("DELETE FROM recurring_facts WHERE user_id = ?").bind(work.userId),
      work.db.prepare("DELETE FROM recurring_proposals WHERE user_id = ?").bind(work.userId),
      work.db
        .prepare(
          `INSERT INTO recurring_progress (user_id, revision, phase, first_captured_at, time_zone) VALUES (?, ?, 'scan', ?, ?) ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, phase = 'scan', cursor_at = '', cursor_id = '', group_key = '', first_captured_at = excluded.first_captured_at, time_zone = excluded.time_zone`
        )
        .bind(
          work.userId,
          snapshot.revision,
          DateTime.formatIso(snapshot.firstCapturedAt),
          snapshot.timeZone
        ),
    ],
  });
export const scan = ({
  work,
  progress,
}: Readonly<{ work: Work; progress: Progress }>): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const read = yield* readRecurringFacts({
      ...work,
      revision: progress.revision,
      cursor: { occurredAt: progress.cursor_at, transactionId: progress.cursor_id },
    });
    if (Option.isNone(read)) return yield* new RecurringUnavailable();
    const statements: D1PreparedStatement[] = [
      prepareRecurringFactGuard({ ...work, revision: progress.revision }),
    ];
    for (const fact of read.value.facts) {
      if (Option.isNone(fact.counterparty)) continue;
      const encoded = yield* Schema.encodeEffect(jsonCodec(RecurringTransactionFact))(fact);
      statements.push(
        work.db
          .prepare(
            "INSERT INTO recurring_facts (user_id, id, group_key, occurred_at, fact_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO NOTHING"
          )
          .bind(
            work.userId,
            fact.id,
            `${fact.money.currency}|${normalizeCounterparty(fact.counterparty.value)}`,
            DateTime.formatIso(fact.occurredAt),
            encoded
          )
      );
    }
    statements.push(
      work.db
        .prepare(
          "UPDATE recurring_progress SET cursor_at = ?, cursor_id = ?, phase = ? WHERE user_id = ? AND revision = ?"
        )
        .bind(
          read.value.cursor.occurredAt,
          read.value.cursor.transactionId,
          read.value.complete ? "detect" : "scan",
          work.userId,
          progress.revision
        )
    );
    yield* batch({ db: work.db, statements });
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

export const processGroup = ({
  work,
  progress,
  group,
}: Readonly<{ work: Work; progress: Progress; group: string }>): Effect.Effect<
  void,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const raw = yield* query({
      db: work.db,
      sql: `SELECT fact_json AS value FROM recurring_facts WHERE user_id = ? AND group_key = ? ORDER BY occurred_at, id LIMIT ${maximumGroupFacts + 1}`,
      values: [work.userId, group],
    });
    if (raw.length > maximumGroupFacts) return yield* new RecurringUnavailable();
    const rows = yield* decode({ schema: Schema.Array(StringRow), input: raw });
    const facts = yield* Effect.forEach(rows, (row) =>
      decode({ schema: jsonCodec(RecurringTransactionFact), input: row.value })
    );
    const proposals = detectMonthlySeries({ facts, timeZone: progress.time_zone });
    const statements: D1PreparedStatement[] = [
      prepareRecurringFactGuard({ ...work, revision: progress.revision }),
    ];
    for (const proposal of proposals) {
      const encoded = yield* Schema.encodeEffect(jsonCodec(Proposal))(proposal);
      const key = `${group}|${DateTime.formatIso(proposal.firstOccurredAt)}`;
      statements.push(
        work.db
          .prepare(
            "INSERT INTO recurring_proposals (user_id, proposal_key, proposal_json) VALUES (?, ?, ?) ON CONFLICT(user_id, proposal_key) DO UPDATE SET proposal_json = excluded.proposal_json"
          )
          .bind(work.userId, key, encoded)
      );
    }
    statements.push(
      work.db
        .prepare("UPDATE recurring_progress SET group_key = ? WHERE user_id = ? AND revision = ?")
        .bind(group, work.userId, progress.revision)
    );
    yield* batch({ db: work.db, statements });
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

type Retained = Readonly<{
  series: RecurringSeries;
  reference: Money;
  evidence: typeof Evidence.Type;
}>;
const retainedSeries = (work: Work): Effect.Effect<ReadonlyArray<Retained>, RecurringUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* query({
      db: work.db,
      sql: `SELECT series_json, evidence_json, reference_json FROM recurring_series WHERE user_id = ? LIMIT ${maximumSeries + 1}`,
      values: [work.userId],
    });
    if (rows.length > maximumSeries) return yield* new RecurringUnavailable();
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
          firstCapturedAt: progress.first_captured_at.epochMilliseconds,
          confirmedAt: current.epochMilliseconds,
        }),
      onSome: (old) => old.series.announcement,
    }),
  });
const confirmationStatement = (
  work: Work,
  input: Readonly<{ series: RecurringSeries; context: UserContext }>
): Effect.Effect<D1PreparedStatement, RecurringUnavailable> =>
  Effect.gen(function* () {
    const { series, context } = input;
    const eventId = RecurringConfirmationId.make(transactionId());
    const event = yield* Schema.encodeEffect(jsonCodec(RecurringSeriesConfirmed))({
      id: eventId,
      seriesId: series.id,
      confirmedAt: series.confirmedAt,
      money: series.money,
      cadence: series.cadence,
      announcement: series.announcement,
    });
    const contextJson = yield* Schema.encodeEffect(jsonCodec(UserContext))(context);
    return work.db
      .prepare(
        "INSERT INTO recurring_confirmations (user_id, id, series_id, confirmed_at, context_json, confirmation_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, series_id) DO NOTHING"
      )
      .bind(
        work.userId,
        eventId,
        series.id,
        DateTime.formatIso(series.confirmedAt),
        contextJson,
        event
      );
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));
const seriesStatements = (
  work: Work,
  input: Readonly<{
    proposal: RecurringProposal;
    progress: Progress;
    current: DateTime.Utc;
    retained: Option.Option<Retained>;
    context: UserContext;
  }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, RecurringUnavailable> =>
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
    const statements = [
      work.db
        .prepare(
          `INSERT INTO recurring_series (user_id, id, currency, counterparty_key, series_json, evidence_json, reference_json, valid) VALUES (?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(user_id, id) DO UPDATE SET series_json = excluded.series_json, evidence_json = excluded.evidence_json, reference_json = excluded.reference_json, valid = 1`
        )
        .bind(
          work.userId,
          series.id,
          series.money.currency,
          normalizeCounterparty(series.counterparty),
          encoded,
          evidence,
          reference
        ),
    ];
    if (Option.isNone(retained)) {
      statements.push(yield* confirmationStatement(work, { series, context }));
    }
    return statements;
  }).pipe(Effect.mapError(() => new RecurringUnavailable()));

const retainedAssignments = ({
  proposals,
  retained,
}: Readonly<{
  proposals: ReadonlyArray<RecurringProposal>;
  retained: ReadonlyArray<Retained>;
}>): Effect.Effect<
  ReadonlyArray<Pick<SeriesInput, "proposal" | "retained">>,
  RecurringUnavailable
> =>
  Effect.gen(function* () {
    const assignments: Array<Pick<SeriesInput, "proposal" | "retained">> = [];
    const used = new Set<string>();
    let retainedCount = retained.length;
    for (const proposal of proposals) {
      const matches = retained.filter((old) => matchingRetained(proposal, old));
      if (matches.length > 1) return yield* new RecurringUnavailable();
      const old = Option.fromUndefinedOr(matches[0]);
      if (Option.isSome(old) && used.has(old.value.series.id)) {
        return yield* new RecurringUnavailable();
      }
      if (Option.isSome(old)) used.add(old.value.series.id);
      else retainedCount += 1;
      if (retainedCount > maximumSeries) return yield* new RecurringUnavailable();
      assignments.push({ proposal, retained: old });
    }
    return assignments;
  });
export const cutover = ({
  work,
  progress,
}: Readonly<{ work: Work; progress: Progress }>): Effect.Effect<void, RecurringUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* query({
      db: work.db,
      sql: `SELECT proposal_json AS value FROM recurring_proposals WHERE user_id = ? ORDER BY proposal_key LIMIT ${maximumSeries + 1}`,
      values: [work.userId],
    });
    if (rows.length > maximumSeries) return yield* new RecurringUnavailable();
    const stored = yield* decode({ schema: Schema.Array(StringRow), input: rows });
    const proposals = yield* Effect.forEach(stored, (row) =>
      decode({ schema: jsonCodec(Proposal), input: row.value })
    );
    const retained = yield* retainedSeries(work);
    const assignments = yield* retainedAssignments({ proposals, retained });
    const contextRows = yield* Effect.tryPromise({
      try: () =>
        prepareUserContext({
          ...work,
          statement: {
            sql: "SELECT serviceMarket, locale, timeZone FROM identity_user_context WHERE userId = ?",
            params: [work.userId],
          },
        }).all(),
      catch: () => new RecurringUnavailable(),
    });
    const context = yield* decode({ schema: UserContext, input: contextRows.results[0] });
    const current = yield* DateTime.now;
    const statements: D1PreparedStatement[] = [
      prepareRecurringFactGuard({ ...work, revision: progress.revision }),
      work.db.prepare("UPDATE recurring_series SET valid = 0 WHERE user_id = ?").bind(work.userId),
    ];
    for (const { proposal, retained: old } of assignments) {
      statements.push(
        ...(yield* seriesStatements(work, { proposal, progress, current, retained: old, context }))
      );
    }
    statements.push(
      work.db
        .prepare(
          "UPDATE recurring_progress SET phase = 'complete', evaluated_at = ?, evaluated_revision = revision WHERE user_id = ? AND revision = ?"
        )
        .bind(DateTime.formatIso(current), work.userId, progress.revision),
      work.db.prepare("DELETE FROM recurring_facts WHERE user_id = ?").bind(work.userId),
      work.db.prepare("DELETE FROM recurring_proposals WHERE user_id = ?").bind(work.userId)
    );
    yield* batch({ db: work.db, statements });
  });
