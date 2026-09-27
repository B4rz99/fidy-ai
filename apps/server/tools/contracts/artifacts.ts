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

export const asJsonValue = (value: unknown, path = "$"): JsonValue => {
  try {
    return sortJson(Schema.decodeUnknownSync(Schema.Json)(value));
  } catch {
    throw new Error(`Contract value at ${path} is not valid JSON`);
  }
};

export const asJsonObject = (value: unknown, path = "$"): JsonObject => {
  try {
    return Schema.decodeUnknownSync(JsonObject)(value);
  } catch {
    throw new Error(`Contract value at ${path} is not a JSON object`);
  }
};

/** Stable JSON representation for generated artifacts and release identities. */
export const canonicalJson = (value: unknown): string => JSON.stringify(asJsonValue(value));

/** Returns the lowercase SHA-256 identity of the canonical API and operation policy. */
export const contractDigest = (artifacts: ContractArtifacts): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(artifacts)).digest("hex");

/** Rejects malformed generated files before trusting them as a release identity. */
export const contractArtifactsFrom = (
  openapi: unknown,
  policy: unknown,
  subject: string
): ContractArtifacts => {
  let operationPolicy: OperationPolicyManifest;
  try {
    operationPolicy = Schema.decodeUnknownSync(OperationPolicyManifest)(policy);
  } catch {
    throw new Error(`${subject} operation policy is not an operation-policy manifest`);
  }
  return {
    openapi: asJsonObject(openapi, `${subject} OpenAPI contract`),
    operationPolicy,
  };
};
