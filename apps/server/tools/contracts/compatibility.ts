import { type IOasdiffChange, runOasdiffBreakingFromSpecs } from "@oasdiff-js/oasdiff-js";
import { Option, Predicate, Schema } from "effect";

const JsonArray = Schema.Array(Schema.Json);
const JsonObject = Schema.Record(Schema.String, Schema.Json);
export type JsonValue = Schema.Json;
export type JsonArray = typeof JsonArray.Type;
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

const ProductionWebRelease = Schema.Struct({
  contractDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  gitRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u)),
});
export type ProductionWebRelease = typeof ProductionWebRelease.Type;

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

/**
 * Decodes the public identity of the web artifact that Cloudflare currently serves in Production.
 * Throws when the value is not an exact contract digest and Git revision pair.
 */
export const productionWebReleaseFrom = (value: unknown): ProductionWebRelease => {
  try {
    return Schema.decodeUnknownSync(ProductionWebRelease)(value);
  } catch {
    throw new Error("Production web release evidence is not a valid release identity");
  }
};

const automaticSchemaIdentifier = /^(?:Arrays|Literal|Objects|Union)_?\d*$/u;
const localSchemaReferencePrefix = "#/components/schemas/";

const automaticSchemaReference = (value: JsonObject): Option.Option<string> => {
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0]?.[0] !== "$ref") return Option.none();
  const reference = entries[0][1];
  if (typeof reference !== "string" || !reference.startsWith(localSchemaReferencePrefix)) {
    return Option.none();
  }
  const identifier = reference.slice(localSchemaReferencePrefix.length);
  return automaticSchemaIdentifier.test(identifier) ? Option.some(identifier) : Option.none();
};

const mergeLiteralAnyOf = (members: JsonArray): Option.Option<JsonObject> => {
  let commonType = Option.none<string>();
  const values: Array<JsonValue> = [];
  for (const member of members) {
    if (!Predicate.isObject(member)) return Option.none();
    const object = Schema.decodeUnknownSync(JsonObject)(member);
    if (
      Object.keys(object).some((key) => key !== "enum" && key !== "type") ||
      typeof object.type !== "string" ||
      !Array.isArray(object.enum)
    ) {
      return Option.none();
    }
    if (Option.isSome(commonType) && commonType.value !== object.type) return Option.none();
    commonType = Option.some(object.type);
    for (const value of Schema.decodeSync(JsonArray)(object.enum)) {
      if (!values.some((present) => canonicalJson(present) === canonicalJson(value))) {
        values.push(value);
      }
    }
  }
  return Option.map(commonType, (type) => ({ type, enum: values }));
};

const normalizeSchemaRepresentations = (
  value: JsonValue,
  definitions: JsonObject,
  resolving: ReadonlySet<string> = new Set()
): JsonValue => {
  if (Array.isArray(value)) {
    return Schema.decodeSync(JsonArray)(value).map((entry) =>
      normalizeSchemaRepresentations(entry, definitions, resolving)
    );
  }
  if (!Predicate.isObject(value)) return value;

  const object = Schema.decodeUnknownSync(JsonObject)(value);
  const reference = automaticSchemaReference(object);
  if (Option.isSome(reference) && !resolving.has(reference.value)) {
    const definition = definitions[reference.value];
    if (definition !== undefined) {
      return normalizeSchemaRepresentations(
        definition,
        definitions,
        new Set([...resolving, reference.value])
      );
    }
  }

  let normalized = Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [
      key,
      normalizeSchemaRepresentations(entry, definitions, resolving),
    ])
  );
  if (Array.isArray(normalized.anyOf)) {
    normalized = Option.match(mergeLiteralAnyOf(Schema.decodeSync(JsonArray)(normalized.anyOf)), {
      onNone: () => normalized,
      onSome: (merged) => ({
        ...merged,
        ...Object.fromEntries(Object.entries(normalized).filter(([key]) => key !== "anyOf")),
      }),
    });
  }
  return normalized;
};

