import type { HostedSubject } from "./hosted-authority";
import { type Cause, Crypto, Data, DateTime, Effect, Option, PlatformError, Schema } from "effect";
import {
  CanonicalToolCallEntry,
  CanonicalToolEvidence,
  type CanonicalToolOutcome,
  CanonicalToolResultEntry,
  ToolCallId,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
} from "../../../src/core/agent/contract";
import { UserId } from "../../../src/core/identity/contract";
import { StatementNeedsReviewItem } from "../../../src/core/ingestion/contract";
import { StagedStatementBytes, StatementSubmission } from "../../../src/shell/ingestion/contract";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import type { WhatsAppBusinessPhoneNumberId } from "../../../src/shell/channels/whatsapp/contract";
import { readWhatsAppStatementMedia } from "../../../src/shell/ingestion/operations";
import {
  executeHostedStatementCall,
  executeHostedStatementQuery,
} from "../../canonical-operations/operations";
import {
  readHeldStatementDocument,
  readHeldStatementDocumentReference,
  readHeldStatementDocumentSubmission,
  releaseHeldStatementDocumentUpload,
  stageHeldStatementDocument,
  withHeldStatementDocumentUpload,
} from "../../ingestion/operations";
import type { HostedCanonicalCaller } from "../../canonical-work/contract";
import { newId } from "../../secret-material/operations";
import { appendHostedToolEntry } from "./turn-store";
import { findConfirmedOutcome } from "./confirmed-outcome";

const DocumentRefusalReason = Schema.Literals([
  "invalid-material",
  "media-unavailable",
  "paywall",
  "rate-limited",
  "uncertain",
]);
class StatementDocumentRefused extends Data.TaggedError("StatementDocumentRefused")<{
  reason: typeof DocumentRefusalReason.Type;
}> {}
const uncertainDocument = (): StatementDocumentRefused =>
  new StatementDocumentRefused({ reason: "uncertain" });
const PublicationRefusal = Schema.Struct({ error: Schema.Struct({ code: Schema.String }) });

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((value) => new Uint8Array(value)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
const SubmissionResponse = Schema.Struct({ data: Schema.toCodecJson(StatementSubmission) });
const ReviewResponse = Schema.Struct({
  data: Schema.Array(Schema.toCodecJson(StatementNeedsReviewItem)),
});
type DocumentWork = Readonly<{
  subject: HostedSubject;
  db: D1Database;
  bucket: R2Bucket;
  caller: HostedCanonicalCaller;
  outbound: OutboundHttpService;
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  current: number;
}>;
const documentReference = (
  work: DocumentWork
): Effect.Effect<StagedStatementBytes, StatementDocumentRefused> =>
  Effect.gen(function* () {
    const retained = yield* readHeldStatementDocumentReference(work).pipe(
      Effect.mapError(uncertainDocument)
    );
    if (Option.isSome(retained)) {
      yield* releaseHeldStatementDocumentUpload(work).pipe(Effect.mapError(uncertainDocument));
      return retained.value;
    }
    const mediaId = yield* readHeldStatementDocument(work).pipe(Effect.mapError(uncertainDocument));
    if (Option.isNone(mediaId)) return yield* uncertainDocument();
    return yield* withHeldStatementDocumentUpload({
      ...work,
      work: (grant) =>
        Effect.gen(function* () {
          const media = yield* readWhatsAppStatementMedia({ ...work, mediaId: mediaId.value }).pipe(
            Effect.provideService(Crypto.Crypto, workerCrypto),
            Effect.mapError(() => new StatementDocumentRefused({ reason: "media-unavailable" }))
          );
          return yield* stageHeldStatementDocument({ ...work, grant, bytes: media.bytes }).pipe(
            Effect.mapError(
              (failure) =>
                new StatementDocumentRefused({
                  reason:
                    failure._tag === "StatementStagingFailed" ? "invalid-material" : "uncertain",
                })
            )
          );
        }),
    }).pipe(
      Effect.mapError((failure) =>
        failure instanceof StatementDocumentRefused
          ? failure
          : new StatementDocumentRefused({
              reason: failure._tag === "ResourceAdmissionRefused" ? "rate-limited" : "uncertain",
            })
      )
    );
  });

const readSubmission = ({
  work,
  id,
}: Readonly<{ work: DocumentWork; id: StatementSubmission["id"] }>): Effect.Effect<
  Option.Option<StatementSubmission>
> =>
  Effect.gen(function* () {
    const response = yield* executeHostedStatementQuery({
      ...work,
      bucket: Option.some(work.bucket),
      operation: "ingestion.getStatementSubmission",
      input: { params: { id } },
    });
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    return response.ok
      ? Schema.decodeUnknownOption(SubmissionResponse)(body).pipe(Option.map(({ data }) => data))
      : Option.none();
  }).pipe(Effect.orElseSucceed(() => Option.none()));

const publicationIdentity = (
  work: DocumentWork
): Readonly<{
  turnId: string;
  occurredAt: string;
  iteration: number;
  toolCallId: ToolCallId;
  operation: "ingestion.submitForExtraction";
}> => ({
  turnId: work.caller.turnId,
  occurredAt: DateTime.formatIso(DateTime.makeUnsafe(work.current)),
  iteration: 1,
  toolCallId: ToolCallId.make(`statement-upload:${work.caller.turnId}`),
  operation: "ingestion.submitForExtraction",
});
const recordOutcome = ({
  work,
  outcome,
}: Readonly<{ work: DocumentWork; outcome: CanonicalToolOutcome }>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const retained = yield* findConfirmedOutcome({
      db: work.db,
      userId: UserId.make(work.caller.userId),
      turnId: TranscriptTurnId.make(work.caller.turnId),
      toolCallId: publicationIdentity(work).toolCallId,
    });
    if (Option.isSome(retained) && retained.value._tag === "Recorded") return true;
    const entry = yield* Schema.decodeEffect(CanonicalToolResultEntry)({
      ...publicationIdentity(work),
      id: TranscriptEntryId.make(newId()),
      _tag: "CanonicalToolResultEntry",
      outcome,
    });
    return Option.isSome(
      yield* appendHostedToolEntry({
        db: work.db,
        userId: UserId.make(work.caller.userId),
        subject: work.subject,
        entry,
      })
    );
  }).pipe(Effect.orElseSucceed(() => false));
