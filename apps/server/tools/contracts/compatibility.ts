import { type IOasdiffChange, runOasdiffBreakingFromSpecs } from "@oasdiff-js/oasdiff-js";

export type JsonValue = null | boolean | number | string | JsonArray | JsonObject;
export type JsonArray = ReadonlyArray<JsonValue>;
export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type OperationPolicyManifest = {
  readonly operations: ReadonlyArray<{
    readonly id: string;
    readonly policy: JsonValue;
  }>;
};

/** Generated contract pair that is compared and digested as one compatibility boundary. */
export type ContractArtifacts = {
  readonly openapi: JsonObject;
  readonly operationPolicy: OperationPolicyManifest;
};

export type ContractFinding =
  | {
      readonly source: "openapi";
      readonly rule: string;
      readonly location: JsonObject;
      readonly detail: string;
    }
  | {
      readonly source: "operation-policy";
      readonly rule: string;
      readonly operationId: string;
      readonly detail: string;
    };

export type ContractAcknowledgement = {
  readonly baseDigest: string;
  readonly candidateDigest: string;
  readonly findings: ReadonlyArray<ContractFinding>;
  readonly rolloutIssue: string;
};

export const asJsonValue = (value: unknown, path = "$"): JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => asJsonValue(entry, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, asJsonValue(entry, `${path}.${key}`)])
    );
  }
  throw new Error(`Contract value at ${path} has unsupported type ${typeof value}`);
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asJsonObject = (value: unknown, path = "$"): JsonObject => {
  const json = asJsonValue(value, path);
  if (!isJsonObject(json)) throw new Error(`Contract value at ${path} is not a JSON object`);
  return json;
};

/** Stable JSON is the wire format for artifacts, digests, findings, and exact acknowledgements. */
export const canonicalJson = (value: unknown): string => JSON.stringify(asJsonValue(value));

/** Returns the lowercase SHA-256 identity of a contract pair's canonical JSON. */
export const contractDigest = (artifacts: ContractArtifacts): string =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(artifacts)).digest("hex");

/** Allows field inspection without array semantics; JSON-safe leaf values remain unvalidated. */
export const isUnknownRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses generated OpenAPI and operation-policy values, rejecting malformed policy entries. */
export const contractArtifactsFrom = (
  openapi: unknown,
  policy: unknown,
  subject: string
): ContractArtifacts => {
  if (!isUnknownRecord(policy) || !Array.isArray(policy.operations)) {
    throw new Error(`${subject} operation policy is not an operation-policy manifest`);
  }
  return {
    openapi: asJsonObject(openapi, `${subject} OpenAPI contract`),
    operationPolicy: {
      operations: policy.operations.map((operation: unknown, index: number) => {
        if (!isUnknownRecord(operation) || typeof operation.id !== "string") {
          throw new Error(`${subject} operation policy.operations[${index}] is invalid`);
        }
        return { id: operation.id, policy: asJsonValue(operation.policy) };
      }),
    },
  };
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
