import { Clock, Effect, Option, Schema } from "effect";
import {
  ErasureClass,
  ErasureCustodian,
  ErasureCustodyEvidence,
  ErasureDecision,
  ErasureOperatorReceipt,
} from "../../../src/core/erasure/contract";
import { type ErasureScope, ErasureUnavailable } from "../../erasure-store/contract";

const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });
const Stored = Schema.Struct({
  state: ErasureOperatorReceipt.fields.state,
  connectionBlocked: Schema.Literals([0, 1]),
  decision: Schema.fromJsonString(ErasureDecision),
  lastErasedAtMs: Schema.OptionFromNullOr(Schema.Int),
});
const ClassProgress = Schema.Struct({
  dataClass: ErasureClass,
  pending: Schema.Int,
  retained: Schema.Int,
});
export const receipt = (
  input: Readonly<{ db: D1Database; scope: ErasureScope; bucket: Option.Option<R2Bucket> }>
): Effect.Effect<typeof ErasureOperatorReceipt.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { db, scope } = input;
    const rows = yield* io(() =>
      db.batch([
        db
          .prepare(
            "SELECT connection_blocked AS connectionBlocked,state,decision_json AS decision,last_erased_at_ms AS lastErasedAtMs FROM erasure_requests WHERE id=? AND user_id=?"
          )
          .bind(scope.reference, scope.userId),
        db
          .prepare(`SELECT s.data_class AS dataClass,sum(1-s.delete_done) AS pending,
      (SELECT count(*) FROM erasure_archives a JOIN erasure_steps t ON t.request_id=a.request_id AND t.store_id=a.store_id
        WHERE a.request_id=s.request_id AND t.data_class=s.data_class) AS retained
      FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND q.user_id=? GROUP BY s.data_class`)
          .bind(scope.reference, scope.userId),
        db
          .prepare(`SELECT p.custodian,p.state AS status,p.evidence_json AS evidence FROM (SELECT c.rowid,c.request_id,c.custodian,c.state,e.evidence_json FROM erasure_custody_records c LEFT JOIN erasure_custody_records e ON e.event_identity=c.current_event_id WHERE c.record_type='current') p JOIN erasure_requests q ON q.id=p.request_id
      WHERE q.id=? AND q.user_id=? ORDER BY custodian`)
          .bind(scope.reference, scope.userId),
      ])
    );
    const stored = yield* Schema.decodeUnknownEffect(Stored)(rows[0]?.results[0]);
    const classes = yield* includePrivateCopies({
      ...input,
      decision: stored.decision,
      classes: yield* Schema.decodeUnknownEffect(Schema.Array(ClassProgress))(rows[1]?.results),
    });
    const custodyRows = yield* Schema.decodeUnknownEffect(Schema.Array(CustodyRow))(
      rows[2]?.results
    );
    const custodians = yield* decodeCustodians({ rows: custodyRows, reference: scope.reference });
    const retained = retainedClasses({ classes, decision: stored.decision });
    const completed = classes
      .filter((item) => item.pending === 0 && item.retained === 0)
      .map((item) => item.dataClass);
    const recoveryUntilMs =
      stored.lastErasedAtMs._tag === "Some"
        ? stored.lastErasedAtMs.value + stored.decision.recovery.windowMs
        : null;
    return {
      reference: scope.reference,
      responseRouteRef: stored.decision.responseRouteRef,
      state: stored.state,
      completed,
      retained,
      custodians,
      recoveryUntilMs,
      controlRetention: {
        receipt: stored.decision.receiptRetention,
        recovery: stored.decision.recovery.retention,
      },
      next: yield* receiptNext({ stored, retained: retained.length }),
    };
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
const receiptNext = (
  input: Readonly<{ stored: typeof Stored.Type; retained: number }>
): Effect.Effect<typeof ErasureOperatorReceipt.Type.next> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const { stored } = input;
    if (
      [stored.decision.receiptRetention, stored.decision.recovery.retention].some(
        (retention) => retention.reviewAtMs <= current || retention.untilMs <= current
      )
    ) {
      return "retention-review";
    }
    if (stored.connectionBlocked === 1) return "connection-suppression";
    if (stored.state === "AwaitingReview") return "operator-review";
    if (stored.state === "Draining") return "admitted-work";
    if (stored.state === "Complete") return "none";
    if (stored.state !== "ExternalPending") return "continue";
    return input.retained > 0 ? "retention-review" : "provider-evidence";
  });