const recordPublicationCall = ({
  work,
  entry,
}: Readonly<{ work: DocumentWork; entry: CanonicalToolCallEntry }>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(
      entry.input
    );
    const retained = yield* Effect.tryPromise(() =>
      work.db
        .prepare(
          "SELECT 1 FROM transcript_entries WHERE user_id=? AND turn_id=? AND kind='tool_call' AND tool_call_id=? AND operation=? AND input_json=? AND iteration=?"
        )
        .bind(
          work.caller.userId,
          entry.turnId,
          entry.toolCallId,
          entry.operation,
          json,
          entry.iteration
        )
        .first()
    );
    return (
      retained !== null ||
      Option.isSome(
        yield* appendHostedToolEntry({
          db: work.db,
          userId: UserId.make(work.caller.userId),
          subject: work.subject,
          entry,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => false));
const publicationRefusal = (body: unknown): typeof DocumentRefusalReason.Type => {
  const refusal = Schema.decodeUnknownOption(PublicationRefusal)(body);
  const code = Option.isSome(refusal) ? refusal.value.error.code : "unavailable";
  switch (code) {
    case "paywall_required":
      return "paywall";
    case "rate_limited":
      return "rate-limited";
    case "validation_failed":
      return "invalid-material";
    default:
      return "uncertain";
  }
};
const retainPublicationResponse = ({
  work,
  response,
}: Readonly<{ work: DocumentWork; response: Response }>): Effect.Effect<
  StatementSubmission,
  StatementDocumentRefused
> =>
  Effect.gen(function* () {
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    if (!response.ok) {
      const reason = publicationRefusal(body);
      if (reason !== "uncertain") {
        const failure = yield* Schema.decodeUnknownEffect(CanonicalToolEvidence)(body);
        if (
          !(yield* recordOutcome({ work, outcome: { _tag: "CanonicalOperationFailed", failure } }))
        ) {
          return yield* uncertainDocument();
        }
      }
      return yield* new StatementDocumentRefused({ reason });
    }
    const result = yield* Schema.decodeUnknownEffect(SubmissionResponse)(body);
    const output = yield* Schema.decodeUnknownEffect(CanonicalToolEvidence)(body);
    if (!(yield* recordOutcome({ work, outcome: { _tag: "Succeeded", output } }))) {
      return yield* uncertainDocument();
    }
    return result.data;
  }).pipe(
    Effect.mapError((failure) =>
      failure instanceof StatementDocumentRefused ? failure : uncertainDocument()
    )
  );

const publishNewDocument = (
  work: DocumentWork
): Effect.Effect<StatementSubmission, StatementDocumentRefused> =>
  Effect.gen(function* () {
    const held = yield* documentReference(work);
    const reference = yield* Schema.encodeEffect(Schema.toCodecJson(StagedStatementBytes))(held);
    const input = yield* Schema.decodeEffect(CanonicalToolEvidence)({
      payload: { idempotencyKey: work.caller.turnId, reference },
    });
    const identity = publicationIdentity(work);
    const entry = yield* Schema.decodeEffect(CanonicalToolCallEntry)({
      ...identity,
      id: TranscriptEntryId.make(newId()),
      input,
      _tag: "CanonicalToolCallEntry",
    });
    if (!(yield* recordPublicationCall({ work, entry }))) {
      return yield* uncertainDocument();
    }
    const response = yield* executeHostedStatementCall({
      ...work,
      bucket: Option.some(work.bucket),
      input,
      fence: { turnId: TranscriptTurnId.make(work.caller.turnId), toolCallId: identity.toolCallId },
      operation: identity.operation,
    });
    return yield* retainPublicationResponse({ work, response });
  }).pipe(
    Effect.mapError((failure) =>
      failure instanceof StatementDocumentRefused ? failure : uncertainDocument()
    )
  );
const publishDocument = (
  work: DocumentWork
): Effect.Effect<StatementSubmission, StatementDocumentRefused> =>
  Effect.gen(function* () {
    const prior = yield* readHeldStatementDocumentSubmission(work);
    if (Option.isNone(prior)) return yield* publishNewDocument(work);
    const submission = yield* readSubmission({ work, id: prior.value });
    if (Option.isNone(submission)) return yield* uncertainDocument();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(
      submission.value
    );
    const output = yield* Schema.decodeEffect(CanonicalToolEvidence)({ data, next: [] });
    if (!(yield* recordOutcome({ work, outcome: { _tag: "Succeeded", output } }))) {
      return yield* uncertainDocument();
    }
    return submission.value;
  }).pipe(
    Effect.mapError((failure) =>
      failure instanceof StatementDocumentRefused ? failure : uncertainDocument()
    )
  );

const settlementReply = (submission: StatementSubmission): Option.Option<TranscriptText> => {
  switch (submission.status) {
    case "queued":
    case "processing":
      return Option.some(
        TranscriptText.make(
          "El extracto sigue procesándose. Las Transacciones ya capturadas son visibles; consulta el estado aquí."
        )
      );
    case "failed":
      return Option.some(
        TranscriptText.make(
          "No pude completar el extracto. Las Transacciones ya capturadas se conservan."
        )
      );
    case "abandoned":
      return Option.some(
        TranscriptText.make(
          "Se abandonó lo pendiente de este extracto. Las Transacciones ya capturadas se conservan."
        )
      );
    case "awaiting-clarification":
    case "completed":
      return Option.none();
  }
};
export const prepareStatementReadinessReply = (
  work: Readonly<{
    db: D1Database;
    caller: HostedCanonicalCaller;
    bucket: Option.Option<R2Bucket>;
    current: number;
  }>
): Effect.Effect<TranscriptText, Cause.UnknownError> =>
  Effect.gen(function* () {
    const response = yield* executeHostedStatementQuery({
      ...work,
      bucket: work.bucket,
      operation: "ingestion.listNeedsReviewItems",
      input: { query: { status: "pending", limit: "1" } },
    });
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    const page = Schema.decodeUnknownOption(ReviewResponse)(body);
    if (!response.ok || Option.isNone(page)) {
      return TranscriptText.make(
        "El extracto fue aceptado; no pude verificar su resultado. No lo vuelvas a adjuntar: consulta su estado en esta conversación."
      );
    }
    const first = page.value.data[0];
    return TranscriptText.make(
      first === undefined
        ? "El extracto está listo. Las Transacciones capturadas ya son visibles."
        : `Las Transacciones claras ya son visibles. Para la fila ${first.recordNumber}, indica fecha, importe, moneda y si es entrada o salida. También puedes pedir omitirla o cancelar lo pendiente. No envíes credenciales ni números de cuenta.`
    );
  });
// None keeps the original Turn Pending while the installed Workflow extracts the statement.
// Existing recovery alarms revisit readiness; neither a model loop nor this Turn drains chunks.
export const prepareStatementDocumentReply = (
  work: DocumentWork
): Effect.Effect<Option.Option<TranscriptText>> =>
  Effect.gen(function* () {
    const submitted = yield* publishDocument(work);
    const projection = yield* readSubmission({ work, id: submitted.id });
    if (Option.isNone(projection)) {
      return Option.some(
        TranscriptText.make(
          "El estado del extracto no está confirmado. Consulta su estado aquí; no vuelvas a adjuntarlo."
        )
      );
    }
    if (projection.value.status === "queued" || projection.value.status === "processing") {
      return Option.none();
    }
    const settled = settlementReply(projection.value);
    return yield* Option.isSome(settled)
      ? Effect.succeed(settled)
      : prepareStatementReadinessReply({ ...work, bucket: Option.some(work.bucket) }).pipe(
          Effect.asSome
        );
  }).pipe(
    Effect.catchTag("StatementDocumentRefused", (failure) =>
      Effect.succeedSome(
        TranscriptText.make(
          {
            "invalid-material":
              "No pude aceptar el archivo. Adjunta un CSV o XLSX válido; no envíes contraseñas, credenciales ni números de cuenta.",
            "media-unavailable":
              "No pude recuperar o verificar el archivo ahora. Intenta adjuntarlo más tarde; no envíes contraseñas, credenciales ni números de cuenta.",
            paywall:
              "Ya usaste la importación de extracto incluida en Free. Para importar más extractos, cambia a Pro desde la página de planes de fidy (/upgrade). No necesitas corregir el archivo.",
            "rate-limited":
              "Has alcanzado el límite de cargas de extractos. Espera antes de volver a intentarlo; no necesitas corregir el archivo.",
            uncertain:
              "El estado del extracto no está confirmado. Consulta su estado aquí; no vuelvas a adjuntarlo.",
          }[failure.reason]
        )
      )
    ),
    Effect.orElseSucceed(() =>
      Option.some(
        TranscriptText.make(
          "El estado del extracto no está confirmado. Consulta su estado aquí; no vuelvas a adjuntarlo."
        )
      )
    )
  );
