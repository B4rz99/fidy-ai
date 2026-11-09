import { checkRegistryKey, checkRegistryValue } from "./registry-value";
import { Effect, Option, Schema } from "effect";
import type { ErasureRegistry } from "../contract";
import { ErasureUnavailable } from "../../erasure-store/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { registryBody, registryObject } from "./registry-object";

const origin = "https://erasure-registry.invalid";
const path = "/metadata";
const maximumPage = 32;
const maximumKeyLength = 128;
const successStatus = 200;
const maximumBytes = 16384;
const maximumRecordBytes = 512;
const maximumGenerationBytes = 64;
const deadlineMilliseconds = 2000;
const maximumCursorLength = 4096;
const key = Schema.String.check(
  Schema.isBetweenLength(1, maximumKeyLength),
  Schema.isPattern(/^recovery\/(?:generation|cases\/[0-9a-fA-F-]{36})$/u)
);
const etag = Schema.String.check(Schema.isBetweenLength(1, maximumKeyLength));
const cursor = Schema.String.check(Schema.isBetweenLength(1, maximumCursorLength));
const pageOptions = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumPage }))
  ),
  prefix: Schema.optionalKey(Schema.Literals(["", "recovery/cases/"])),
  cursor: Schema.optionalKey(cursor),
});
const command = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["get", "head", "delete"]), key }),
  Schema.Struct({
    action: Schema.Literal("put"),
    key,
    value: Schema.String.check(Schema.isMaxLength(maximumRecordBytes)),
    options: Schema.Struct({
      onlyIf: Schema.Struct({
        etagMatches: Schema.optionalKey(etag),
        etagDoesNotMatch: Schema.optionalKey(etag),
      }),
    }),
  }),
  Schema.Struct({ action: Schema.Literal("list"), options: pageOptions }),
]);
const metadata = Schema.Struct({
  key,
  etag,
  size: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maximumRecordBytes })),
  uploaded: Schema.Int,
});
const record = Schema.NullOr(
  Schema.Struct({
    ...metadata.fields,
    value: Schema.String.check(Schema.isMaxLength(maximumRecordBytes)),
  })
);
const object = Schema.NullOr(metadata);
const objects = Schema.Array(metadata).check(Schema.isMaxLength(maximumPage));
const page = Schema.Union([
  Schema.Struct({ objects, truncated: Schema.Literal(false) }),
  Schema.Struct({ objects, truncated: Schema.Literal(true), cursor }),
]);
const policy = Schema.decodeSync(RequestBodyPolicy)({ maximumBytes, deadlineMilliseconds });
const project = (value: R2Object): typeof metadata.Type => ({
  key: value.key,
  etag: value.etag,
  size: value.size,
  uploaded: value.uploaded.getTime(),
});
const io = <Value>(run: () => Promise<Value>): Effect.Effect<Value, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

const readRecord = (
  registry: ErasureRegistry,
  key: string
): Effect.Effect<typeof record.Type, ErasureUnavailable> =>
  Effect.gen(function* () {
    const value = yield* io(() => registry.get(key));
    if (value === null) return null;
    const maximum = key === "recovery/generation" ? maximumGenerationBytes : maximumRecordBytes;
    if (value.size > maximum) {
      yield* io(() => value.body.cancel());
      return yield* new ErasureUnavailable();
    }
    const text = yield* io(() => value.text());
    if (new TextEncoder().encode(text).byteLength > maximum) {
      return yield* new ErasureUnavailable();
    }
    return { ...project(value), value: text };
  });

const projectFound = (value: Awaited<ReturnType<ErasureRegistry["head"]>>): typeof object.Type =>
  value === null ? null : project(value);
const checkCommand = (input: typeof command.Type): Effect.Effect<void, ErasureUnavailable> =>
  Effect.try({
    try: () => {
      if (input.action !== "list") checkRegistryKey(input.key);
      if (input.action === "put") checkRegistryValue(input);
    },
    catch: () => new ErasureUnavailable(),
  });
