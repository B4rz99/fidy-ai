import { Option, Schema } from "effect";
import { ClusterError } from "effect/unstable/cluster";
import { HttpClientError } from "effect/unstable/http";
import type { RpcClientError } from "effect/unstable/rpc";
import { isTransientHttpStatus } from "./http-status";

/** Closed transport-versus-protocol classification shared by shell RPC consumers. */
export type RpcFailureKind = "transient" | "incompatible";

export type RpcFailure = {
  readonly kind: RpcFailureKind;
  readonly cause: unknown;
};

type RpcHttpFailure = Extract<
  RpcClientError.RpcClientError["reason"],
  { readonly _tag: "HttpError" }
>;

const classifyStatusFailure = (failure: RpcHttpFailure): RpcFailureKind =>
  failure.cause instanceof HttpClientError.StatusCodeError &&
  isTransientHttpStatus(failure.cause.response.status)
    ? "transient"
    : "incompatible";

const classifyHttpFailure = (failure: RpcHttpFailure): RpcFailureKind => {
  switch (failure.kind) {
    case "TransportError":
      return "transient";
    case "StatusCodeError":
      return classifyStatusFailure(failure);
    case "EncodeError":
    case "InvalidUrlError":
    case "DecodeError":
    case "EmptyBodyError":
      return "incompatible";
  }
};

/**
 * Treats socket/worker and HTTP transport failures as transient, non-retryable HTTP or protocol
 * failures as incompatible, while preserving the causal envelope expected by internal callers.
 */
export const classifyRpcFailure = (failure: RpcClientError.RpcClientError): RpcFailure => {
  if (failure.reason._tag === "RpcClientDefect") {
    return { kind: "incompatible", cause: failure };
  }
  if (failure.reason._tag === "HttpError") {
    return { kind: classifyHttpFailure(failure.reason), cause: failure.reason };
  }
  return { kind: "transient", cause: failure };
};

/**
 * Maps known Cluster serialization defects to incompatible and capacity, persistence, assignment,
 * registration, or runner availability defects to transient; unknown defects return none.
 */
export const classifyClusterFailure = (failure: unknown): Option.Option<RpcFailureKind> => {
  if (Schema.is(ClusterError.MalformedMessage)(failure)) return Option.some("incompatible");
  if (
    Schema.is(ClusterError.MailboxFull)(failure) ||
    Schema.is(ClusterError.AlreadyProcessingMessage)(failure) ||
    Schema.is(ClusterError.PersistenceError)(failure) ||
    Schema.is(ClusterError.EntityNotAssignedToRunner)(failure) ||
    Schema.is(ClusterError.RunnerNotRegistered)(failure) ||
    Schema.is(ClusterError.RunnerUnavailable)(failure)
  ) {
    return Option.some("transient");
  }
  return Option.none();
};
