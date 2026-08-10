import { Effect, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import {
  type DeploymentSmokeEmission,
  deploymentSmokeForbiddenSentinels,
} from "./deployment-smoke";
import {
  type SentryDeploymentSmokeObservation,
  type SentryDeploymentSmokeTraceNode,
  SentryDeploymentSmokeTraceOperation,
} from "./deployment-smoke-gate";
import { strictDecoding } from "./decoding";
import { ProjectedTraceData } from "./projectors";
import type { TelemetryRelease } from "./telemetry-config";

const maximumStringLength = 300;
const maximumIdentifierLength = 64;
const maximumTraceChildren = 20;
const maximumEvents = 10;
const maximumTraceRoots = 5;
const firstSuccessStatus = 200;
const firstRedirectionStatus = 300;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const notFoundStatus = 404;
const rateLimitedStatus = 429;
const firstServerErrorStatus = 500;
const boundedString = Schema.String.check(Schema.isMaxLength(maximumStringLength));
const Identifier = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]+$/u),
  Schema.isMaxLength(maximumIdentifierLength)
);
const Tag = Schema.Struct({ key: boundedString, value: boundedString });
const Frame = Schema.Struct({
  module: Schema.NullOr(boundedString),
  filename: Schema.NullOr(boundedString),
  function: Schema.NullOr(boundedString),
  lineNo: Schema.NullOr(Schema.Int),
});
const ExceptionEntry = Schema.Struct({
  type: Schema.Literal("exception"),
  data: Schema.Struct({
    values: Schema.Array(
      Schema.Struct({
        type: boundedString,
        value: boundedString,
        stacktrace: Schema.Struct({ frames: Schema.Array(Frame).check(Schema.isMaxLength(100)) }),
      })
    ).check(Schema.isMaxLength(2)),
  }),
});
const Event = Schema.Struct({
  eventID: Schema.optionalKey(Identifier),
  id: Schema.optionalKey(Identifier),
  message: Schema.NullOr(boundedString),
  user: Schema.Unknown,
  tags: Schema.Array(Tag).check(Schema.isMaxLength(100)),
  entries: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(maximumTraceChildren)),
  contexts: Schema.Unknown,
});
const Issues = Schema.Array(
  Schema.Struct({ id: Identifier, count: Schema.String.check(Schema.isPattern(/^\d+$/u)) })
).check(Schema.isMaxLength(2));
const Events = Schema.Array(Event).check(Schema.isMaxLength(maximumEvents));

type RawTraceNode = Readonly<{
  transaction: Option.Option<unknown>;
  description: Option.Option<unknown>;
  op: string;
  tags: Option.Option<unknown>;
  data: Option.Option<unknown>;
  children: ReadonlyArray<RawTraceNode>;
}>;
const RawTraceNode: Schema.Codec<RawTraceNode, unknown> = Schema.suspend(() =>
  Schema.Struct({
    transaction: Schema.OptionFromOptionalKey(Schema.Unknown),
    description: Schema.OptionFromOptionalKey(Schema.Unknown),
    op: boundedString,
    tags: Schema.OptionFromOptionalKey(Schema.Unknown),
    data: Schema.OptionFromOptionalKey(Schema.Unknown),
    children: Schema.Array(RawTraceNode).check(Schema.isMaxLength(maximumTraceChildren)),
  })
);
const Trace = Schema.Array(RawTraceNode).check(Schema.isMaxLength(maximumTraceRoots));

/** Fixed read failure carrying no response body, search locator, or credentials. */
export class SentrySmokeReadError extends Schema.TaggedErrorClass<SentrySmokeReadError>()(
  "SentrySmokeReadError",
  {
    reason: Schema.Literals([
      "unauthorized",
      "forbidden",
      "rate-limited",
      "unavailable",
      "not-ingested",
      "unexpected-response",
    ]),
  }
) {}

/** Secret coordinates used only to issue bounded read-only Sentry API requests. */
export type SentrySmokeReaderConfig = Readonly<{
  authToken: Redacted.Redacted;
  organizationSlug: Redacted.Redacted;
  projectSlug: Redacted.Redacted;
}>;