const normalizeOpenApiRepresentations = (openapi: object): JsonObject => {
  const document = asJsonObject(openapi);
  const components = Predicate.isObject(document.components)
    ? asJsonObject(document.components)
    : {};
  const definitions = Predicate.isObject(components.schemas)
    ? asJsonObject(components.schemas)
    : {};
  return asJsonObject(normalizeSchemaRepresentations(document, definitions));
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

const normalizeHistoricalPolicy = (policy: JsonValue): JsonValue => {
  if (!Predicate.isObject(policy)) return policy;
  const object = Schema.decodeUnknownSync(JsonObject)(policy);
  if (Object.hasOwn(object, "access")) return object;

  const capability = object.requiredScope;
  const evaluation = object.scopeEvaluation;
  const eligibility = object.callerEligibility ?? "authenticated";
  if (
    (capability !== "read" && capability !== "write" && capability !== "dashboard") ||
    (evaluation !== "endpoint" && evaluation !== "children") ||
    (eligibility !== "authenticated" && eligibility !== "verified-whatsapp-hosted-only")
  ) {
    return Object.hasOwn(object, "callerEligibility")
      ? object
      : { ...object, callerEligibility: "authenticated" };
  }

  const { requiredScope: _, scopeEvaluation: __, callerEligibility: ___, ...orthogonal } = object;
  return {
    ...orthogonal,
    access:
      eligibility === "verified-whatsapp-hosted-only"
        ? { type: "verified-whatsapp-hosted-only" }
        : {
            type: "pat-scoped",
            scope:
              evaluation === "children"
                ? { evaluation: "children" }
                : { evaluation: "operation", capability },
          },
  };
};

/**
 * Finds structural breaks from `base` to `candidate`. Both arguments must be complete OpenAPI
 * documents; the returned stable finding values can be copied verbatim into an acknowledgement.
 */
export const findOpenApiBreakingChanges = async (
  base: object,
  candidate: object
): Promise<ReadonlyArray<ContractFinding>> => {
  const result = await runOasdiffBreakingFromSpecs(
    normalizeOpenApiRepresentations(base),
    normalizeOpenApiRepresentations(candidate),
    {
      failOn: "ERR",
      flattenAllOf: true,
      format: "json",
    }
  );
  if (result.exitCode > 1) {
    throw new Error(`oasdiff could not compare the contracts: ${result.stderr || result.stdout}`);
  }
  return result.changes.map(normalizeOpenApiChange).sort(byCanonicalValue);
};

/**
 * Compares each existing operation's effective reflected policy. Additions are compatible; removals
 * and nested policy changes are rollout findings. Historical omission of default authenticated caller
 * eligibility is normalized without introducing a field allowlist for future policy variants.
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
      return canonicalJson(normalizeHistoricalPolicy(operation.policy)) ===
        canonicalJson(candidatePolicy)
        ? []
        : [
            {
              source: "operation-policy",
              rule: "operation-policy-changed",
              operationId: operation.id,
              detail: canonicalJson({
                base: operation.policy,
                candidate: candidatePolicy,
              }),
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

/**
 * Authorizes a final contract removal only after the exact base web artifact reached Production.
 * The candidate must leave web source unchanged so same-revision compilation exercises that deployed
 * consumer against the candidate server declaration.
 */
export const removalAcknowledgementCovers = ({
  acknowledgement,
  baseDigest,
  candidateDigest,
  findings,
  baseRevision,
  deployedWeb,
  candidateChangesWeb,
}: {
  readonly acknowledgement: ContractAcknowledgement;
  readonly baseDigest: string;
  readonly candidateDigest: string;
  readonly findings: ReadonlyArray<ContractFinding>;
  readonly baseRevision: string;
  readonly deployedWeb: ProductionWebRelease;
  readonly candidateChangesWeb: boolean;
}): boolean =>
  !candidateChangesWeb &&
  deployedWeb.contractDigest === baseDigest &&
  deployedWeb.gitRevision === baseRevision &&
  acknowledgementCovers({
    acknowledgement,
    baseDigest,
    candidateDigest,
    findings,
  });
