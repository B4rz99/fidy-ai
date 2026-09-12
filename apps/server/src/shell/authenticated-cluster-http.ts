import { timingSafeEqual } from "node:crypto";
import { BunClusterHttp, BunCrypto } from "@effect/platform-bun";
import { type Config, type Duration, Effect, Layer, Option } from "effect";
import {
  HttpRunner,
  type MessageStorage,
  type RunnerAddress,
  RunnerHealth,
  Runners,
  type Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from "effect/unstable/cluster";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { SqlClient } from "effect/unstable/sql";
import {
  type ClusterRunnerHttpPolicy,
  type ClusterToken,
  boundRunnerRpcProtocol,
  clusterBearerValue,
  clusterRunnerPath,
  makeClusterRunnerHttpClient,
} from "./cluster-runner-http";

const messageBufferKibibytes = 64;
const bytesPerKibibyte = 1024;
/** Retained incomplete-frame bound shared by every private Cluster client and runner. */
export const maximumClusterMessageBufferBytes = messageBufferKibibytes * bytesPerKibibyte;

/**
 * Exact MessagePack framing shared by private Cluster clients and runners. The bound applies to an
 * incomplete frame retained across chunks, so a malformed or oversized peer cannot grow parser
 * memory without limit.
 */
export const ClusterRunnerSerializationLive: Layer.Layer<RpcSerialization.RpcSerialization> =
  RpcSerialization.layerMsgPackWith({ maxBufferSize: maximumClusterMessageBufferBytes });

const credentialsMatch = (actual: Option.Option<string>, expected: ClusterToken): boolean => {
  if (Option.isNone(actual)) return false;
  const actualBytes = Buffer.from(actual.value);
  const expectedBytes = Buffer.from(clusterBearerValue(expected));
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

/**
 * Installs fail-closed bearer authentication on the private Cluster runner route.
 *
 * `HttpRouter` matching accepts aliased spellings of a route (case, duplicate or trailing slashes,
 * decoded escapes), and one router instance serves every listener in the process. A guard keyed on
 * the request path cannot cover every spelling that still reaches the runner handler, while
 * refusing unrelated paths would break the public listener that shares the router. Attaching the
 * guard to the runner route registration wraps that handler itself, so every request the router
 * dispatches to the runner route — aliases included — is authenticated before it can run.
 */
export const authenticatedRunnerMiddleware = (token: ClusterToken): Layer.Layer<never> =>
  HttpRouter.middleware((next) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!credentialsMatch(Option.fromUndefinedOr(request.headers.authorization), token)) {
        return HttpServerResponse.empty({ status: 401 });
      }
      return yield* next;
    })
  ).layer;

/**
 * The one runner RPC protocol, derived per address from the policy-bearing client. Health and
 * hosted Work each select their own exchange deadline, but share the destination, redirect,
 * credential, and diagnostic policy.
 */
const authenticatedClientProtocol = (
  token: ClusterToken,
  policy: ClusterRunnerHttpPolicy,
  deadline: Duration.Input
): Layer.Layer<
  Runners.RpcClientProtocol,
  never,
  RpcSerialization.RpcSerialization | HttpClient.HttpClient
> =>
  Layer.effect(
    Runners.RpcClientProtocol,
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const client = yield* HttpClient.HttpClient;
      return {
        codecFor: serialization.codecFor,
        make: (
          address: RunnerAddress.RunnerAddress
        ): ReturnType<Runners.RpcClientProtocol["Service"]["make"]> => {
          const runnerClient = makeClusterRunnerHttpClient({
            client,
            token,
            address,
            runnerHosts: policy.runnerHosts,
            runnerPorts: policy.runnerPorts,
          });
          return RpcClient.makeProtocolHttp(runnerClient).pipe(
            Effect.provideService(RpcSerialization.RpcSerialization, serialization),
            // The protocol carries the exchange deadline and failure projection.
            Effect.map((protocol) => boundRunnerRpcProtocol({ protocol, deadline }))
          );
        },
      };
    })
  );

/** SQL-backed Bun Cluster transport with authenticated runner ingress and egress. */
const layerAuthenticatedSqlCluster = (
  token: ClusterToken,
  shardingConfig: Partial<ShardingConfig.ShardingConfig["Service"]>,
  policy: ClusterRunnerHttpPolicy
): Layer.Layer<
  MessageStorage.MessageStorage | Runners.Runners | Sharding.Sharding,
  Config.ConfigError | HttpServerError.ServeError,
  SqlClient.SqlClient
> => {
  // Health probes fail fast so shard ownership can move; Work outlives its own bounded Turn.
  // The health probe needs its own `Runners` instance: layer memoization is keyed by layer
  // identity, so sharing `Runners.layerRpc` here would bind the Work client to whichever protocol
  // is built first, silently giving hosted Work the health deadline.
  const healthProtocol = authenticatedClientProtocol(token, policy, policy.healthDeadline).pipe(
    Layer.provide(FetchHttpClient.layer)
  );
  const runnerHealth = RunnerHealth.layerPing.pipe(
    Layer.provide(Layer.fresh(Runners.layerRpc)),
    Layer.provide(healthProtocol)
  );
  const workProtocol = authenticatedClientProtocol(token, policy, policy.requestDeadline).pipe(
    Layer.provide(FetchHttpClient.layer)
  );
  const runner = HttpRouter.serve(
    HttpRunner.layerHttpOptions({ path: clusterRunnerPath }).pipe(
      Layer.provide(authenticatedRunnerMiddleware(token))
    )
  ).pipe(Layer.provide(workProtocol), Layer.provide(BunClusterHttp.layerHttpServer));

  return runner.pipe(
    Layer.provide(runnerHealth),
    Layer.provideMerge(Layer.orDie(SqlMessageStorage.layer).pipe(Layer.provide(BunCrypto.layer))),
    Layer.provide(Layer.orDie(SqlRunnerStorage.layer)),
    Layer.provide(ShardingConfig.layerFromEnv(shardingConfig)),
    Layer.provide(ClusterRunnerSerializationLive)
  );
};

export const authenticatedClusterHttp = {
  layerSql: layerAuthenticatedSqlCluster,
};