const maximumResponseBytes = 262_144;
const requestTimeout = "10 seconds";
const reasonForStatus = (status: number): SentrySmokeReadError["reason"] => {
  switch (status) {
    case unauthorizedStatus:
      return "unauthorized";
    case forbiddenStatus:
      return "forbidden";
    case notFoundStatus:
      return "not-ingested";
    case rateLimitedStatus:
      return "rate-limited";
    default:
      return status >= firstServerErrorStatus ? "unavailable" : "unexpected-response";
  }
};

const hasAnotherPage = (link: string): boolean =>
  link.split(",").some((part) => part.includes('rel="next"') && part.includes('results="true"'));

const readText = (
  url: string,
  token: Redacted.Redacted
): Effect.Effect<string, SentrySmokeReadError, HttpClient.HttpClient> =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.bearerToken(Redacted.value(token)),
    HttpClientRequest.acceptJson,
    HttpClient.execute,
    Effect.filterOrFail(
      (response) =>
        response.status >= firstSuccessStatus && response.status < firstRedirectionStatus,
      (response) => SentrySmokeReadError.make({ reason: reasonForStatus(response.status) })
    ),
    Effect.filterOrFail(
      (response) => !hasAnotherPage(response.headers["link"] ?? ""),
      () => SentrySmokeReadError.make({ reason: "unexpected-response" })
    ),
    Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
      Stream.runFoldEffect(
        response.stream,
        (): { chunks: Array<Uint8Array>; size: number } => ({ chunks: [], size: 0 }),
        (body, chunk) =>
          body.size + chunk.byteLength > maximumResponseBytes
            ? Effect.fail(SentrySmokeReadError.make({ reason: "unexpected-response" }))
            : Effect.succeed({
                chunks: [...body.chunks, chunk],
                size: body.size + chunk.byteLength,
              })
      )
    ),
    Effect.timeout(requestTimeout),
    Effect.map(({ chunks, size }) => {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }),
    Effect.mapError((error) =>
      Schema.is(SentrySmokeReadError)(error)
        ? error
        : SentrySmokeReadError.make({ reason: "unexpected-response" })
    )
  );

const decode: <A>(
  schema: Schema.Codec<A, unknown>,
  text: string
) => Effect.Effect<A, SentrySmokeReadError> = (schema, text) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => SentrySmokeReadError.make({ reason: "unexpected-response" }))
  );

const tagsOf = (event: typeof Event.Type): ReadonlyMap<string, string> =>
  new Map(event.tags.map((tag) => [tag.key, tag.value] as const));

const objectProperty = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? Reflect.get(value, key) : undefined;

const allowedEventTags = new Set([
  "component",
  "environment",
  "error",
  "handled",
  "level",
  "mechanism",
  "operation",
  "release",
  "retryable",
  "runtime",
  "runtime.name",
  "transaction",
]);

const safeEventChannels = (event: typeof Event.Type): boolean => {
  const entryTypes = event.entries.map((entry) => objectProperty(entry, "type"));
  const contextKeys = Predicate.isObject(event.contexts) ? Object.keys(event.contexts) : [];
  const traceContext = objectProperty(event.contexts, "trace");
  const traceContextKeys = Predicate.isObject(traceContext) ? Object.keys(traceContext) : [];
  return [
    event.user === null || event.user === undefined,
    event.message === null || event.message === "",
    entryTypes.length === 1,
    entryTypes[0] === "exception",
    Option.isSome(Schema.decodeUnknownOption(ExceptionEntry, strictDecoding)(event.entries[0])),
    contextKeys.every((key) => key === "trace"),
    traceContextKeys.every((key) =>
      ["op", "parent_span_id", "span_id", "trace_id", "type"].includes(key)
    ),
    event.tags.every((tag) => allowedEventTags.has(tag.key)),
  ].every(Boolean);
};

const allowedTraceTags = new Set([...allowedEventTags, "outcome", "trigger", "work_kind"]);

