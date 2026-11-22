import { retentionMs } from "./email-envelope";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  SampleArtifact,
  SampleReviewCommand,
  type SampleReviewResult,
} from "../../../src/core/ingestion/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import { type LocalIngestionRequest } from "../contract";
import { sampleAuthority } from "./sample-authority";
import { sampleOutcome, sampleReply, sampleStatus } from "./sample-response";
import { isWithdrawnSample, offerSample } from "./sample-publication";

const maximumOperatorLength = 256;

const authority = Schema.Struct({
  permission: Schema.Literal("ingestion.reviewSample"),
  issuer: Schema.String.check(Schema.isPattern(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/u)),
  operator: Schema.String.check(Schema.isBetweenLength(1, maximumOperatorLength)),
  deadline: Schema.Int,
});

const Admission = Schema.Struct({ command: SampleReviewCommand, authority });

const candidateRow = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  service_market: SampleArtifact.fields.serviceMarket,
  source_format: SampleArtifact.fields.sourceFormat,
  source_provider: SampleArtifact.fields.sourceProvider,
  parser_revision: SampleArtifact.fields.parserRevision,
  anonymization_revision: SampleArtifact.fields.anonymizationRevision,
  structure: Schema.fromJsonString(SampleArtifact.fields.structure),
});

const candidate = Effect.fn(function* (user: string, id: string, now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT c.id,c.revision,c.service_market,c.source_format,c.source_provider,c.parser_revision,c.anonymization_revision,c.structure FROM ingest_sample_candidates c JOIN forwarded_email_receipts r ON r.user_id=c.user_id AND r.id=c.receipt_id WHERE c.user_id=${user} AND (${id}='' OR c.id=${id}) AND c.expires_at_ms=r.expires_at_ms AND r.expires_at_ms=r.received_at_ms+${retentionMs} AND r.expires_at_ms>${now} ORDER BY c.expires_at_ms,c.id LIMIT 1`;

  if (row === undefined) return Option.none();
  const plain = yield* Schema.decodeUnknownEffect(candidateRow, { onExcessProperty: "error" })(row);

  const artifact = SampleArtifact.make({
    serviceMarket: plain.service_market,
    sourceFormat: plain.source_format,
    sourceProvider: plain.source_provider,
    parserRevision: plain.parser_revision,
    anonymizationRevision: plain.anonymization_revision,
    structure: plain.structure,
  });

  const bytes = yield* Schema.encodeEffect(Schema.fromJsonString(SampleArtifact))(artifact);

  return Option.some({ id: plain.id, revision: plain.revision, artifact, bytes });
});

type Action = Exclude<typeof SampleReviewCommand.Type, { action: "withdraw" }>;

type ExactDecision = Exclude<Action, { action: "preview" }>;

type Actor = typeof authority.Type;

type Version = Option.Option.Value<Effect.Success<ReturnType<typeof candidate>>>;

type Outcome = typeof SampleReviewResult.Type | { code: number };

const conflict: Outcome = { code: sampleStatus.conflict };

const forbidden: Outcome = { code: sampleStatus.forbidden };

const sameVersion = (first: Version, second: Version): boolean =>
  first.id === second.id && first.bytes === second.bytes && first.revision === second.revision;

const priorDecision = Effect.fn(function* (command: ExactDecision, actor: Actor) {
  const sql = yield* SqliteClient;

  const [prior] =
    yield* sql`SELECT phase,sample_id FROM ingest_sample_decisions WHERE candidate_id=${command.candidateId} AND user_id=${command.userId} AND revision=${command.revision} AND digest=${command.digest} AND issuer=${actor.issuer} AND operator=${actor.operator}`;

  if (prior === undefined) return Option.none<typeof SampleReviewResult.Type>();

  if (prior.phase === "rejected" && command.action === "reject") {
    return Option.some({ status: "rejected" } as const);
  }

  if ((prior.phase === "approved" || prior.phase === "published") && command.action === "approve") {
    return Option.some({
      status: prior.phase,
      sampleId: yield* Schema.decodeUnknownEffect(Schema.String)(prior.sample_id),
    } as const);
  }

  return Option.none<typeof SampleReviewResult.Type>();
});

const recordPreview = Effect.fn(function* (
  review: Version,
  digest: string,
  { actor, now }: { actor: Actor; now: number }
) {
  const sql = yield* SqliteClient;
  yield* sql`INSERT INTO ingest_sample_previews VALUES(${review.id},${review.revision},${digest},${actor.issuer},${actor.operator},${now}) ON CONFLICT(candidate_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,issuer=excluded.issuer,operator=excluded.operator,previewed_at_ms=excluded.previewed_at_ms`;

  return {
    status: "preview",
    candidateId: review.id,
    revision: review.revision,
    digest,
    artifact: review.artifact,
  } as const;
});

const recordDecision = Effect.fn(function* (
  command: ExactDecision,
  review: Version,
  { actor, now, storage }: { actor: Actor; now: number; storage: DurableObjectStorage }
) {
  const sql = yield* SqliteClient;
  const { candidateId: id, userId: user, digest, revision } = command;

  const [view] =
    yield* sql`SELECT 1 FROM ingest_sample_previews WHERE candidate_id=${id} AND revision=${revision} AND digest=${digest} AND issuer=${actor.issuer} AND operator=${actor.operator}`;

  if (view === undefined) return conflict;

  const approved = command.action === "approve",
    sampleId = newId();

  yield* sql`INSERT INTO ingest_sample_decisions(candidate_id,user_id,revision,digest,issuer,operator,decided_at_ms,sample_id,artifact,phase,due_ms) VALUES(${id},${user},${revision},${digest},${actor.issuer},${actor.operator},${now},${approved ? sampleId : null},${approved ? review.bytes : null},${approved ? "approved" : "rejected"},${approved ? now : null})`;
  yield* sql`DELETE FROM ingest_sample_candidates WHERE id=${id} AND user_id=${user}`;

  if (!approved) return { status: "rejected" } as const;
  yield* preserveStoreAlarm(storage, now);

  return { status: "approved", sampleId } as const;
});

const missingCandidate = (command: Action): Outcome =>
  command.action === "preview" ? { status: "empty" } : conflict;

const decide = Effect.fn(function* (command: Action, actor: Actor, storage: DurableObjectStorage) {
  const id = command.action === "preview" ? "" : command.candidateId;
  const observe = (now: number): ReturnType<typeof candidate> => candidate(command.userId, id, now);
  const observed = yield* observe(yield* Clock.currentTimeMillis);

  const digest = Option.isSome(observed)
    ? Hex.encode(yield* digestBytes(new TextEncoder().encode(observed.value.bytes)))
    : "";

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (actor.deadline <= now || !(yield* sampleAuthority(command.userId))) return forbidden;

      const prior =
        command.action === "preview" ? Option.none() : yield* priorDecision(command, actor);

      if (Option.isSome(prior)) return prior.value;
      const exact = yield* observe(now);

      if (Option.isNone(exact)) {
        return missingCandidate(command);
      }

      return yield* decideVersion({
        command,
        actor,
        observed,
        review: exact.value,
        digest,
        now,
        storage,
      });
    })
  );
});

const decideVersion = Effect.fn(function* ({
  command,
  actor,
  observed,
  review,
  digest,
  now,
  storage,
}: {
  command: Action;
  actor: Actor;
  observed: Option.Option<Version>;
  review: Version;
  digest: string;
  now: number;
  storage: DurableObjectStorage;
}) {
  if (Option.isNone(observed) || !sameVersion(review, observed.value)) return conflict;

  if (command.action === "preview") return yield* recordPreview(review, digest, { actor, now });

  if (command.digest !== digest || command.revision !== review.revision) return conflict;

  return yield* recordDecision(command, review, { actor, now, storage });
});

export const reviewLocal = Effect.fn(
  function* ({ request, owns, storage, env }: LocalIngestionRequest) {
    const admitted = yield* Schema.decodeUnknownEffect(Admission, { onExcessProperty: "error" })(
      yield* Effect.tryPromise(() => request.json())
    );

    if (admitted.command.action === "withdraw" || !owns(admitted.command.userId)) {
      return sampleReply(sampleStatus.forbidden);
    }

    const result = yield* decide(admitted.command, admitted.authority, storage);

    if ("code" in result) return sampleReply(result.code);

    if (!("sampleId" in result)) return sampleOutcome(result);

    if (yield* isWithdrawnSample(result.sampleId, env)) return sampleReply(sampleStatus.conflict);

    if (result.status === "published") return sampleOutcome(result);
    const published = yield* offerSample(result.sampleId, env);

    return sampleOutcome({
      status: published ? "published" : "approved",
      sampleId: result.sampleId,
    });
  },
  Effect.mapError((cause) => new CanonicalAdmissionUnavailable({ cause }))
);
