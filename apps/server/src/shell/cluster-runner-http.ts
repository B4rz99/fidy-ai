import { type Array, type Duration, Effect, Redacted } from "effect";
import { type RunnerAddress } from "effect/unstable/cluster";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { type RpcClient, RpcClientError } from "effect/unstable/rpc";
import { protectHttpClient } from "~/shell/_shared/protected-http-client";
import {
  type HttpClientErrorProjection,
  isHttpClientErrorReason,
  projectHttpClientError,
} from "~/shell/_shared/projected-http-client-error";

/** The one private Cluster runner route shared by runner ingress and egress. */
export const clusterRunnerPath = "/_fidy/cluster";

const authorizationHeader = "authorization";
const projectedRunnerRequestUrl = `http://cluster.invalid${clusterRunnerPath}`;

/**
 * The one coordinate and header policy every projected runner failure is rebuilt over. No runner
 * response header is part of the RPC caller contract, so none survives projection.
 */
const runnerHttpErrorProjection = {
  retainedResponseHeaders: [],
  projectedRequestUrl: projectedRunnerRequestUrl,
} as const satisfies HttpClientErrorProjection;

/** Opaque Cluster bearer token; unwrapped only for the wire header and the ingress comparison. */
export type ClusterToken = Redacted.Redacted<string>;

/** The one wire form of the Cluster credential, shared by runner ingress and egress. */
export const clusterBearerValue = (token: ClusterToken): string =>
  `Bearer ${Redacted.value(token)}`;

/**
 * Configured private Cluster runner ports. Replicas share one advertised port, so production
 * pins it (`Configured`); loopback harnesses listen on ephemeral ports they cannot know at layer
 * construction, so they explicitly opt into every port (`Any`).
 */
export type ClusterRunnerPorts =
  | Readonly<{ readonly _tag: "Any" }>
  | Readonly<{ readonly _tag: "Configured"; readonly ports: Array.NonEmptyArray<number> }>;

/** Private Cluster runner addresses a client protocol may dial with the shared credential. */
export type ClusterRunnerAllowlist = Readonly<{
  /** Configured private Cluster hosts allowed to receive the shared Cluster credential. */
  readonly runnerHosts: Array.NonEmptyArray<string>;
  /** Ports on those hosts that may receive the shared Cluster credential. */
  readonly runnerPorts: ClusterRunnerPorts;
}>;

/**
 * The explicit policy every private Cluster RPC request obeys before an RPC protocol is derived.
 *
 * Runner addresses come from shared runner storage, so the transport cannot assume a routing row
 * still points at the private Cluster. The allowlist, the refusal of redirects, and the exchange
 * deadlines are decided here once, and every failure is rebuilt over a coordinate-free request.
 * The derived protocol applies one bound per exchange from connection establishment through
 * response body consumption: health inside `healthDeadline` and hosted Work inside
 * `requestDeadline`.
 */
export type ClusterRunnerHttpPolicy = ClusterRunnerAllowlist &
  Readonly<{
    /**
     * Bound on one runner health exchange from connection establishment through response body
     * consumption. A runner that cannot answer inside this bound is reported unhealthy so shard
     * ownership can move.
     */
    readonly healthDeadline: Duration.Input;
    /**
     * Bound on one hosted-Work runner exchange from connection establishment through response
     * body consumption. It is sized above the Turn's bounded model-round budget with delivery
     * margin, so the transport remains a safety net for a stalled runner: it bounds one caller's
     * wait, and an admitted Turn keeps running under its own limits when the wait expires.
     */
    readonly requestDeadline: Duration.Input;
  }>;

const defaultHttpPort = 80;

const normalizedHost = (host: string): string => {
  const trimmed = host.trim().toLowerCase();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
};

const urlPort = (url: URL): number => (url.port !== "" ? Number(url.port) : defaultHttpPort);

/**
 * True only when `rawUrl` is an absolute HTTP URL on a configured private runner address and
 * carries no user info. It accepts exactly the scheme the runner transport forms, and every other
 * destination is refused before the request can execute, so a routing row cannot redirect the
 * Cluster credential at an arbitrary address.
 */
export const isConfiguredRunnerDestination =
  (allowlist: ClusterRunnerAllowlist) =>
  (rawUrl: string): boolean => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    if (url.protocol !== "http:") return false;
    if (url.username !== "" || url.password !== "") return false;
    const host = normalizedHost(url.hostname);
    if (!allowlist.runnerHosts.some((configured) => normalizedHost(configured) === host)) {
      return false;
    }
    return (
      allowlist.runnerPorts._tag === "Any" || allowlist.runnerPorts.ports.includes(urlPort(url))
    );
  };

const projectedRequest = (
  method: HttpClientRequest.HttpClientRequest["method"]
): HttpClientRequest.HttpClientRequest => HttpClientRequest.make(method)(projectedRunnerRequestUrl);

/** Rebuilds any runner failure over the one constant coordinate, preserving only its reason kind. */
const runnerHttpClientError = (
  reason: HttpClientError.HttpClientErrorReason
): HttpClientError.HttpClientError =>
  projectHttpClientError(runnerHttpErrorProjection)(
    new HttpClientError.HttpClientError({ reason })
  );

const destinationRefused = (
  request: HttpClientRequest.HttpClientRequest
): HttpClientError.HttpClientError =>
  runnerHttpClientError(new HttpClientError.InvalidUrlError({ request }));