const safeTraceChannels = (node: RawTraceNode): boolean => {
  const tags = Option.match(node.tags, {
    onNone: () => true,
    onSome: (value) => {
      const decoded = Schema.decodeUnknownOption(Schema.Array(Tag))(value);
      return Option.isSome(decoded) && decoded.value.every((tag) => allowedTraceTags.has(tag.key));
    },
  });
  const data = Option.match(node.data, {
    onNone: () => true,
    onSome: (value) =>
      Option.isSome(Schema.decodeUnknownOption(ProjectedTraceData, strictDecoding)(value)),
  });
  return tags && data && node.children.every(safeTraceChannels);
};

const projectTraceNode = (node: RawTraceNode): Option.Option<SentryDeploymentSmokeTraceNode> => {
  const transaction = Option.filter(node.transaction, Predicate.isString);
  const description = Option.filter(node.description, Predicate.isString);
  const name = Option.orElse(transaction, () => description);
  if (Option.isNone(name)) return Option.none();
  const op = Schema.decodeUnknownOption(SentryDeploymentSmokeTraceOperation)(node.op);
  if (Option.isNone(op)) return Option.none();
  const children = node.children.map(projectTraceNode);
  return children.every(Option.isSome)
    ? Option.some({
        name: name.value,
        op: op.value,
        children: children.map((child) => child.value),
      })
    : Option.none();
};

type ProjectionInput = Readonly<{
  release: TelemetryRelease;
  emission: DeploymentSmokeEmission;
  flushCompleted: boolean;
  issuesJson: string;
  expectedOutcomeIssuesJson: string;
  eventsJson: string;
  traceJson: string;
}>;

type DecodedResponses = Readonly<{
  issues: typeof Issues.Type;
  expectedIssues: typeof Issues.Type;
  events: typeof Events.Type;
  traces: typeof Trace.Type;
}>;

type ProjectedEvent = Readonly<{
  exception: (typeof ExceptionEntry.Type)["data"]["values"][number];
  frame: typeof Frame.Type;
  trace: SentryDeploymentSmokeTraceNode;
  traceId: string;
}>;

const tagValue = (tags: ReadonlyMap<string, string>, key: string): string =>
  Option.getOrElse(Option.fromUndefinedOr(tags.get(key)), () => "");

const makeObservation = (
  input: Readonly<{
    projection: ProjectionInput;
    decoded: DecodedResponses;
    event: typeof Event.Type;
    projected: ProjectedEvent;
  }>
): SentryDeploymentSmokeObservation => {
  const { decoded, event, projected, projection } = input;
  const tags = tagsOf(event);
  const raw = `${projection.eventsJson}\n${projection.traceJson}`;
  return {
    flushCompleted: projection.flushCompleted,
    issueCount: decoded.issues.length,
    eventCount: decoded.events.length,
    release: tagValue(tags, "release"),
    traceId: projected.traceId,
    defect: {
      component: tagValue(tags, "component"),
      operation: tagValue(tags, "operation"),
      error: tagValue(tags, "error"),
      exceptionType: projected.exception.type,
      exceptionValue: projected.exception.value,
      source: {
        module: Option.getOrElse(Option.fromNullOr(projected.frame.module), () => ""),
        file: Option.getOrElse(Option.fromNullOr(projected.frame.filename), () => ""),
        function: Option.getOrElse(Option.fromNullOr(projected.frame.function), () => ""),
        line: Option.getOrElse(Option.fromNullOr(projected.frame.lineNo), () => 0),
      },
    },
    trace: projected.trace,
    expectedOutcomeIssueCount: decoded.expectedIssues.length,
    projectedFieldsOnly:
      safeEventChannels(event) &&
      Option.exists(Option.fromUndefinedOr(decoded.traces[0]), safeTraceChannels),
    sentinelsAbsent: deploymentSmokeForbiddenSentinels.every((sentinel) => !raw.includes(sentinel)),
  };
};

