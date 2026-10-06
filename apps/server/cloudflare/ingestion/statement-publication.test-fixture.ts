import type { TransactionAuthority } from "../canonical-work/contract";
import { Effect, Option, Schema } from "effect";
import { StatementSubmission, SubmitForExtractionInput } from "../../src/shell/ingestion/contract";
import { callerAuthority } from "../canonical-work/operations";
import { transactionSession } from "../transactions/operations";
import { currentMillis } from "../runtime/operations";
import {
  type PreparedStatementPublication,
  prepareStagedStatementPublication,
  readOwnedStatementSubmission,
  recordStatementRefusal,
  statementAbortRefusal,
  statementRefusal,
  statementSubmissionCompletion,
  submissionProjection,
} from "./internal/statement-staging";
import {
  statementDailyBudgetResponse,
  statementRefusalResponse,
  unavailableStatement,
  uploadStagedStatement,
} from "./internal/statement-ingestion";
import { dailyAuditExhausted, refusedByAuditBudget } from "../../src/shell/audit/operations";

type Storage = Readonly<{ db: D1Database; bucket: R2Bucket }>;
type PublicationInput = Readonly<{
  index: number;
  idempotencyKey: string;
  reference: Readonly<{ stagingId: string; byteLength: number; sha256: string }>;
}>;
const bearerLength = 43;
const requestForOwner = (index: number): Request =>
  new Request("https://owner-fixture.internal", {
    headers: { cookie: `__Host-fidy_session=${String(index + 1).repeat(bearerLength)}` },
  });
const unauthenticated = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );

/** Exercise the ingestion owner's byte/resource adapter, not the closed browser upload route. */
export const stageOwnedStatement = ({
  storage,
  index,
  request,
}: Readonly<{ storage: Storage; index: number; request: Request }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const subject = yield* Effect.tryPromise(() =>
        transactionSession({
          db: storage.db,
          request: requestForOwner(index),
          current: currentMillis(),
        })
      );
      if (Option.isNone(subject)) return unauthenticated();
      return yield* uploadStagedStatement({
        environment: { DB: storage.db, STATEMENT_STAGING_BUCKET: storage.bucket },
        request,
        subject: subject.value,
      });
    }).pipe(Effect.orDie)
  );

const committedProjection = (
  storage: Storage,
  userId: string,
  submissionId: string
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const stored = yield* readOwnedStatementSubmission(
      { database: storage.db },
      { userId, submissionId }
    );
    const projected = Option.flatMap(stored, submissionProjection);
    if (Option.isNone(projected)) return unavailableStatement();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(
      projected.value
    );
    return Response.json({ data, next: [] }, { status: 202 });
  }).pipe(Effect.orDie);

const publicationAbort = ({
  storage,
  index,
  publication,
  authority,
  current,
  cause,
}: Readonly<{
  storage: Storage;
  index: number;
  publication: PreparedStatementPublication;
  authority: TransactionAuthority;
  current: number;
  cause: unknown;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (refusedByAuditBudget(cause)) return statementDailyBudgetResponse();
    if (
      Option.isNone(
        yield* Effect.tryPromise(() =>
          transactionSession({
            db: storage.db,
            request: requestForOwner(index),
            current: currentMillis(),
          })
        )
      )
    ) {
      return unauthenticated();
    }
    const refusal = yield* statementAbortRefusal(
      { database: storage.db, bucket: storage.bucket, nowEpochMs: (): number => current },
      publication
    );
    if (Option.isNone(refusal)) return unavailableStatement();
    yield* Effect.tryPromise(() =>
      recordStatementRefusal({ authority, current, database: storage.db, refusal: refusal.value })
    );
    return statementRefusalResponse(refusal.value);
  }).pipe(Effect.orDie);

const commitPublication = (
  work: Readonly<{
    storage: Storage;
    index: number;
    publication: PreparedStatementPublication;
    authority: TransactionAuthority;
    current: number;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const committed = yield* Effect.result(
      Effect.tryPromise(() =>
        work.storage.db.batch([
          ...work.publication.statements,
          work.storage.db.prepare(statementSubmissionCompletion),
        ])
      )
    );
    if (committed._tag === "Failure") {
      return yield* publicationAbort({ ...work, cause: committed.failure.cause });
    }
    return yield* committedProjection(
      work.storage,
      work.publication.attempt.userId,
      work.publication.submissionId
    );
  }).pipe(Effect.orDie);

/** Commit the owner's publication protocol for downstream platform tests. This creates no WhatsApp
 * origin and proves neither HTTP nor canonical batch access; channel journeys cover admission.
 */
export const publishOwnedStatement = ({
  storage,
  input,
}: Readonly<{ storage: Storage; input: PublicationInput }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const subject = yield* Effect.tryPromise(() =>
        transactionSession({
          db: storage.db,
          request: requestForOwner(input.index),
          current: currentMillis(),
        })
      );
      if (Option.isNone(subject)) return unauthenticated();
      const current = currentMillis();
      const config = {
        database: storage.db,
        bucket: storage.bucket,
        nowEpochMs: (): number => current,
      };
      if (
        yield* Effect.tryPromise(() =>
          dailyAuditExhausted({ db: storage.db, userId: subject.value.userId, current })
        )
      ) {
        return statementDailyBudgetResponse();
      }
      const parsed = yield* Schema.decodeEffect(SubmitForExtractionInput)(input);
      const authority = callerAuthority({ subject: subject.value, current });
      const prepared = yield* prepareStagedStatementPublication(config, {
        ...parsed,
        authority,
        current,
        userId: subject.value.userId,
      });
      if (prepared._tag === "Unavailable") return unavailableStatement();
      if (prepared._tag === "Refused") {
        const refusal = statementRefusal(prepared.reason);
        yield* Effect.tryPromise(() =>
          recordStatementRefusal({ authority, current, database: storage.db, refusal })
        );
        return statementRefusalResponse(refusal);
      }
      return yield* commitPublication({
        storage,
        index: input.index,
        publication: prepared.publication,
        authority,
        current,
      });
    }).pipe(Effect.orDie)
  );
