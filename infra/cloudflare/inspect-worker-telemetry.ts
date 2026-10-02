import type { OutboundHttpService } from "@fidy/server/outbound-http";
import { TelemetryRelease } from "@fidy/server/telemetry";
import { Data, Effect, Option, Schema } from "effect";

const halfWindowMilliseconds = 60_000;
const maximumEvents = 100;
const successfulQueryStatus = 200;
const unauthenticatedStatus = 401;
const forbiddenStatus = 403;
const Timestamp = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u));
const VersionId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
);
const WorkSummary = Schema.Struct({
  release: TelemetryRelease,
  operation: Schema.Literal("worker.core.fetch"),
  outcome: Schema.Literals(["succeeded", "rejected", "failed", "interrupted"]),
  statusClass: Schema.optionalKey(Schema.Literals(["1xx", "2xx", "3xx", "4xx", "5xx"])),
});
const Message = Schema.Struct({ message: Schema.String });
const QueryResponse = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    events: Schema.Struct({
      events: Schema.Array(
        Schema.Struct({
          timestamp: Schema.Int.check(
            Schema.isBetween({ minimum: 0, maximum: 253_402_300_799_999 })
          ),
          source: Schema.Unknown,
          $metadata: Schema.optionalKey(
            Schema.Struct({
              message: Schema.optionalKey(Schema.String),
              trigger: Schema.optionalKey(Schema.String),
            })
          ),
          $workers: Schema.optionalKey(
            Schema.Struct({
              scriptName: Schema.String,
              scriptVersion: Schema.optionalKey(Schema.Struct({ id: VersionId })),
              event: Schema.optionalKey(
                Schema.Struct({
                  request: Schema.optionalKey(Schema.Struct({ method: Schema.String })),
                })
              ),
            })
          ),
        })
      ).check(Schema.isMaxLength(maximumEvents)),
    }),
  }),
});

class TelemetryInspectionFailed extends Data.TaggedError("TelemetryInspectionFailed")<{
  readonly reason: "invalid-time" | "query-denied" | "query-failed" | "invalid-response";
}> {}

// Effect's default console logger formats objects as inspect text rather than JSON. Extract only
// closed fields from that representation; never print the original string, including on failure.
const inspectTextSummary = (text: string): Option.Option<typeof WorkSummary.Type> =>
  Schema.decodeUnknownOption(WorkSummary)({
    release: /\brelease:\s*"([0-9a-f]{40}|unknown)"/u.exec(text)?.[1],
    operation: /\boperation:\s*"(worker\.core\.fetch)"/u.exec(text)?.[1],
    outcome: /\boutcome:\s*"(succeeded|rejected|failed|interrupted)"/u.exec(text)?.[1],
    ...Option.match(
      Schema.decodeUnknownOption(Schema.Literals(["1xx", "2xx", "3xx", "4xx", "5xx"]))(
        /\bstatusClass:\s*"([1-5]xx)"/u.exec(text)?.[1]
      ),
      {
        onNone: () => ({}),
        onSome: (statusClass) => ({ statusClass }),
      }
    ),
  });

const workSummary = (
  source: unknown,
  metadataMessage: Option.Option<string>
): Option.Option<typeof WorkSummary.Type> =>
  Schema.decodeUnknownOption(WorkSummary)(source).pipe(
    Option.orElse(() => {
      const message = Schema.decodeUnknownOption(Schema.String)(source).pipe(
        Option.orElse(() =>
          Schema.decodeUnknownOption(Message)(source).pipe(Option.map((value) => value.message))
        ),
        Option.orElse(() => metadataMessage)
      );
      return message.pipe(
        Option.flatMap((text) =>
          Schema.decodeUnknownOption(Schema.fromJsonString(WorkSummary))(text).pipe(
            Option.orElse(() => inspectTextSummary(text))
          )
        )
      );
    })
  );