const projectObservation = (
  input: ProjectionInput,
  decoded: DecodedResponses
): Effect.Effect<SentryDeploymentSmokeObservation, SentrySmokeReadError> => {
  if (
    [decoded.issues.length !== 1, decoded.events.length === 0, decoded.traces.length !== 1].some(
      Boolean
    )
  ) {
    return Effect.fail(SentrySmokeReadError.make({ reason: "not-ingested" }));
  }
  const event = decoded.events[0];
  const root = decoded.traces[0];
  if (event === undefined || root === undefined) {
    return Effect.fail(SentrySmokeReadError.make({ reason: "not-ingested" }));
  }
  const exception = Option.flatMap(
    Schema.decodeUnknownOption(ExceptionEntry, strictDecoding)(event.entries[0]),
    (entry) => Option.fromUndefinedOr(entry.data.values[0])
  );
  const frame = Option.flatMap(exception, (value) =>
    Option.fromUndefinedOr(
      value.stacktrace.frames.find(
        (candidate) => candidate.function === "raiseDeploymentSmokeDefect"
      )
    )
  );
  const trace = projectTraceNode(root);
  const traceId = Option.filter(
    Option.fromUndefinedOr(objectProperty(objectProperty(event.contexts, "trace"), "trace_id")),
    Predicate.isString
  );
  const projected = Option.all({ exception, frame, trace, traceId });
  return Option.match(projected, {
    onNone: () => Effect.fail(SentrySmokeReadError.make({ reason: "unexpected-response" })),
    onSome: (value) =>
      Effect.succeed(makeObservation({ projection: input, decoded, event, projected: value })),
  });
};

/** Projects bounded issue/event/trace API bodies into the closed rollout observation. */
export const projectDeploymentSmokeResponses = (
  input: ProjectionInput
): Effect.Effect<SentryDeploymentSmokeObservation, SentrySmokeReadError> =>
  Effect.all({
    issues: decode(Issues, input.issuesJson),
    expectedIssues: decode(Issues, input.expectedOutcomeIssuesJson),
    events: decode(Events, input.eventsJson),
    traces: decode(Trace, input.traceJson),
  }).pipe(Effect.flatMap((decoded) => projectObservation(input, decoded)));

const apiUrl = (path: string): string => `https://sentry.io/api/0${path}`;
const query = (value: string): string => encodeURIComponent(value);

/** Retrieves the synthetic issue, full event, expected-outcome search, and trace once. */
export const inspectDeploymentSmoke = (
  input: Readonly<{
    config: SentrySmokeReaderConfig;
    release: TelemetryRelease;
    emission: DeploymentSmokeEmission;
    flushCompleted: boolean;
  }>
): Effect.Effect<SentryDeploymentSmokeObservation, SentrySmokeReadError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const organization = encodeURIComponent(Redacted.value(input.config.organizationSlug));
    const project = encodeURIComponent(Redacted.value(input.config.projectSlug));
    const issueQuery = `release:${input.release} operation:observability.deploymentSmokeDefect error:deployment_smoke_defect`;
    const expectedQuery = `release:${input.release} operation:observability.deploymentSmokeExpectedOutcome`;
    const issuesJson = yield* readText(
      apiUrl(
        `/projects/${organization}/${project}/issues/?statsPeriod=24h&limit=2&query=${query(issueQuery)}`
      ),
      input.config.authToken
    );
    const issues = yield* decode(Issues, issuesJson);
    const issue = issues[0];
    if (issue === undefined) return yield* SentrySmokeReadError.make({ reason: "not-ingested" });
    const eventsJson = yield* readText(
      apiUrl(
        `/organizations/${organization}/issues/${issue.id}/events/?statsPeriod=24h&full=true&per_page=10&query=${query(`release:${input.release}`)}`
      ),
      input.config.authToken
    );
    const expectedOutcomeIssuesJson = yield* readText(
      apiUrl(
        `/projects/${organization}/${project}/issues/?statsPeriod=24h&limit=2&query=${query(expectedQuery)}`
      ),
      input.config.authToken
    );
    const traceJson = yield* readText(
      apiUrl(`/organizations/${organization}/trace/${input.emission.traceId}/?statsPeriod=24h`),
      input.config.authToken
    );
    return yield* projectDeploymentSmokeResponses({
      release: input.release,
      emission: input.emission,
      flushCompleted: input.flushCompleted,
      issuesJson,
      expectedOutcomeIssuesJson,
      eventsJson,
      traceJson,
    });
  });