const execute = (
  registry: ErasureRegistry,
  input: typeof command.Type
): Effect.Effect<unknown, ErasureUnavailable> =>
  Effect.gen(function* () {
    yield* checkCommand(input);
    switch (input.action) {
      case "get":
        return yield* readRecord(registry, input.key);
      case "head": {
        const value = yield* io(() => registry.head(input.key));
        return projectFound(value);
      }
      case "put": {
        const value = yield* io(() => registry.put(input.key, input.value, input.options));
        return projectFound(value);
      }
      case "delete":
        yield* io(() => registry.delete(input.key));
        return null;
      case "list": {
        const result = yield* io(() => registry.list(input.options));
        return {
          objects: result.objects.map(project),
          truncated: result.truncated,
          ...(result.truncated ? { cursor: result.cursor } : {}),
        };
      }
    }
  });

export const registryRequest = (
  input: Readonly<{ request: Request; registry: ErasureRegistry }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const url = new URL(input.request.url);
    if (
      input.request.method !== "POST" ||
      url.origin !== origin ||
      url.pathname !== path ||
      url.search !== ""
    ) {
      return new Response(null, { status: 404 });
    }
    const raw = yield* boundedJsonBody({ request: input.request, policy, schema: Schema.Unknown });
    const decoded = Option.flatMap(
      raw,
      Schema.decodeUnknownOption(command, { onExcessProperty: "error" })
    );
    if (Option.isNone(decoded)) return new Response(null, { status: 400 });
    const result = yield* execute(input.registry, decoded.value);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.orElseSucceed(() => new Response(null, { status: 503 })));

const remoteRequest = <Shape extends Schema.ConstraintDecoder<unknown>>(
  target: Pick<Fetcher, "fetch">,
  input: unknown,
  schema: Shape
): Effect.Effect<Shape["Type"], ErasureUnavailable> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(command))(
      yield* Schema.decodeUnknownEffect(command, { onExcessProperty: "error" })(input)
    );
    const response = yield* io(() =>
      target.fetch(
        new Request(origin + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encoded,
          signal: AbortSignal.timeout(deadlineMilliseconds),
        })
      )
    );
    if (response.status !== successStatus) {
      const body = response.body;
      if (body !== null) yield* io(() => body.cancel());
      return yield* new ErasureUnavailable();
    }
    const value = yield* boundedJsonBody({
      request: new Request(origin + path, {
        method: "POST",
        headers: response.headers,
        body: response.body,
      }),
      policy,
      schema,
    });
    if (Option.isNone(value)) return yield* new ErasureUnavailable();
    return value.value;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

export const registryClient = (target: Pick<Fetcher, "fetch">): ErasureRegistry => ({
  get: (key) =>
    Effect.runPromise(
      remoteRequest(target, { action: "get", key }, record).pipe(
        Effect.flatMap((value) => {
          if (value === null) return Effect.succeed(null);
          if (
            value.key !== key ||
            new TextEncoder().encode(value.value).byteLength !== value.size
          ) {
            return Effect.fail(new ErasureUnavailable());
          }
          return Effect.succeed(
            registryBody({ object: registryObject(value), value: value.value })
          );
        })
      )
    ),
  head: (key) =>
    Effect.runPromise(
      remoteRequest(target, { action: "head", key }, object).pipe(
        Effect.map((value) => (value === null ? null : registryObject(value)))
      )
    ),
  put: (key, value, options) =>
    Effect.runPromise(
      remoteRequest(
        target,
        { action: "put", key, value, options: options ?? { onlyIf: {} } },
        object
      ).pipe(Effect.map((value) => (value === null ? null : registryObject(value))))
    ),
  delete: (key) =>
    Effect.runPromise(
      remoteRequest(target, { action: "delete", key }, Schema.Null).pipe(Effect.asVoid)
    ),
  list: (options) =>
    Effect.runPromise(
      remoteRequest(target, { action: "list", options }, page).pipe(
        Effect.map((value): R2Objects => {
          const objects = value.objects.map(registryObject);
          return value.truncated
            ? { objects, delimitedPrefixes: [], truncated: true, cursor: value.cursor }
            : { objects, delimitedPrefixes: [], truncated: false };
        })
      )
    ),
});
