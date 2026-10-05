import { Clock, Effect, Option, Schema } from "effect";
import { WhatsAppMediaId } from "../../../src/shell/channels/whatsapp/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import {
  StagedStatementBytes,
  StatementStagingId,
  StatementSubmissionId,
} from "../../../src/shell/ingestion/contract";
import {
  StatementStaging,
  StatementStagingUnavailable,
  statementSubmissionCompletion,
} from "./statement-staging";
import {
  admitStatementUpload,
  statementUploadAuthority,
  uploadLeaseMilliseconds,
} from "./statement-upload-admission";
import {
  type ResourceAdmissionGrant,
  ResourceAdmissionGrantId,
  type ResourceAdmissionRefused,
  ResourceAdmissionUnavailable,
} from "../../resource-admission/contract";
import { releaseOutstandingResource } from "../../resource-admission/operations";

/** Compose verified attachment identity with admission; the supplied source is Agent-owned proof. */
export const prepareStatementDocumentAdmission = ({
  db,
  source,
  mediaId,
  current,
}: Readonly<{
  db: D1Database;
  source: OwnedStatement;
  mediaId: WhatsAppMediaId;
  current: number;
}>): ReadonlyArray<D1PreparedStatement> => [
  db
    .prepare(`INSERT INTO statement_whatsapp_documents (turn_id,user_id,media_id,created_at_ms)
    SELECT turn_id,user_id,?,? FROM (${source.sql})`)
    .bind(mediaId, current, ...source.params),
];
const Document = Schema.Struct({
  media_id: WhatsAppMediaId,
  upload_grant_id: Schema.OptionFromNullOr(ResourceAdmissionGrantId),
  upload_expires_at_ms: Schema.OptionFromNullOr(Schema.Finite),
  staging_id: Schema.NullOr(StatementStagingId),
  reference_json: Schema.NullOr(Schema.String),
});
const unavailable = (): StatementStagingUnavailable =>
  new StatementStagingUnavailable({ reason: "authority_unavailable" });
const findDocument = ({
  db,
  caller,
}: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>): Effect.Effect<
  Option.Option<typeof Document.Type>,
  StatementStagingUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT media_id,staging_id,reference_json,upload_grant_id,upload_expires_at_ms FROM statement_whatsapp_documents WHERE turn_id=? AND user_id=? AND EXISTS (SELECT 1 FROM ${caller.authority.table} WHERE ${caller.authority.predicate})`
        )
        .bind(caller.turnId, caller.userId, ...caller.authority.bindings)
        .first(),
    catch: unavailable,
  }).pipe(Effect.map(Schema.decodeUnknownOption(Document)));
/** Reveal only the media identity of this live admitted Turn; never a URL or private R2 locator. */
export const readHeldStatementDocument = (
  input: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>
): Effect.Effect<Option.Option<WhatsAppMediaId>, StatementStagingUnavailable> =>
  findDocument(input).pipe(Effect.map(Option.map(({ media_id }) => media_id)));

/** A retry reuses a verified private reference without another provider download. */
export const readHeldStatementDocumentReference = (
  input: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>
): Effect.Effect<Option.Option<StagedStatementBytes>, StatementStagingUnavailable> =>
  Effect.gen(function* () {
    const document = yield* findDocument(input);
    if (Option.isNone(document) || document.value.reference_json === null) return Option.none();
    return Option.some(
      yield* Schema.decodeEffect(Schema.fromJsonString(StagedStatementBytes))(
        document.value.reference_json
      ).pipe(Effect.mapError(unavailable))
    );
  });

const retireDocumentUpload = ({
  db,
  caller,
  grantId,
}: Readonly<{
  db: D1Database;
  caller: HostedCanonicalCaller;
  grantId: ResourceAdmissionGrantId;
}>): Effect.Effect<void, ResourceAdmissionUnavailable> =>
  Effect.try({
    try: () =>
      db
        .prepare(
          "UPDATE statement_whatsapp_documents SET upload_grant_id=NULL,upload_expires_at_ms=NULL WHERE turn_id=? AND user_id=? AND upload_grant_id=?"
        )
        .bind(caller.turnId, caller.userId, grantId),
    catch: () => new ResourceAdmissionUnavailable({ reason: "authority_unavailable" }),
  }).pipe(
    Effect.flatMap((statement) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((current) =>
          releaseOutstandingResource(statementUploadAuthority({ db, current }), {
            grantId,
            statements: [statement],
          })
        )
      )
    )
  );

/** Retire a recovered upload's outstanding lease without another download or budget charge. */
export const releaseHeldStatementDocumentUpload = ({
  db,
  caller,
}: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>): Effect.Effect<
  void,
  StatementStagingUnavailable | ResourceAdmissionUnavailable
> =>
  Effect.gen(function* () {
    const document = yield* findDocument({ db, caller });
    if (Option.isNone(document) || Option.isNone(document.value.upload_grant_id)) return;
    yield* retireDocumentUpload({ db, caller, grantId: document.value.upload_grant_id.value });
  });

/** Recover only this Turn's publication, under its still-live origin; a retry cannot publish again. */
export const readHeldStatementDocumentSubmission = ({
  db,
  caller,
}: Readonly<{ db: D1Database; caller: HostedCanonicalCaller }>): Effect.Effect<
  Option.Option<StatementSubmissionId>,
  StatementStagingUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT s.id FROM statement_submissions s JOIN statement_hosted_origins o ON o.submission_id=s.id WHERE s.user_id=? AND o.turn_id=? AND o.session_id=? AND o.abandoned_at_ms IS NULL AND EXISTS (SELECT 1 FROM ${caller.authority.table} WHERE ${caller.authority.predicate})`
        )
        .bind(caller.userId, caller.turnId, caller.sessionId, ...caller.authority.bindings)
        .first(),
    catch: unavailable,
  }).pipe(
    Effect.map(Schema.decodeUnknownOption(Schema.Struct({ id: StatementSubmissionId }))),
    Effect.map(Option.map(({ id }) => id))
  );

