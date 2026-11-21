import { accessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { ErasureRegistry } from "./contract";
import { nativeOperatorRequest } from "./internal/operator-request";
import { Effect, Layer, ManagedRuntime } from "effect";
import { registryStorage } from "./internal/registry-storage";
import { registryClient, registryRequest } from "./internal/registry-transport";

export const makeSqliteErasureRegistry = (
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">
): ErasureRegistry => registryStorage(storage);

export const makeRemoteErasureRegistry = (target: Pick<Fetcher, "fetch">): ErasureRegistry =>
  registryClient(target);

const registryRuntime = ManagedRuntime.make(Layer.empty);

export const handleErasureRegistry = (
  input: Readonly<{ request: Request; registry: ErasureRegistry }>
): Promise<Response> => registryRuntime.runPromise(registryRequest(input));

export const handleNativeErasureOperator = Effect.fn(function* (
  request: Request,
  environment: Parameters<typeof nativeOperatorRequest>[0]["environment"]
) {
  const http = yield* accessSigningKeysOutboundHttp(environment.CLOUDFLARE_ACCESS_ISSUER);

  return yield* nativeOperatorRequest({ request, environment, http });
});
