import { WompiTransactionId } from "@fidy/server/subscription-runtime";
import { Effect, Option, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";

const maximumEventBytes = 8192;
const eventDeadlineMs = 2000;
const maximumSignedProperties = 16;
const checksumPattern = /^[0-9a-fA-F]{64}$/u;
const propertyPattern = /^[a-zA-Z][a-zA-Z0-9_.]*$/u;
const hexBase = 16;
const idProperty = "transaction.id";
const statusProperty = "transaction.status";
const Body = Schema.Struct({
  event: Schema.Literal("transaction.updated"),
  environment: Schema.Literals(["test", "prod"]),
  data: Schema.Struct({
    transaction: Schema.Struct({ id: WompiTransactionId, status: Schema.String }),
  }),
  signature: Schema.Struct({
    properties: Schema.Array(Schema.String).check(Schema.isMaxLength(maximumSignedProperties)),
    checksum: Schema.String.check(Schema.isPattern(checksumPattern)),
  }),
  timestamp: Schema.Int,
});
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumEventBytes,
  deadlineMilliseconds: eventDeadlineMs,
});

const signedScalar = (value: unknown): Option.Option<string> => {
  if (typeof value === "string") return Option.some(value);
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Option.some(String(value))
    : Option.none();
};

const ownValue = (data: unknown, path: string): Option.Option<string> => {
  if (!propertyPattern.test(path)) return Option.none();
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return Option.none();
    const field = Object.getOwnPropertyDescriptor(current, segment);
    if (field === undefined || !Object.hasOwn(field, "value")) return Option.none();
    current = field.value;
  }
  return signedScalar(current);
};

const equalHex = (expected: string, observed: string): boolean => {
  if (!checksumPattern.test(observed)) return false;
  const candidate = observed.toLowerCase();
  let difference = 0;
  for (const [index, character] of Array.from(expected).entries()) {
    difference |= character.charCodeAt(0) ^ candidate.charCodeAt(index);
  }
  return difference === 0;
};

const signedValues = (event: typeof Body.Type, rawData: unknown): Option.Option<string> => {
  if (
    !event.signature.properties.includes(idProperty) ||
    !event.signature.properties.includes(statusProperty)
  ) {
    return Option.none();
  }
  const values = event.signature.properties.map((name) => ownValue(rawData, name));
  if (values.some(Option.isNone)) return Option.none();
  return Option.some(values.map((value) => Option.getOrThrow(value)).join(""));
};

const verifiedChecksum = (
  input: Readonly<{
    event: typeof Body.Type;
    header: Option.Option<string>;
    secret: string;
    values: string;
  }>
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const cleartext = `${input.values}${input.event.timestamp}${input.secret}`;
    const digest = yield* Effect.option(
      Effect.tryPromise({
        try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(cleartext)),
        catch: () => undefined,
      })
    );
    if (Option.isNone(digest)) return false;
    const hash = new Uint8Array(digest.value);
    const checksum = Array.from(hash, (byte) => byte.toString(hexBase).padStart(2, "0")).join("");
    return (
      equalHex(checksum, input.event.signature.checksum) &&
      (Option.isNone(input.header) || equalHex(checksum, input.header.value))
    );
  });

const readEvent = (
  request: Request
): Effect.Effect<
  Option.Option<
    Readonly<{
      event: typeof Body.Type;
      rawData: unknown;
    }>
  >
> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedRequestBody(request, policy).pipe(Effect.option);
    if (Option.isNone(bytes)) return Option.none();
    const text = yield* Effect.option(
      Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
        catch: () => undefined,
      })
    );
    if (Option.isNone(text)) return Option.none();
    const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text.value);
    if (Option.isNone(parsed)) return Option.none();
    const event = Schema.decodeUnknownOption(Body)(parsed.value);
    const raw = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Unknown }))(parsed.value);
    return Option.isSome(event) && Option.isSome(raw)
      ? Option.some({ event: event.value, rawData: raw.value.data })
      : Option.none();
  });

/** Verify Wompi's ordered event properties with the separate events secret before using the id as a lookup hint. */
export const verifiedWompiEventHint = (
  input: Readonly<{ request: Request; secret: string; environment: "sandbox" | "production" }>
): Effect.Effect<
  Option.Option<
    Readonly<{ transactionId: WompiTransactionId; signedAt: number; signedStatus: string }>
  >
> =>
  Effect.gen(function* () {
    if (input.secret.length === 0) return Option.none();
    const parsed = yield* readEvent(input.request);
    if (Option.isNone(parsed)) return Option.none();
    const { event, rawData } = parsed.value;
    if (event.environment !== (input.environment === "sandbox" ? "test" : "prod")) {
      return Option.none();
    }
    const values = signedValues(event, rawData);
    if (Option.isNone(values)) return Option.none();
    const trusted = yield* verifiedChecksum({
      event,
      header: Option.fromNullOr(input.request.headers.get("x-event-checksum")),
      secret: input.secret,
      values: values.value,
    });
    return trusted
      ? Option.some({
          transactionId: event.data.transaction.id,
          signedAt: event.timestamp,
          signedStatus: event.data.transaction.status,
        })
      : Option.none();
  });