type WorkerLogEvent = (typeof QueryResponse.Type)["result"]["events"]["events"][number];
const LogMethod = Schema.Literals(["GET", "POST"]);
const logMethod = (event: WorkerLogEvent): Option.Option<typeof LogMethod.Type> =>
  Schema.decodeUnknownOption(LogMethod)(
    event.$workers?.event?.request?.method ?? event.$metadata?.trigger?.split(/\s/u, 1)[0]
  );

const projectQueryReport = (
  decoded: typeof QueryResponse.Type,
  window: Readonly<{ from: number; to: number; workerName: string }>
): string => {
  const events = decoded.result.events.events;
  const records = events.flatMap((event) => {
    if (
      event.timestamp < window.from ||
      event.timestamp > window.to ||
      event.$workers?.scriptName !== window.workerName
    ) {
      return [];
    }
    return Option.match(
      workSummary(event.source, Option.fromUndefinedOr(event.$metadata?.message)),
      {
        onNone: () => [],
        onSome: (work) => [
          {
            timestamp: new Date(event.timestamp).toISOString(),
            version: event.$workers?.scriptVersion?.id ?? "unavailable",
            release: work.release,
            method: Option.getOrElse(logMethod(event), () => "unavailable"),
            statusClass: work.statusClass ?? "unavailable",
            outcome: work.outcome,
          },
        ],
      }
    );
  });
  return JSON.stringify({
    inspectedEvents: events.length,
    unprojectedEvents: events.length - records.length,
    possiblyTruncated: events.length === maximumEvents,
    records,
    evidence: "Time-window observations only; not proof of a particular smoke request's identity.",
  });
};

/**
 * Reads an existing Core log window, returning only validated release/version, HTTP method,
 * status class, outcome, and time. At most 100 records are inspected; missing/unrecognized logs
 * are explicitly inconclusive. No raw log content or provider errors are returned or persisted.
 */
export const inspectWorkerTelemetry = Effect.fn(function* (
  input: Readonly<{
    timestamp: string;
    workerName: string;
    outbound: OutboundHttpService;
  }>
) {
  const timestamp = yield* Schema.decodeUnknownEffect(Timestamp)(input.timestamp).pipe(
    Effect.mapError(() => new TelemetryInspectionFailed({ reason: "invalid-time" }))
  );
  const center = Date.parse(timestamp);
  if (
    !Number.isFinite(center) ||
    center < halfWindowMilliseconds ||
    new Date(center).toISOString() !== timestamp.replace("Z", ".000Z")
  ) {
    return yield* Effect.fail(new TelemetryInspectionFailed({ reason: "invalid-time" }));
  }
  const from = center - halfWindowMilliseconds;
  const to = center + halfWindowMilliseconds;
  const response = yield* input.outbound
    .execute({
      _tag: "CloudflareWorkerTelemetry",
      workerName: input.workerName,
      from,
      to,
    })
    .pipe(Effect.mapError(() => new TelemetryInspectionFailed({ reason: "query-failed" })));
  if (response.status !== successfulQueryStatus) {
    return yield* Effect.fail(
      new TelemetryInspectionFailed({
        reason:
          response.status === unauthenticatedStatus || response.status === forbiddenStatus
            ? "query-denied"
            : "query-failed",
      })
    );
  }
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QueryResponse))(
    new TextDecoder().decode(response.body)
  ).pipe(Effect.mapError(() => new TelemetryInspectionFailed({ reason: "invalid-response" })));
  return projectQueryReport(decoded, { from, to, workerName: input.workerName });
});

/** Best-effort operational report; no foreign Cause or log text crosses this boundary. */
export const inspectWorkerTelemetryReport = (
  input: Parameters<typeof inspectWorkerTelemetry>[0]
): Effect.Effect<string> =>
  inspectWorkerTelemetry(input).pipe(
    Effect.timeout("30 seconds"),
    Effect.catchTag("TelemetryInspectionFailed", (failure) =>
      Effect.succeed(`Core telemetry unavailable (${failure.reason}).`)
    ),
    Effect.catchCause(() => Effect.succeed("Core telemetry unavailable (timeout or interruption)."))
  );
