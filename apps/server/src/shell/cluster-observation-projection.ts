import { Option } from "effect";
import {
  type TelemetryCount,
  type TelemetryDuration,
  boundedTelemetryCount,
  boundedTelemetryDuration,
} from "~/shell/observability/protocol";
import type { ClusterObservationSample } from "./cluster-observation-sample";

/** Closed log projection: bounded branded counts, booleans, and Options for unobserved values. */
export type ClusterObservation = Readonly<{
  isShutdown: boolean;
  runnersTotal: TelemetryCount;
  runnersHealthy: TelemetryCount;
  assignedShards: TelemetryCount;
  expectedShards: TelemetryCount;
  /** Deployment-wide shards that have no fresh ownership lock. */
  unassignedShards: TelemetryCount;
  shardLockFailures: TelemetryCount;
  shardLockRefreshAgeMillis: Option.Option<TelemetryDuration>;
  mailboxUnprocessed: TelemetryCount;
  mailboxOldestAgeMillis: Option.Option<TelemetryDuration>;
  mailboxRedeliveries: TelemetryCount;
  residentEntities: TelemetryCount;
  /** Absent when `maxResidentEntities` is unbounded; otherwise the limit and whether it is near. */
  residentCapacity: Option.Option<
    Readonly<{ readonly limit: TelemetryCount; readonly pressure: boolean }>
  >;
  queueRetriesTotal: TelemetryCount;
  queuePendingRetries: TelemetryCount;
  requestRetriesTotal: TelemetryCount;
  /** Retries gained since the previous readable sample; absent on the first sample. */
  retriesDelta: Option.Option<ClusterRetryDelta>;
}>;

/** Cumulative counts one sample compares against the previous reading to derive retry rates. */
export type ClusterRetryCounts = Readonly<{
  readonly queueRetries: number;
  readonly requestRetries: number;
}>;

/** Retries gained since the previous readable sample, split by retry source. */
export type ClusterRetryDelta = Readonly<{
  readonly queue: TelemetryCount;
  readonly request: TelemetryCount;
}>;

/** Capacity is reported as pressure once four fifths of the resident-entity limit is used. */
const entityCapacityPressureThreshold = 0.8;

/** Projects one internal sample into the closed, bounded shape allowed to leave the process. */
export const projectClusterObservation = ({
  sample,
  previousRetries,
}: {
  readonly sample: ClusterObservationSample;
  readonly previousRetries: Option.Option<ClusterRetryCounts>;
}): ClusterObservation => ({
  isShutdown: sample.isShutdown,
  runnersTotal: boundedTelemetryCount(sample.runnersTotal),
  runnersHealthy: boundedTelemetryCount(sample.runnersHealthy),
  assignedShards: boundedTelemetryCount(sample.assignedShards),
  expectedShards: boundedTelemetryCount(sample.expectedShards),
  unassignedShards: boundedTelemetryCount(
    Math.max(0, sample.expectedShards - sample.assignedShards)
  ),
  shardLockFailures: boundedTelemetryCount(sample.shardLockFailures),
  shardLockRefreshAgeMillis: Option.map(sample.shardLockRefreshAgeMillis, boundedTelemetryDuration),
  mailboxUnprocessed: boundedTelemetryCount(sample.mailboxUnprocessed),
  mailboxOldestAgeMillis: Option.map(sample.mailboxOldestAgeMillis, boundedTelemetryDuration),
  mailboxRedeliveries: boundedTelemetryCount(sample.mailboxRedeliveries),
  residentEntities: boundedTelemetryCount(sample.residentEntities),
  residentCapacity: Option.map(sample.residentEntityCapacity, (limit) => ({
    limit: boundedTelemetryCount(limit),
    pressure: sample.residentEntities >= limit * entityCapacityPressureThreshold,
  })),
  queueRetriesTotal: boundedTelemetryCount(sample.queueRetriesTotal),
  queuePendingRetries: boundedTelemetryCount(sample.queuePendingRetries),
  requestRetriesTotal: boundedTelemetryCount(sample.requestRetriesTotal),
  retriesDelta: Option.map(previousRetries, (previous) => ({
    queue: boundedTelemetryCount(Math.max(0, sample.queueRetriesTotal - previous.queueRetries)),
    request: boundedTelemetryCount(
      Math.max(0, sample.requestRetriesTotal - previous.requestRetries)
    ),
  })),
});

/** Structured-log form with absent Option fields omitted rather than serialized as wrappers. */
export type ClusterObservationLogFields = Partial<{
  -readonly [Field in keyof ClusterObservation]: ClusterObservation[Field] extends Option.Option<
    infer Value
  >
    ? Value
    : ClusterObservation[Field];
}>;

const setPresentLogField = <Field extends keyof ClusterObservationLogFields>(
  fields: ClusterObservationLogFields,
  field: Field,
  value: Option.Option<NonNullable<ClusterObservationLogFields[Field]>>
): void => {
  if (Option.isSome(value)) fields[field] = value.value;
};

/** Flattens a closed observation into the exact fields allowed in its structured log record. */
export const clusterObservationLogFields = (
  observation: ClusterObservation
): ClusterObservationLogFields => {
  const {
    shardLockRefreshAgeMillis,
    mailboxOldestAgeMillis,
    residentCapacity,
    retriesDelta,
    ...present
  } = observation;
  const fields: ClusterObservationLogFields = { ...present };
  setPresentLogField(fields, "shardLockRefreshAgeMillis", shardLockRefreshAgeMillis);
  setPresentLogField(fields, "mailboxOldestAgeMillis", mailboxOldestAgeMillis);
  setPresentLogField(fields, "residentCapacity", residentCapacity);
  setPresentLogField(fields, "retriesDelta", retriesDelta);
  return fields;
};