const retainedClasses = (
  input: Readonly<{ classes: ReadonlyArray<typeof ClassProgress.Type>; decision: ErasureDecision }>
): typeof ErasureOperatorReceipt.Type.retained =>
  input.classes.flatMap((item) => {
    const disposition = input.decision.dispositions[item.dataClass];
    return item.retained > 0 && disposition.action === "Retain"
      ? [{ dataClass: item.dataClass, retention: disposition.retention }]
      : [];
  });

const CustodyRow = Schema.Struct({
  custodian: ErasureCustodian,
  status: Schema.Literals([
    "Pending",
    "Accepted",
    "Verified",
    "NotApplicable",
    "Retained",
    "Unresolved",
  ]),
  evidence: Schema.OptionFromNullOr(Schema.fromJsonString(ErasureCustodyEvidence)),
});
const decodeCustodians = (
  input: Readonly<{ rows: ReadonlyArray<typeof CustodyRow.Type>; reference: string }>
): Effect.Effect<typeof ErasureOperatorReceipt.Type.custodians, ErasureUnavailable> =>
  Effect.forEach(input.rows, (row) =>
    Effect.gen(function* () {
      if (row.status === "Pending") return { custodian: row.custodian, status: "Pending" } as const;
      if (row.evidence._tag === "None") return yield* new ErasureUnavailable();
      const evidence = row.evidence.value;
      if (
        evidence.reference !== input.reference ||
        evidence.custodian !== row.custodian ||
        evidence.outcome.status !== row.status
      ) {
        return yield* new ErasureUnavailable();
      }
      return { custodian: row.custodian, ...evidence.outcome };
    })
  );

const includePrivateCopies = (
  input: Readonly<{
    bucket: Option.Option<R2Bucket>;
    scope: ErasureScope;
    decision: ErasureDecision;
    classes: ReadonlyArray<typeof ClassProgress.Type>;
  }>
): Effect.Effect<ReadonlyArray<typeof ClassProgress.Type>, ErasureUnavailable> =>
  Effect.gen(function* () {
    const bucket = input.bucket;
    if (Option.isNone(bucket)) return yield* new ErasureUnavailable();
    const originals = yield* io(() =>
      bucket.value.list({ prefix: `held/${input.scope.reference}/`, limit: 1 })
    );
    return yield* Effect.forEach(input.classes, (item) =>
      privateCopiesForClass({
        bucket: bucket.value,
        scope: input.scope,
        decision: input.decision,
        item,
        originalsPresent: originals.objects.length > 0,
      })
    );
  });

const privateCopiesForClass = (
  input: Readonly<{
    bucket: R2Bucket;
    scope: ErasureScope;
    decision: ErasureDecision;
    item: typeof ClassProgress.Type;
    originalsPresent: boolean;
  }>
): Effect.Effect<typeof ClassProgress.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const { item } = input;
    if (input.decision.dispositions[item.dataClass].action !== "Retain") return item;
    const records = yield* io(() =>
      input.bucket.list({
        prefix: `held-records/${input.scope.reference}/${item.dataClass}/`,
        limit: 1,
      })
    );
    const retained =
      records.objects.length > 0 || (item.dataClass === "ingestion" && input.originalsPresent);
    return { ...item, retained: retained ? Math.max(1, item.retained) : item.retained };
  });
