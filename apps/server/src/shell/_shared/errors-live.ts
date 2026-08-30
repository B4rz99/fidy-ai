import { Effect, Option, Result, Schema, SchemaIssue } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  type HttpApiEndpoint,
  type HttpApiError,
  HttpApiMiddleware,
} from "effect/unstable/httpapi";
import { type FieldIssue, ValidationFailed, ValidationGate } from "./errors";

/** How each rejected request component is named to the caller. */
const requestPart: Record<
  Exclude<HttpApiError.HttpApiSchemaError["kind"], "Body" | "ResponseHeaders">,
  string
> = {
  Params: "path parameters",
  Query: "query string",
  Headers: "headers",
  Payload: "request body",
};

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => {
    switch (issue._tag) {
      case "MissingKey":
        return "Missing key";
      case "UnexpectedKey":
        return "Unexpected key";
      case "OneOf":
        return "Expected exactly one schema member to match";
      case "Forbidden":
        return "Expected an operation allowed by this schema";
      case "InvalidValue":
        return "Expected a value accepted by this schema";
      case "InvalidType":
        return SchemaIssue.defaultLeafHook(issue).replace(/, got[\s\S]*$/u, "");
    }
  },
  checkHook: (issue) => {
    const annotated = SchemaIssue.defaultCheckHook(issue);
    if (annotated !== undefined) return annotated;
    if (issue.issue._tag !== "InvalidValue") return undefined;

    const expected = issue.filter.annotations?.expected;
    return typeof expected === "string"
      ? `Expected ${expected}`
      : "Expected a value satisfying this schema's constraints";
  },
});

/** A `PropertyKey`, or the `{ key }` wrapper Standard Schema also permits. */
const segmentName = (segment: PropertyKey | { readonly key: PropertyKey }): string =>
  typeof segment === "object" ? String(segment.key) : String(segment);

/**
 * Which value an issue is about, as a dotted path. `None` when the formatter
 * gave nothing to name, such as a body rejected as a whole. Payload failures
 * against a single schema are decoded without the framework's union wrapper
 * before reaching here, so a discriminating literal still names its field.
 *
 * The filter is on the joined path, not the segment count: it is the string
 * that has to satisfy `FieldIssue.path`'s `NonEmptyString`, and a lone empty
 * segment would otherwise encode as `""` and turn a 400 into a response-encode
 * failure.
 */
const issuePath = (
  segments: Option.Option<ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>>
): Option.Option<string> =>
  segments.pipe(
    Option.map((present) => present.map(segmentName).join(".")),
    Option.filter((path) => path.length > 0)
  );

const fieldIssues = (cause: Schema.SchemaError): ReadonlyArray<typeof FieldIssue.Type> =>
  formatIssue(cause.issue).issues.map((issue) =>
    Option.match(issuePath(Option.fromUndefinedOr(issue.path)), {
      onNone: () => ({
        message: "Expected the whole value to match this operation's input schema.",
      }),
      onSome: (path) => ({ path, message: issue.message }),
    })
  );

/**
 * Narrows the service requirement erased by `HttpApiEndpoint.Top`. Canonical
 * payload schemas come from core, whose compile-time fence requires `never`
 * services (ARCHITECTURE.md §3); the runtime schema cannot expose that phantom
 * type for a structural check.
 */
const isServiceFreePayloadSchema = (schema: Schema.Top): schema is Schema.Codec<unknown, unknown> =>
  Reflect.has(schema, "ast");

/**
 * Re-checks a rejected JSON value against its one declared payload schema.
 * HttpApiBuilder always wraps payload schemas in a union and decodes with the
 * default first-error mode. The wrapper can discard the field issue when a
 * literal candidate does not match; decoding the member directly with all
 * errors preserves both field paths and the complete correction list.
 *
 * Multiple payload schemas represent content negotiation. Without the request
 * content type at this middleware seam, choosing one would risk publishing
 * issues from the wrong operation schema, so those retain the framework's
 * original issue tree.
 */
const payloadFieldIssues = (
  cause: Schema.SchemaError,
  endpoint: HttpApiEndpoint.Top
): Effect.Effect<
  ReadonlyArray<typeof FieldIssue.Type>,
  never,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const schemas = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas);
    const [schema, ...additionalSchemas] = schemas;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const actual = yield* Effect.option(request.json);

    if (
      schema === undefined ||
      additionalSchemas.length > 0 ||
      Option.isNone(actual) ||
      !isServiceFreePayloadSchema(schema)
    ) {
      return fieldIssues(cause);
    }

    return Result.match(Schema.decodeResult(schema, { errors: "all" })(actual.value), {
      onFailure: fieldIssues,
      onSuccess: () => fieldIssues(cause),
    });
  });

/**
 * Maps HTTP schema failures to the canonical `ValidationFailed` response. Invalid requests receive
 * a 400 response with request-part field issues; failures encoding a server response receive 500.
 */
export const ValidationGateLive = HttpApiMiddleware.layerSchemaErrorTransform(
  ValidationGate,
  (schemaError, { endpoint }) =>
    Effect.gen(function* () {
      if (schemaError.kind === "Body" || schemaError.kind === "ResponseHeaders") {
        return HttpServerResponse.empty({ status: 500 });
      }

      const kind = schemaError.kind;
      const fields =
        kind === "Payload"
          ? yield* payloadFieldIssues(schemaError.cause, endpoint)
          : fieldIssues(schemaError.cause);

      return yield* ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            `The ${requestPart[kind]} did not satisfy this operation's input schema. ` +
            `Correct every value listed in error.fields and send the request again.`,
          fields,
        },
        next: [],
      });
    })
);
