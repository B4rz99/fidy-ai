import { Effect, Option, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import { getBoundOperationCatalog } from "../../../src/shell/canonical-catalog/contract";
import {
  atomicBatchOperation,
  getAtomicBatchInputSchema,
} from "../../../src/shell/operations/contract";
import { userOwnedAgentCapability } from "../../../src/shell/canonical-policy/contract";
import type { CanonicalCapability } from "../../../src/core/canonical-operations/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { CanonicalAdmissionUnavailable } from "../contract";
import { RequestBodyPolicy } from "../../http/contract";

const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1048576,
  deadlineMilliseconds: 5000,
});

export const normalized = (input: Schema.Json): Schema.Json => {
  if (Array.isArray(input)) return input.map(normalized);

  if (
    input === null ||
    Predicate.isString(input) ||
    Predicate.isNumber(input) ||
    Predicate.isBoolean(input)
  ) {
    return input;
  }

  return Object.fromEntries(
    Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, normalized(value)])
  );
};

const requestParams = (request: Request, operation: CatalogOperation): Schema.Json => {
  const actual = new URL(request.url).pathname.split("/");

  return Object.fromEntries(
    operation.route
      .split("/")
      .flatMap((segment, index): ReadonlyArray<readonly [string, string]> =>
        segment.startsWith(":") ? [[segment.slice(1), decodeURIComponent(actual[index] ?? "")]] : []
      )
  );
};

const requestQuery = (request: Request): Schema.Json => {
  const url = new URL(request.url);

  return Object.fromEntries(
    [...new Set(url.searchParams.keys())].flatMap(
      (key): ReadonlyArray<readonly [string, string | ReadonlyArray<string>]> => {
        const values = url.searchParams.getAll(key);
        const first = values[0];

        return first === undefined ? [] : [[key, values.length === 1 ? first : values]];
      }
    )
  );
};

const rawInput = ({
  request,
  operation,
}: Readonly<{ request: Request; operation: CatalogOperation }>): Effect.Effect<
  Option.Option<unknown>
> =>
  Effect.gen(function* () {
    const fields: Record<"params" | "query" | "headers" | "payload", Option.Option<Schema.Json>> = {
      params: Option.none(),
      query: Option.none(),
      headers: Option.none(),
      payload: Option.none(),
    };

    if (operation.httpFields.includes("params")) {
      fields.params = Option.some(requestParams(request, operation));
    }

    if (operation.httpFields.includes("query")) {
      fields.query = Option.some(requestQuery(request));
    }

    if (operation.httpFields.includes("headers")) {
      fields.headers = Option.some(Object.fromEntries(request.headers));
    }

    if (operation.httpFields.includes("payload")) {
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      ) {
        return Option.none();
      }

      const bytes = yield* readBoundedRequestBody(
        new Request(request.url, {
          method: request.method,
          body: request.clone().body,
          headers: request.headers,
          signal: request.signal,
        }),
        bodyPolicy
      );

      fields.payload = Option.some(
        yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        )
      );
    }

    const wire = Object.fromEntries(
      Object.entries(fields).flatMap(([key, value]) =>
        Option.match(value, { onNone: () => [], onSome: (input) => [[key, input]] })
      )
    );

    return Schema.decodeOption(operation.httpInput)(wire);
  }).pipe(
    Effect.tapError(() =>
      Effect.logWarning({
        component: "canonical-admission",
        operation: "rawInput",
        outcome: "rejected",
      })
    ),
    Effect.orElseSucceed(() => Option.none())
  );

const requiredScopes = (
  operation: CatalogOperation,
  input: unknown
): Option.Option<ReadonlyArray<CanonicalCapability>> => {
  const single = userOwnedAgentCapability(operation.policy.access);

  if (Option.isSome(single)) return Option.some([single.value]);

  if (operation.id !== atomicBatchOperation) return Option.some([]);

  const batch = Schema.decodeUnknownOption(
    Schema.Struct({ payload: Schema.toType(getAtomicBatchInputSchema()) })
  )(input);

  if (Option.isNone(batch)) return Option.none();
  const scopes = new Set<CanonicalCapability>();

  for (const call of batch.value.payload.calls) {
    const child = getBoundOperationCatalog().byId.get(call.operation);

    if (child === undefined) return Option.none();
    const scope = userOwnedAgentCapability(child.policy.access);

    if (Option.isNone(scope)) return Option.none();
    scopes.add(scope.value);
  }

  return Option.some([...scopes]);
};

export const validatedCanonicalInput = (
  input: Readonly<{ operation: CatalogOperation }> &
    (Readonly<{ request: Request }> | Readonly<{ canonicalInput: Schema.Json }>)
): Effect.Effect<
  Option.Option<Readonly<{ inputHash: string; scopes: ReadonlyArray<CanonicalCapability> }>>
> =>
  Effect.gen(function* () {
    const { operation } = input;

    if (
      "request" in input &&
      (operation.method !== input.request.method ||
        operation.route.split("/").length !== new URL(input.request.url).pathname.split("/").length)
    ) {
      return Option.none();
    }

    const decoded =
      "request" in input
        ? yield* rawInput({ request: input.request, operation })
        : Schema.decodeOption(operation.input, { onExcessProperty: "error" })(input.canonicalInput);

    if (Option.isNone(decoded)) return Option.none();
    const scopes = requiredScopes(operation, decoded.value);

    if (Option.isNone(scopes)) return Option.none();
    const json = yield* Schema.encodeEffect(operation.input)(decoded.value);

    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
      normalized(json)
    );

    const digest = yield* cryptoHash(serialized);

    return Option.some({ inputHash: digest, scopes: scopes.value });
  }).pipe(
    Effect.tapCause(() =>
      Effect.logWarning({
        component: "canonical-admission",
        operation: "validatedCanonicalInput",
        outcome: "rejected",
      })
    ),
    Effect.catchDefect(() => Effect.succeedNone),
    Effect.orElseSucceed(() => Option.none())
  );

export const cryptoHash = (value: string): Effect.Effect<string, CanonicalAdmissionUnavailable> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    catch: (cause) => new CanonicalAdmissionUnavailable({ cause }),
  }).pipe(Effect.map((digest) => Hex.encode(new Uint8Array(digest))));

export const localCanonicalArguments = Effect.fnUntraced(function* (
  request: Request,
  operation: CatalogOperation
) {
  return yield* rawInput({ request, operation }).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (decoded) => Schema.encodeEffect(operation.input)(decoded).pipe(Effect.asSome),
      })
    ),
    Effect.tapError(() =>
      Effect.logWarning({
        component: "canonical-admission",
        operation: "localCanonicalArguments",
        outcome: "rejected",
      })
    ),
    Effect.orElseSucceed(() => Option.none())
  );
});
