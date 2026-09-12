import { timingSafeEqual } from "node:crypto";
import { BunClusterHttp, BunCrypto } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import {
  type MessageStorage,
  RunnerHealth,
  RunnerServer,
  Runners,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
} from "effect/unstable/cluster";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import {
  type ClusterTopologyIncompatible,
  ensureClusterCompatibility,
} from "./cluster-compatibility";
import type { ClusterObservationDependencies } from "./cluster-observation";
import { ClusterReadiness } from "./cluster-readiness";
import {
  ClusterTelemetry,
  requestRetryRunnersLive,
  shardLockStorageLayer,
} from "./cluster-telemetry";
import {
  type ClusterCompatibilityIdentity,
  clusterCompatibilityIdentity,
  clusterSerialization,
} from "./cluster-topology";

const clusterRunnerPath = "/_fidy/cluster";

/**
 * Wire codec per published Cluster serialization. Keying the map by `clusterSerialization` makes the
 * published contract and the codec this server provides fail to compile apart.
 */
export const clusterSerializationLayers: Record<
  typeof clusterSerialization,
  (maxBufferSize: number) => Layer.Layer<RpcSerialization.RpcSerialization>
> = {
  msgpack: (maxBufferSize) => RpcSerialization.layerMsgPackWith({ maxBufferSize }),
};
const registerRoutes = HttpRouter.use;

/** Opaque Cluster bearer token; unwrapped only for the wire header and the constant-time comparison. */
type ClusterToken = Redacted.Redacted<string>;

const bearer = (token: ClusterToken): string => `Bearer ${Redacted.value(token)}`;

const credentialsMatch = (actual: Option.Option<string>, expected: ClusterToken): boolean => {
  if (Option.isNone(actual)) return false;
  const actualBytes = Buffer.from(actual.value);
  const expectedBytes = Buffer.from(bearer(expected));
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

/**
 * Installs fail-closed bearer authentication over the private Cluster runner listener. Every
 * request must present the shared token: the router matches paths case-insensitively and ignores
 * trailing or duplicated slashes, so guarding the exact path would let a differently spelled
 * request reach the runner handlers unauthenticated. The listener serves only the runner protocol,
 * so it denies every request that does not authenticate instead of choosing per path.
 */
export const authenticatedRunnerMiddleware = (
  token: ClusterToken
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  registerRoutes((router) =>
    router.addGlobalMiddleware((next) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!credentialsMatch(Option.fromUndefinedOr(request.headers.authorization), token)) {
          return HttpServerResponse.empty({ status: 401 });
        }
        return yield* next;
      })
    )
  );

const authenticatedClientProtocol = (
  token: ClusterToken
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
        make: (address: {
          readonly host: string;
          readonly port: number;
        }): ReturnType<Runners.RpcClientProtocol["Service"]["make"]> => {
          const prependUrl = HttpClientRequest.prependUrl(
            `http://${address.host}:${address.port}${clusterRunnerPath}`
          );
          const authenticatedClient = HttpClient.mapRequest(client, (request) =>
            HttpClientRequest.setHeader(prependUrl(request), "authorization", bearer(token))
          );
          return RpcClient.makeProtocolHttp(authenticatedClient).pipe(
            Effect.provideService(RpcSerialization.RpcSerialization, serialization)
          );
        },
      };
    })
  );

/**
 * SQL-backed Bun Cluster transport with authenticated runner ingress and egress. The effective
 * Sharding configuration becomes an explicit topology, and no process may acquire shards or read
 * the durable mailbox until it has published or validated the shared compatibility identity.
 */
export type AuthenticatedClusterLayer = Layer.Layer<
  | MessageStorage.MessageStorage
  | Runners.Runners
  | ClusterReadiness
  | ClusterObservationDependencies,
  HttpServerError.ServeError | ClusterTopologyIncompatible | SqlError.SqlError,
  SqlClient.SqlClient
>;

/**
 * Runs the compatibility gate before building the Cluster infrastructure. A mismatch fails startup
 * with `ClusterTopologyIncompatible` naming the differing fields instead of letting the
 * infrastructure build; the process-level failure is the single report.
 */
const gateClusterCompatibility = <A, E, R>(
  compatibility: ClusterCompatibilityIdentity,
  infrastructure: Layer.Layer<A, E, R>
): Layer.Layer<A, E | ClusterTopologyIncompatible | SqlError.SqlError, R | SqlClient.SqlClient> =>
  Layer.unwrap(ensureClusterCompatibility(compatibility).pipe(Effect.as(infrastructure)));

const layerAuthenticatedSqlCluster = (
  token: ClusterToken,
  shardingOptions: Partial<ShardingConfig.ShardingConfig["Service"]>
): AuthenticatedClusterLayer => {
  const sharding = { ...ShardingConfig.defaults, ...shardingOptions };
  const compatibility = clusterCompatibilityIdentity(sharding);
  const protocol = authenticatedClientProtocol(token).pipe(Layer.provide(FetchHttpClient.layer));
  const runnerHealth = RunnerHealth.layerPing.pipe(
    Layer.provide(Runners.layerRpc),
    Layer.provide(protocol)
  );
  // `RunnerServer.layerWithClients` builds Sharding on the plain runner client; composing the
  // server here instead substitutes the request-retry client so Sharding routes sends through it.
  const runner = HttpRouter.serve(
    Layer.mergeAll(
      authenticatedRunnerMiddleware(token),
      RunnerServer.layer.pipe(
        Layer.provide(RpcServer.layerProtocolHttp({ path: clusterRunnerPath })),
        Layer.provideMerge(Sharding.layer),
        Layer.provideMerge(requestRetryRunnersLive)
      )
    )
  ).pipe(Layer.provide(protocol), Layer.provide(BunClusterHttp.layerHttpServer));

  const infrastructure = runner.pipe(
    Layer.provide(runnerHealth),
    Layer.provideMerge(
      Layer.orDie(SqlMessageStorage.layerWith({ prefix: compatibility.messageStoragePrefix })).pipe(
        Layer.provide(BunCrypto.layer)
      )
    ),
    Layer.provideMerge(
      Layer.orDie(shardLockStorageLayer({ prefix: compatibility.runnerStoragePrefix })).pipe(
        Layer.provideMerge(ClusterTelemetry.layer)
      )
    ),
    Layer.provideMerge(ShardingConfig.layer(sharding)),
    Layer.provide(
      clusterSerializationLayers[clusterSerialization](compatibility.serializationMaxBufferSize)
    )
  );

  const gatedCluster = gateClusterCompatibility(compatibility, infrastructure);

  // Readiness must observe the same memoized Cluster services that serve traffic. One
  // `provideMerge` edge keeps a single dependency on the gated Cluster, so a compatibility refusal
  // is recorded once and readiness starts only after the gate has passed.
  return ClusterReadiness.layer.pipe(Layer.provideMerge(gatedCluster));
};

export const authenticatedClusterHttp = {
  layerSql: layerAuthenticatedSqlCluster,
};
