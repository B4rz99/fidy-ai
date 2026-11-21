import { Schema } from "effect";

const extras = Schema.Record(Schema.String, Schema.Unknown);

const session = Schema.Struct({ cookie: Schema.NonEmptyString, binding: Schema.NonEmptyString });

const row = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    counterparty: Schema.NullOr(Schema.String),
    revision: Schema.Int,
  }),
  [extras]
);

const history = Schema.StructWithRest(Schema.Struct({ data: Schema.Array(row) }), [extras]);

export const parseHistory = (input: unknown): typeof history.Type => {
  Schema.asserts(history, input);

  return input;
};

const nativeBrowser = Schema.Struct({
  session,
  revision: Schema.String,
  web: Schema.Struct({
    browser: Schema.String,
    api: Schema.String,
    revision: Schema.String,
    contractDigest: Schema.String,
  }),
});

const expectedBrowser = Schema.Struct({
  history,
  workspace: Schema.Struct({ profile: Schema.Unknown, review: Schema.Unknown }),
});

const decoder = <Value>(schema: Schema.ConstraintDecoder<Value>): ((input: unknown) => Value) =>
  Schema.decodeUnknownSync(schema);

export const parseNativeSmoke = decoder(
  Schema.Struct({
    deadline: Schema.Int,
    native: nativeBrowser,
    expected: expectedBrowser,
    allowed: Schema.Record(Schema.String, Schema.Int),
    maximumPreflights: Schema.Int,
  })
);

export const parseDeployment = decoder(
  Schema.Struct({ gitRevision: Schema.String, contractDigest: Schema.String })
);

export const parseAck = decoder(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String, revision: Schema.Int }) })
);

export const parseRefusal = decoder(
  Schema.Struct({
    error: Schema.Struct({
      failedCallIndex: Schema.Int,
      operation: Schema.String,
      code: Schema.String,
    }),
  })
);

export type CapturedEvent = Schema.JsonObject;

export type AssetsDelivered = {
  rawBytes: number;
  encodedBytes: number;
  responses: number;
  gzip: number;
};

export type Snapshots = Record<string, Schema.Json>;

export type ProfileEvidence = {
  events: CapturedEvent[];
  snapshots: Snapshots;
  report: () => Promise<number>;
};

const isJsonObject = Schema.is(Schema.JsonObject);

export const fields = (value: unknown): Schema.JsonObject => (isJsonObject(value) ? value : {});
