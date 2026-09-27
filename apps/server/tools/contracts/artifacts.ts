import { Predicate, Schema } from "effect";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
export type JsonValue = Schema.Json;
export type JsonObject = typeof JsonObject.Type;

const OperationPolicyManifest = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      policy: Schema.Json,
    })
  ),
});
export type OperationPolicyManifest = typeof OperationPolicyManifest.Type;

/** Generated evidence used to identify the exact canonical API shipped with a release. */
export type ContractArtifacts = {
  readonly openapi: JsonObject;
  readonly operationPolicy: OperationPolicyManifest;
};

const sortJson = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (Predicate.isObject(value)) {
    const object: JsonObject = Schema.decodeUnknownSync(JsonObject)(value);
    return Object.fromEntries(
      Object.entries(object)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)])
    );
  }
  return value;
};

type JsonInput = Readonly<{ value: unknown }> | Readonly<{ value: unknown; path: string }>;

export const asJsonValue = (input: JsonInput): JsonValue => {
  const path = "path" in input ? input.path : "$";
  try {
    return sortJson(Schema.decodeUnknownSync(Schema.Json)(input.value));
  } catch {
    throw new Error(`Contract value at ${path} is not valid JSON`);
  }
};

export const asJsonObject = (input: JsonInput): JsonObject => {
  const path = "path" in input ? input.path : "$";
  try {
    return Schema.decodeUnknownSync(JsonObject)(input.value);
  } catch {
    throw new Error(`Contract value at ${path} is not a JSON object`);
  }
};

/** Stable JSON representation for generated artifacts and release identities. */
export const canonicalJson = (value: unknown): string => JSON.stringify(asJsonValue({ value }));

/** Returns the lowercase SHA-256 identity of the canonical API and operation policy. */
export const contractDigest = (artifacts: ContractArtifacts): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(artifacts)).digest("hex");

type ContractArtifactInput = Readonly<{ openapi: unknown; policy: unknown; subject: string }>;

/** Rejects malformed generated files before trusting them as a release identity. */
export const contractArtifactsFrom = ({
  openapi,
  policy,
  subject,
}: ContractArtifactInput): ContractArtifacts => {
  let operationPolicy: OperationPolicyManifest;
  try {
    operationPolicy = Schema.decodeUnknownSync(OperationPolicyManifest)(policy);
  } catch {
    throw new Error(`${subject} operation policy is not an operation-policy manifest`);
  }
  return {
    openapi: asJsonObject({ value: openapi, path: `${subject} OpenAPI contract` }),
    operationPolicy,
  };
};