/** Brackets an IPv6 literal so it forms a valid URL authority; hostnames pass through unchanged. */
const urlAuthorityHost = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/**
 * The one absolute request URL for a runner address. An IPv6 runner host is bracketed so the URL
 * stays parseable; the destination allowlist matches either spelling.
 */
export const runnerRequestUrl = (address: RunnerAddress.RunnerAddress): string =>
  `http://${urlAuthorityHost(address.host)}:${address.port}${clusterRunnerPath}`;

const authenticatedRequest = (
  address: RunnerAddress.RunnerAddress,
  request: HttpClientRequest.HttpClientRequest
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setUrl(runnerRequestUrl(address))(request);

const projectedTransportReason = (): HttpClientError.TransportError =>
  new HttpClientError.TransportError({ request: projectedRequest("POST") });

/**
 * The closed protocol defect every runner RPC reason outside the HTTP reason kind projects to.
 * Its cause is never retained: a raw protocol defect can embed the encoded RPC request.
 */
const projectedRpcDefect = (): RpcClientError.RpcClientDefect =>
  RpcClientError.RpcClientDefect.make({
    message: "Runner RPC protocol failed",
    cause: undefined,
  });

const deadlineExceededRpc = (): RpcClientError.RpcClientError =>
  RpcClientError.RpcClientError.make({
    reason: HttpClientError.HttpClientErrorSchema.make({
      _tag: "HttpError",
      kind: "TransportError",
      cause: projectedTransportReason(),
    }),
  });

/**
 * Rebuilds every runner RPC failure over closed, coordinate-free metadata. A protocol defect can
 * embed the encoded RPC request, so a reason outside the closed HTTP reason kind projects to the
 * closed defect instead of passing through.
 */
const projectedRunnerRpcError = (
  error: RpcClientError.RpcClientError
): RpcClientError.RpcClientError => {
  const reason = error.reason;
  if (reason._tag !== "HttpError") {
    return RpcClientError.RpcClientError.make({ reason: projectedRpcDefect() });
  }
  const cause = reason.cause;
  if (!isHttpClientErrorReason(cause)) {
    // Fail closed: an unrecognized cause could carry anything, so only the safe kind survives.
    return RpcClientError.RpcClientError.make({
      reason: HttpClientError.HttpClientErrorSchema.make({
        _tag: "HttpError",
        kind: reason.kind,
      }),
    });
  }
  return RpcClientError.RpcClientError.make({
    reason: HttpClientError.HttpClientErrorSchema.make({
      _tag: "HttpError",
      kind: cause._tag,
      cause: runnerHttpClientError(cause).reason,
    }),
  });
};

/**
 * Bounds one derived RPC exchange from connection establishment through response body
 * consumption, and rebuilds every transport reason over the coordinate-free runner request.
 * `FetchHttpClient` hands the executing fiber's abort signal to `fetch`, so interrupting this
 * bound aborts an in-flight connection attempt as well as the response stream. `RpcClient`
 * consumes the response stream inside `Protocol.send`, outside any `HttpClient` transform, so
 * the protocol is the one seam that observes the whole exchange.
 */
export const boundRunnerRpcProtocol = (input: {
  readonly protocol: RpcClient.Protocol["Service"];
  readonly deadline: Duration.Input;
}): RpcClient.Protocol["Service"] => ({
  ...input.protocol,
  send: (clientId, request, transferables) =>
    input.protocol.send(clientId, request, transferables).pipe(
      Effect.timeoutOrElse({
        duration: input.deadline,
        orElse: () => Effect.fail(deadlineExceededRpc()),
      }),
      Effect.mapError(projectedRunnerRpcError)
    ),
});

/**
 * Derives one policy-bearing client for a private runner address. It owns the runner URL, the
 * bearer header, destination refusal, redirect refusal, and coordinate-free failure
 * classification, and applies the shared protected-client hardening, so the RPC protocol derived
 * from it can only ever report safe transport metadata. The derived protocol, not this client,
 * owns the exchange deadline.
 */
export const makeClusterRunnerHttpClient = (
  input: ClusterRunnerAllowlist &
    Readonly<{
      readonly client: HttpClient.HttpClient;
      readonly token: ClusterToken;
      readonly address: RunnerAddress.RunnerAddress;
    }>
): HttpClient.HttpClient => {
  const authenticated = HttpClient.mapRequest(input.client, (request) =>
    HttpClientRequest.setHeader(
      authenticatedRequest(input.address, request),
      authorizationHeader,
      clusterBearerValue(input.token)
    )
  );
  const destinationChecked = HttpClient.mapRequestEffect(authenticated, (request) =>
    isConfiguredRunnerDestination(input)(request.url)
      ? Effect.succeed(request)
      : Effect.fail(destinationRefused(request))
  );
  const protectedClient = protectHttpClient({
    ...runnerHttpErrorProjection,
    redactedHeaders: [authorizationHeader],
    // Runner RPC tracing is disabled (`Runners.makeRpcClient`) and the private listener extracts no
    // HTTP trace headers, so propagating Fidy trace coordinates would link no receiving trace;
    // hosted Work stays observed by its `agent.turn` Work span and runner health by runner
    // availability.
    propagateTrace: false,
  })(destinationChecked);
  return HttpClient.transform(protectedClient, (responseEffect) =>
    responseEffect.pipe(
      // The runtime refuses any 3xx itself: no redirect target can receive the bearer header.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" })
    )
  );
};
