import { type Config, Crypto, Layer, Option, Redacted } from "effect";
import type { PgClient } from "@effect/sql-pg/PgClient";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import type { SqlClient } from "effect/unstable/sql";
import type { WorkflowEngine } from "effect/unstable/workflow";
import {
  type AuthenticatedClusterLayer,
  authenticatedClusterHttp,
} from "~/shell/authenticated-cluster-http";
import { PgLive } from "~/shell/db/client";
import { clusterTestSharedOptions } from "./cluster-topology-fixtures";
import {
  EmailDeliveryPort,
  type EmailDeliveryPortService,
} from "~/shell/email-authentication/delivery";
import {
  type ReplacementDeliveryWorkflowLive,
  type ReplacementExpiryWorkflowLive,
} from "~/shell/email-authentication/replacement-workflow";

/** Real SQL/HTTP Cluster configuration shared by in-process and hard-killed replacement test runners. */
const testAuthenticationTokenBytes = 64;

export const replacementRuntimeLayer = ({
  crypto,
  port,
  provider,
  deliveryLive,
  expiryLive,
}: Readonly<{
  crypto: Crypto.Crypto;
  port: number;
  provider: EmailDeliveryPortService;
  deliveryLive: typeof ReplacementDeliveryWorkflowLive;
  expiryLive: typeof ReplacementExpiryWorkflowLive;
}>): Layer.Layer<
  | WorkflowEngine.WorkflowEngine
  | SqlClient.SqlClient
  | PgClient
  | Layer.Success<AuthenticatedClusterLayer>,
  Config.ConfigError | Layer.Error<AuthenticatedClusterLayer>
> =>
  Layer.mergeAll(deliveryLive, expiryLive).pipe(
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql(
            Redacted.make("d".repeat(testAuthenticationTokenBytes)),
            {
              runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
              runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
              ...clusterTestSharedOptions,
              runnerHealthCheckInterval: "1 second",
              shardLockRefreshInterval: "500 millis",
              shardLockExpiration: "2 seconds",
            }
          )
        )
      )
    ),
    Layer.provide(Layer.succeed(EmailDeliveryPort, provider)),
    Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
    Layer.provideMerge(PgLive)
  );
