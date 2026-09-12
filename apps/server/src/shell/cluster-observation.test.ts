import { expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  type ClusterObservationSample,
  type ClusterRetryCounts,
  projectClusterObservation,
} from "./cluster-observation";

const noPreviousRetries: Option.Option<ClusterRetryCounts> = Option.none();

const sample: ClusterObservationSample = {
  isShutdown: false,
  runnersTotal: 3,
  runnersHealthy: 2,
  assignedShards: 300,
  expectedShards: 300,
  shardLockFailures: 4,
  shardLockRefreshAgeMillis: Option.some(12_000),
  mailboxUnprocessed: 7,
  mailboxOldestAgeMillis: Option.none(),
  mailboxRedeliveries: 1,
  residentEntities: 42,
  residentEntityCapacity: Option.some(10_000),
  queueRetriesTotal: 120,
  queuePendingRetries: 0,
  requestRetriesTotal: 9,
};

it("projects a sample into a bounded telemetry shape", () => {
  expect(projectClusterObservation(sample, noPreviousRetries)).toEqual({
    isShutdown: false,
    runnersTotal: 3,
    runnersHealthy: 2,
    assignedShards: 300,
    expectedShards: 300,
    unassignedShards: 0,
    shardLockFailures: 4,
    shardLockRefreshAgeMillis: Option.some(12_000),
    mailboxUnprocessed: 7,
    mailboxOldestAgeMillis: Option.none(),
    mailboxRedeliveries: 1,
    residentEntities: 42,
    residentCapacity: Option.some({ limit: 10_000, pressure: false }),
    queueRetriesTotal: 120,
    queuePendingRetries: 0,
    requestRetriesTotal: 9,
    retriesDelta: Option.none(),
  });
  const withPrevious = projectClusterObservation(
    sample,
    Option.some({ queueRetries: 115, requestRetries: 5 })
  );
  expect(withPrevious.retriesDelta).toEqual(Option.some({ queue: 5, request: 4 }));
});

it("reports shard assignment lag and resident entity capacity pressure", () => {
  expect(
    projectClusterObservation(
      {
        ...sample,
        assignedShards: 288,
        expectedShards: 300,
        residentEntities: 8,
        residentEntityCapacity: Option.some(10),
      },
      noPreviousRetries
    )
  ).toMatchObject({
    unassignedShards: 12,
    residentCapacity: Option.some({ limit: 10, pressure: true }),
  });
  expect(
    projectClusterObservation(
      { ...sample, residentEntities: 7, residentEntityCapacity: Option.some(10) },
      noPreviousRetries
    )
  ).toMatchObject({ residentCapacity: Option.some({ limit: 10, pressure: false }) });
});

it("clamps counts, ages, negatives, and unbounded capacity", () => {
  expect(
    projectClusterObservation(
      {
        ...sample,
        runnersTotal: 4_000_000,
        runnersHealthy: -5,
        assignedShards: 2,
        expectedShards: 5,
        shardLockFailures: -3,
        mailboxOldestAgeMillis: Option.some(999_999_999_999),
        residentEntities: 12.9,
        residentEntityCapacity: Option.none(),
        queueRetriesTotal: 2_000_001,
        queuePendingRetries: 2_000_000,
        requestRetriesTotal: -1,
      },
      Option.some({ queueRetries: -2_999_999, requestRetries: -2_000_000 })
    )
  ).toEqual({
    isShutdown: false,
    runnersTotal: 1_000_000,
    runnersHealthy: 0,
    assignedShards: 2,
    expectedShards: 5,
    unassignedShards: 3,
    shardLockFailures: 0,
    shardLockRefreshAgeMillis: Option.some(12_000),
    mailboxUnprocessed: 7,
    mailboxOldestAgeMillis: Option.some(86_400_000),
    mailboxRedeliveries: 1,
    residentEntities: 12,
    residentCapacity: Option.none(),
    queueRetriesTotal: 1_000_000,
    queuePendingRetries: 1_000_000,
    requestRetriesTotal: 0,
    retriesDelta: Option.some({ queue: 1_000_000, request: 1_000_000 }),
  });
});
