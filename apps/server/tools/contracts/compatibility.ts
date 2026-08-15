import { type IOasdiffChange, runOasdiffBreakingFromSpecs } from "@oasdiff-js/oasdiff-js";
import { Predicate, Schema } from "effect";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
export type JsonValue = Schema.Json;
export type JsonArray = ReadonlyArray<JsonValue>;
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

/** Generated contract pair that is compared and digested as one compatibility boundary. */
export type ContractArtifacts = {
  readonly openapi: JsonObject;
  readonly operationPolicy: OperationPolicyManifest;
};

const ContractFinding = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("openapi"),
    rule: Schema.String,
    location: JsonObject,
    detail: Schema.String,
  }),
  Schema.Struct({
    source: Schema.Literal("operation-policy"),
    rule: Schema.String,
    operationId: Schema.String,
    detail: Schema.String,
  }),
]);
export type ContractFinding = typeof ContractFinding.Type;

const ContractAcknowledgement = Schema.Struct({
  baseDigest: Schema.String,
  candidateDigest: Schema.String,
  findings: Schema.Array(ContractFinding),
  rolloutIssue: Schema.String,
});
export type ContractAcknowledgement = typeof ContractAcknowledgement.Type;

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

/** Stable JSON is the wire format for artifacts, digests, findings, and exact acknowledgements. */
export const canonicalJson = (value: unknown): string => JSON.stringify(asJsonValue(value));

/** Returns the lowercase SHA-256 identity of a contract pair's canonical JSON. */
export const contractDigest = (artifacts: ContractArtifacts): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(artifacts)).digest("hex");

/** Parses generated OpenAPI and operation-policy values, rejecting malformed policy entries. */
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

/** Decodes one exact compatibility acknowledgement before it can authorize contract findings. */
export const contractAcknowledgementFrom = (value: unknown): ContractAcknowledgement => {
  try {
    return Schema.decodeUnknownSync(ContractAcknowledgement)(value);
  } catch {
    throw new Error("Contract value is not a valid exact-finding acknowledgement");
  }
};

const normalizeOpenApiChange = (change: IOasdiffChange): ContractFinding => ({
  source: "openapi",
  rule: change.id ?? "unclassified-breaking-change",
  location: asJsonObject({
    operationId: change.operationId ?? null,
    operation: change.operation ?? null,
    path: change.path ?? null,
    section: change.section ?? null,
    fingerprint: change.fingerprint ?? null,
  }),
  detail: change.text ?? change.comment ?? canonicalJson(change),
});

const byCanonicalValue = (left: ContractFinding, right: ContractFinding): number =>
  canonicalJson(left).localeCompare(canonicalJson(right));

/**
 * Finds structural breaks from `base` to `candidate`. Both arguments must be complete OpenAPI
 * documents; the returned stable finding values can be copied verbatim into an acknowledgement.
 */
export const findOpenApiBreakingChanges = async (
  base: object,
  candidate: object
): Promise<ReadonlyArray<ContractFinding>> => {
  const result = await runOasdiffBreakingFromSpecs(base, candidate, {
    failOn: "ERR",
    flattenAllOf: true,
    format: "json",
  });
  if (result.exitCode > 1) {
    throw new Error(`oasdiff could not compare the contracts: ${result.stderr || result.stdout}`);
  }
  return result.changes.map(normalizeOpenApiChange).sort(byCanonicalValue);
};

/**
 * Compares each existing operation's complete reflected policy value. Additions are compatible;
 * removals and any nested policy change are rollout findings. No policy field allowlist exists.
 */
export const compareOperationPolicies = (
  base: OperationPolicyManifest,
  candidate: OperationPolicyManifest
): ReadonlyArray<ContractFinding> => {
  const candidateById = new Map(
    candidate.operations.map((operation) => [operation.id, operation.policy] as const)
  );

  return base.operations
    .flatMap((operation): ReadonlyArray<ContractFinding> => {
      if (!candidateById.has(operation.id)) {
        return [
          {
            source: "operation-policy",
            rule: "canonical-operation-removed",
            operationId: operation.id,
            detail: canonicalJson({ base: operation.policy, candidate: null }),
          },
        ];
      }
      const candidatePolicy = candidateById.get(operation.id);
      return canonicalJson(operation.policy) === canonicalJson(candidatePolicy)
        ? []
        : [
            {
              source: "operation-policy",
              rule: "operation-policy-changed",
              operationId: operation.id,
              detail: canonicalJson({ base: operation.policy, candidate: candidatePolicy }),
            },
          ];
    })
    .sort(byCanonicalValue);
};

const rolloutIssue = /^https:\/\/github\.com\/B4rz99\/fidy-ai\/issues\/[1-9]\d*$/u;

/** Exact set equality prevents a stale acknowledgement from authorizing a later finding. */
export const acknowledgementCovers = ({
  acknowledgement,
  baseDigest,
  candidateDigest,
  findings,
}: {
  readonly acknowledgement: ContractAcknowledgement;
  readonly baseDigest: string;
  readonly candidateDigest: string;
  readonly findings: ReadonlyArray<ContractFinding>;
}): boolean =>
  acknowledgement.baseDigest === baseDigest &&
  acknowledgement.candidateDigest === candidateDigest &&
  rolloutIssue.test(acknowledgement.rolloutIssue) &&
  canonicalJson([...acknowledgement.findings].sort(byCanonicalValue)) ===
    canonicalJson([...findings].sort(byCanonicalValue));
