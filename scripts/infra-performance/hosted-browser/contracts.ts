import { Schema } from "effect";

const extras = Schema.Record(Schema.String, Schema.Unknown);
const cost = Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int });
const session = Schema.Struct({ cookie: Schema.NonEmptyString, binding: Schema.NonEmptyString });
const artifact = Schema.Struct({ bytes: Schema.Int, sha256: Schema.String });
const row = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    counterparty: Schema.NullOr(Schema.String),
    revision: Schema.Int,
  }),
  [extras]
);
const config = Schema.Struct({
  deadline: Schema.Int,
  d1: Schema.Struct({
    session,
    version: Schema.String,
    url: Schema.String,
    key: Schema.String,
    assets: Schema.Record(Schema.String, artifact),
  }),
  native: Schema.Struct({
    session,
    revision: Schema.String,
    web: Schema.Struct({
      browser: Schema.String,
      api: Schema.String,
      revision: Schema.String,
      contractDigest: Schema.String,
    }),
  }),
  expected: Schema.Struct({
    history: Schema.StructWithRest(Schema.Struct({ data: Schema.Array(row) }), [extras]),
    workspace: Schema.Struct({ profile: Schema.Unknown, review: Schema.Unknown }),
  }),
  allowed: Schema.Record(Schema.String, Schema.Int),
  caps: Schema.Record(Schema.String, cost),
  maximum: cost,
});
const event = Schema.StructWithRest(
  Schema.Struct({
    stage: Schema.optional(Schema.String),
    complete: Schema.optional(Schema.Boolean),
    milliseconds: Schema.optional(Schema.Number),
    bodyBytes: Schema.optional(Schema.Int),
    status: Schema.optional(Schema.Int),
    failed: Schema.optional(Schema.String),
    rejected: Schema.optional(Schema.String),
  }),
  [extras]
);
export const parseConfig = Schema.decodeUnknownSync(config);
export const parseCost = Schema.decodeUnknownSync(Schema.fromJsonString(cost));
export const parseDeployment = Schema.decodeUnknownSync(
  Schema.Struct({ gitRevision: Schema.String, contractDigest: Schema.String })
);
export const parseReport = Schema.decodeUnknownSync(
  Schema.Struct({
    variant: Schema.Literals(["d1", "do"]),
    snapshots: extras,
    events: Schema.Array(event),
  })
);
export const parseAck = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ id: Schema.String, revision: Schema.Int }) })
);
export const parseRefusal = Schema.decodeUnknownSync(
  Schema.Struct({
    error: Schema.Struct({
      failedCallIndex: Schema.Int,
      operation: Schema.String,
      code: Schema.String,
    }),
  })
);

export type PairConfig = typeof config.Type;
export type Variant = "d1" | "do";
export type PairHttp = (...args: Parameters<typeof fetch>) => Promise<Response>;
export type Dispatch = { variant: Variant; method: string; path: string };
export type Observation = { index: number; variant: Variant; offered: boolean };
export type PairEvidence = Record<string, unknown> & {
  environment: string;
  verified: boolean;
  dispatches: Dispatch[];
  observations: Observation[];
  actualD1: { rowsRead: number; rowsWritten: number };
};
export type PairContext = {
  config: PairConfig;
  http: PairHttp;
  evidence: PairEvidence;
  profile: Record<Variant, Record<string, number>>;
  preflights: Record<Variant, number>;
  dir: string;
};
export type CapturedEvent = Record<string, unknown>;
export type AssetsDelivered = {
  rawBytes: number;
  encodedBytes: number;
  responses: number;
  gzip: number;
};
export type Snapshots = Record<string, unknown>;
export type ProfileEvidence = {
  events: CapturedEvent[];
  snapshots: Snapshots;
  report: () => Promise<number>;
};
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const fields = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
