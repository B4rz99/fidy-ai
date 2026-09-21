import { expect, layer } from "@effect/vitest";
import { Effect, Encoding, Layer, Logger, Schema } from "effect";
import { SqlError } from "effect/unstable/sql";
import { Base64FileContent, StatementIdempotencyKey } from "~/core/ingestion/model";
import { UnknownJsonString } from "~/shell/schema-codecs/contract";
import { MigrationSqlClient } from "~/shell/testing/database-harness";
import { defaultUserId } from "~/shell/testing/development-seed";
import { EnvelopeRecorder } from "~/shell/testing/telemetry-harness";
import { ApiHarnessClient, ApiTelemetryHarness } from "~/shell/testing/api-harness";
import { StatementColumnMapper, StatementColumnMappingFailed } from "./column-mapper";
import { truncateStatementIngestion } from "./fixtures";
import { processNextStatement } from "./worker";

const statementCell = "statement-cell-sentinel";
const statementHeader = "statement-header-sentinel";
const statementFileContent = "statement-file-content-sentinel";
const userIdentifier = "statement-user-identifier-sentinel";
const sqlDetail = "statement-sql-detail-sentinel";
const providerDiagnostic = "statement-provider-diagnostic-sentinel";
const forbiddenValues = [
  statementCell,
  statementHeader,
  statementFileContent,
  userIdentifier,
  defaultUserId,
  sqlDetail,
  providerDiagnostic,
] as const;

const hostileDefect = Object.assign(new Error(providerDiagnostic), {
  cell: statementCell,
  header: statementHeader,
  fileContent: statementFileContent,
  userId: userIdentifier,
  sql: sqlDetail,
});
const transientMappingFailure = Object.assign(
  new StatementColumnMappingFailed({ safeReason: "provider-unavailable" }),
  { providerDiagnostic, statementCell }
);
const infrastructureFailure = SqlError.SqlError.make({
  reason: SqlError.ConnectionError.make({
    cause: new Error(providerDiagnostic),
    message: sqlDetail,
    operation: statementFileContent,
  }),
});

const FailureMapper = Layer.succeed(
  StatementColumnMapper,
  StatementColumnMapper.of({
    mapColumns: (sample) => {
      const header = sample.headers[0];
      if (header === "transient-mapping") return Effect.fail(transientMappingFailure);
      if (header === "permanent-mapping") {
        return Effect.fail(
          Object.assign(new StatementColumnMappingFailed({ safeReason: "permanent-failure" }), {
            providerDiagnostic,
            statementCell,
          })
        );
      }
      if (header === "transient-infrastructure") return Effect.die(infrastructureFailure);
      return Effect.die(hostileDefect);
    },
  })
);

const SanitizationHarness = Layer.merge(ApiTelemetryHarness, FailureMapper);

const QueueFailureRow = Schema.Struct({
  attempts: Schema.Int,
  completed: Schema.Boolean,
  lastFailure: Schema.NullOr(Schema.String),
});

const submitStatement = Effect.fn(function* (idempotencyKey: string, header: string) {
  const client = yield* ApiHarnessClient;
  return yield* client.ingestion.submitForExtraction({
    payload: {
      idempotencyKey: StatementIdempotencyKey.make(idempotencyKey),
      file: {
        name: "statement.csv",
        declaredMediaType: "text/csv",
        contentBase64: Base64FileContent.make(
          Encoding.encodeBase64(
            `${header},Amount,Description,Type\n2020-02-05,25000,${statementCell},DEBIT\n`
          )
        ),
      },
    },
  });
});

const captureQueueAttempt = Effect.fn(function* (id: string) {
  const sql = yield* MigrationSqlClient;
  const logs: Array<string> = [];
  const logger = Logger.make(({ message }) =>
    logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message))
  );
  const recorder = yield* EnvelopeRecorder;

  yield* processNextStatement().pipe(Effect.withLogger(logger));

  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(QueueFailureRow))(
    yield* sql`
      SELECT attempts, state = 'completed' AS completed, last_failure AS "lastFailure"
      FROM fidy_durable.fidy_queue
      WHERE queue_name = 'statement-ingestion' AND id = ${id}
    `
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  const observableText = yield* Schema.encodeEffect(UnknownJsonString)({
    row,
    logs,
    telemetry: (yield* recorder.serializedEnvelopes).map((bytes) =>
      new TextDecoder().decode(bytes)
    ),
  });
  for (const forbidden of forbiddenValues) {
    expect(observableText).not.toContain(forbidden);
  }
  return row;
});

layer(SanitizationHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "statement queue handler sanitization",
  (it) => {
    it.effect("stores and observes only bounded metadata for an unexpected statement defect", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const submitted = yield* submitStatement(
          "f1d1a000-0000-4000-8000-00000000f549",
          statementHeader
        );

        const row = yield* captureQueueAttempt(submitted.data.id);
        expect(row).toMatchObject({ attempts: 1, completed: false });
        expect(row?.lastFailure).toContain('"reason":"unexpected-defect"');
      })
    );

    it.effect("retries a mapping outage with only the stable transient marker", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const submitted = yield* submitStatement(
          "f1d1a000-0000-4000-8000-00000000f550",
          "transient-mapping"
        );

        const row = yield* captureQueueAttempt(submitted.data.id);
        expect(row).toMatchObject({ attempts: 1, completed: false });
        expect(row?.lastFailure).toContain('"reason":"transient"');
      })
    );

    it.effect("retries a database outage with only the stable transient marker", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const submitted = yield* submitStatement(
          "f1d1a000-0000-4000-8000-00000000f551",
          "transient-infrastructure"
        );

        const row = yield* captureQueueAttempt(submitted.data.id);
        expect(row).toMatchObject({ attempts: 1, completed: false });
        expect(row?.lastFailure).toContain('"reason":"transient"');
      })
    );

    it.effect("completes a permanent mapping failure without retrying", () =>
      Effect.gen(function* () {
        yield* truncateStatementIngestion;
        const submitted = yield* submitStatement(
          "f1d1a000-0000-4000-8000-00000000f552",
          "permanent-mapping"
        );

        const row = yield* captureQueueAttempt(submitted.data.id);
        expect(row).toEqual({ attempts: 1, completed: true, lastFailure: null });
        const client = yield* ApiHarnessClient;
        const status = yield* client.ingestion.getStatementSubmission({
          params: { id: submitted.data.id },
        });
        expect(status.data).toMatchObject({ status: "completed" });
      })
    );
  }
);