/** Admission precedes media metadata/download and staging. Every new download charges an attempt
 * and work; recovery of a retained reference never enters this bracket. A lost Worker holds only
 * the installed bounded outstanding lease, not an unlimited reusable download capability.
 */
export const withHeldStatementDocumentUpload = <A, E, R>({
  db,
  caller,
  current,
  work,
}: Readonly<{
  db: D1Database;
  caller: HostedCanonicalCaller;
  current: number;
  work: (grant: ResourceAdmissionGrant) => Effect.Effect<A, E, R>;
}>): Effect.Effect<A, E | ResourceAdmissionRefused | ResourceAdmissionUnavailable, R> =>
  Effect.acquireUseRelease(
    admitStatementUpload({
      db,
      userId: caller.userId,
      current,
      statements: (grantId) => [
        db
          .prepare(
            `UPDATE statement_whatsapp_documents SET upload_grant_id=?,upload_expires_at_ms=? WHERE turn_id=? AND user_id=? AND staging_id IS NULL AND EXISTS (SELECT 1 FROM ${caller.authority.table} WHERE ${caller.authority.predicate})`
          )
          .bind(
            grantId,
            current + uploadLeaseMilliseconds,
            caller.turnId,
            caller.userId,
            ...caller.authority.bindings
          ),
        db.prepare(statementSubmissionCompletion),
      ],
    }),
    work,
    (grant) => retireDocumentUpload({ db, caller, grantId: grant.grantId }).pipe(Effect.ignore)
  );

type HeldDocumentUpload = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  caller: HostedCanonicalCaller;
  bytes: Uint8Array;
  current: number;
  grant: ResourceAdmissionGrant;
}>;
/** Stage bounded verified bytes only under this Pending upload's admitted, unexpired grant. */
export const stageHeldStatementDocument = ({
  db,
  bucket,
  caller,
  bytes,
  current,
  grant,
}: HeldDocumentUpload): ReturnType<
  ReturnType<typeof StatementStaging.make>["stageStatementBytes"]
> =>
  Effect.gen(function* () {
    const document = yield* findDocument({ db, caller });
    const clock = yield* Clock.Clock;
    const checkedAt = clock.currentTimeMillisUnsafe();
    if (
      Option.isNone(document) ||
      !Option.contains(document.value.upload_grant_id, grant.grantId) ||
      !Option.exists(document.value.upload_expires_at_ms, (expires) => expires > checkedAt)
    ) {
      return yield* unavailable();
    }
    if (document.value.reference_json !== null) {
      return yield* Schema.decodeEffect(Schema.fromJsonString(StagedStatementBytes))(
        document.value.reference_json
      ).pipe(Effect.mapError(unavailable));
    }
    const staging = StatementStaging.make({ database: db, bucket, nowEpochMs: () => current });
    const reference = yield* staging.stageStatementBytes({
      userId: caller.userId,
      request: new Request("https://statement.internal/bytes", {
        method: "POST",
        body: Uint8Array.from(bytes),
      }),
    });
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(StagedStatementBytes))(
      reference
    ).pipe(Effect.mapError(unavailable));
    const updated = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            `UPDATE statement_whatsapp_documents SET staging_id=?,reference_json=? WHERE turn_id=? AND user_id=? AND staging_id IS NULL AND upload_grant_id=? AND upload_expires_at_ms>? AND EXISTS (SELECT 1 FROM ${caller.authority.table} WHERE ${caller.authority.predicate})`
          )
          .bind(
            reference.stagingId,
            json,
            caller.turnId,
            caller.userId,
            grant.grantId,
            clock.currentTimeMillisUnsafe(),
            ...caller.authority.bindings
          )
          .run(),
      catch: unavailable,
    });
    if (updated.meta.changes !== 1) return yield* unavailable();
    return reference;
  });
