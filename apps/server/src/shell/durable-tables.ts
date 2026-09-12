/**
 * Durable table names shared by the runtime that writes them and the Fidy-owned operational readers
 * that query them, so a rename updates both sides together. Effect Cluster creates and owns the
 * mailbox tables; they are named here only where Fidy code reads or prunes them.
 */
import { clusterStoragePrefix } from "./cluster-topology";

/** Persisted queue table whose failed attempts are the durable retry-rate signal. */
export const durableQueueTable = "fidy_queue";

/** Cluster mailbox table whose unprocessed depth and oldest message drive backlog telemetry. */
export const clusterMessagesTable = `${clusterStoragePrefix}_messages`;

/** Cluster reply table paired with mailbox requests; retention prunes both together. */
export const clusterRepliesTable = `${clusterStoragePrefix}_replies`;

/** Cluster compatibility identity table holding the single deployment-wide topology contract. */
export const topologyIdentityTable = "cluster_topology_identity";
