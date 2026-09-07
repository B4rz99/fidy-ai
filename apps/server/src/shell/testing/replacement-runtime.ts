import { type Config, Crypto, Layer, Option } from "effect";
import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  ClusterWorkflowEngine,
  type MessageStorage,
  RunnerAddress,
  type Runners,
  type Sharding,
} from "effect/unstable/cluster";
import type { HttpServerError } from "effect/unstable/http";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { PgLive } from "~/shell/db/client";
import {
  EmailDeliveryPort,
  type EmailDeliveryPortService,
} from "~/shell/email-authentication/delivery";
import {
  type ReplacementDeliveryWorkflowLive,
  ReplacementExpiryWorkflowLive,
} from "~/shell/email-authentication/replacement-workflow";

/** Real SQL/HTTP Cluster configuration shared by in-process and hard-killed replacement test runners. */
const testAuthenticationTokenBytes = 64;

export const replacementRuntimeLayer = ({
  crypto,
  port,
  provider,
  deliveryLive,
}: Readonly<{
  crypto: Crypto.Crypto;
  port: number;
  provider: EmailDeliveryPortService;
  deliveryLive: typeof ReplacementDeliveryWorkflowLive;
}>): Layer.Layer<
  | MessageStorage.MessageStorage
  | Runners.Runners
  | Sharding.Sharding
  | WorkflowEngine.WorkflowEngine
  | SqlClient.SqlClient
  | PgClient,
  Config.ConfigError | HttpServerError.ServeError | SqlError.SqlError
> =>
  Layer.mergeAll(deliveryLive, ReplacementExpiryWorkflowLive).pipe(
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql("d".repeat(testAuthenticationTokenBytes), {
            runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
            availableShardGroups: ["default"],
            assignedShardGroups: ["default"],
            shardsPerGroup: 300,
            entityMessagePollInterval: 50,
            sendRetryInterval: 50,
            runnerHealthCheckInterval: "1 second",
            shardLockRefreshInterval: "500 millis",
            shardLockExpiration: "2 seconds",
          })
        )
      )
    ),
    Layer.provide(Layer.succeed(EmailDeliveryPort, provider)),
    Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
    Layer.provideMerge(PgLive)
  );
