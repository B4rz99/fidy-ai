import { deepEqual } from "alchemy/Diff";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const attributes = Schema.Record(Schema.String, Schema.Unknown);
const driftPlan = Schema.Struct({
  resources: Schema.Record(
    Schema.String,
    Schema.Struct({
      resource: Schema.Struct({ LogicalId: Schema.String }),
      drift: Schema.optional(
        Schema.Struct({ expected: Schema.Unknown, actual: Schema.optional(Schema.Unknown) })
      ),
    })
  ),
});
const fields = [
  "accountId",
  "workerId",
  "workerName",
  "namespace",
  "logpush",
  "url",
  "urls",
  "domain",
  "tags",
  "durableObjectNamespaces",
  "routes",
  "crons",
  "tailConsumers",
  "streamingTailConsumers",
  "hash",
  "affinityZoneIds",
  "versionOf",
  "versionId",
  "deploymentId",
] as const;
const knownFields = new Set<string>(fields);

/** Projects attribute differences to closed names only; neither values nor unknown keys escape. */
export const workerDriftFields = ({
  expected,
  actual,
}: Readonly<{
  expected: unknown;
  actual: unknown;
}>): ReadonlyArray<string> => {
  const previous = Schema.decodeUnknownOption(attributes)(expected);
  const observed = Schema.decodeUnknownOption(attributes)(actual);
  if (Option.isNone(previous) || Option.isNone(observed)) return ["unavailable"];
  const changed: string[] = fields.filter(
    (field) => !deepEqual(previous.value[field], observed.value[field])
  );
  const unknownChanged = [
    ...new Set([...Object.keys(previous.value), ...Object.keys(observed.value)]),
  ].some(
    (field) => !knownFields.has(field) && !deepEqual(previous.value[field], observed.value[field])
  );
  if (unknownChanged) changed.push("other");
  return changed;
};

/** Projects an untrusted dry-run plan without treating diagnostics as permission to repair it. */
export const workerDriftReport = (plan: unknown): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownOption(driftPlan)(plan);
  if (Option.isNone(decoded)) {
    return ["Worker drift fields: Core unavailable", "Worker drift fields: Ingress unavailable"];
  }
  return Object.values(decoded.value.resources).flatMap((resource) => {
    const id = resource.resource.LogicalId;
    if ((id !== "Core" && id !== "Ingress") || resource.drift === undefined) return [];
    const changed = workerDriftFields({
      expected: resource.drift.expected,
      actual: resource.drift.actual,
    });
    return changed.length === 0 ? [] : [`Worker drift fields: ${id} ${changed.join(",")}`];
  });
};
