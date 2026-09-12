import { timingSafeEqual } from "node:crypto";
import { BunClusterHttp, BunCrypto } from "@effect/platform-bun";
import { type Config, Effect, Layer, Option, Redacted } from "effect";
import {
  HttpRunner,
  type MessageStorage,
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
  HttpClientRequest,
  HttpRouter,
  type HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { SqlClient } from "effect/unstable/sql";

const messageBufferKibibytes = 64;
const bytesPerKibibyte = 1024;
const maximumMessageBufferBytes = messageBufferKibibytes * bytesPerKibibyte;
const clusterRunnerPath = "/_fidy/cluster";
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

/** Installs fail-closed bearer authentication over every private Cluster runner route. */
export const authenticatedRunnerMiddleware = (
  token: ClusterToken
): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  registerRoutes((router) =>
    router.addGlobalMiddleware((next) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const path = new URL(request.url, "http://runner").pathname;
        if (
          path === clusterRunnerPath &&
          !credentialsMatch(Option.fromUndefinedOr(request.headers.authorization), token)
        ) {
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

/** SQL-backed Bun Cluster transport with authenticated runner ingress and egress. */
const layerAuthenticatedSqlCluster = (
  token: ClusterToken,
  shardingConfig: Partial<ShardingConfig.ShardingConfig["Service"]>
): Layer.Layer<
  MessageStorage.MessageStorage | Runners.Runners | Sharding.Sharding,
  Config.ConfigError | HttpServerError.ServeError,
  SqlClient.SqlClient
> => {
  const protocol = authenticatedClientProtocol(token).pipe(Layer.provide(FetchHttpClient.layer));
  const runnerHealth = RunnerHealth.layerPing.pipe(
    Layer.provide(Runners.layerRpc),
    Layer.provide(protocol)
  );
  const runner = HttpRouter.serve(
    Layer.mergeAll(
      authenticatedRunnerMiddleware(token),
      HttpRunner.layerHttpOptions({ path: clusterRunnerPath })
    )
  ).pipe(Layer.provide(protocol), Layer.provide(BunClusterHttp.layerHttpServer));

  return runner.pipe(
    Layer.provide(runnerHealth),
    Layer.provideMerge(Layer.orDie(SqlMessageStorage.layer).pipe(Layer.provide(BunCrypto.layer))),
    Layer.provide(Layer.orDie(SqlRunnerStorage.layer)),
    Layer.provide(ShardingConfig.layerFromEnv(shardingConfig)),
    Layer.provide(RpcSerialization.layerMsgPackWith({ maxBufferSize: maximumMessageBufferBytes }))
  );
};

export const authenticatedClusterHttp = {
  layerSql: layerAuthenticatedSqlCluster,
};
