import { HttpClient } from "effect/http";
import { accessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import type { ErasureRegistry } from "./contract";
import { nativeOperatorRequest } from "./internal/operator-request";
import { Effect } from "effect";
import { registryStorage } from "./internal/registry-storage";
import { registryClient, registryRequest } from "./internal/registry-transport";

export const makeSqliteErasureRegistry = (
  storage: Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">
): ErasureRegistry => registryStorage(storage);

export const makeRemoteErasureRegistry = (target: Pick<Fetcher, "fetch">): ErasureRegistry =>
  registryClient(target);

export const handleErasureRegistry = (
  input: Readonly<{ request: Request; registry: ErasureRegistry }>
): Promise<Response> => Effect.runPromise(registryRequest(input));

export const handleNativeErasureOperator = Effect.fn(function* (
  request: Request,
  environment: Parameters<typeof nativeOperatorRequest>[0]["environment"]
) {
  const http = accessSigningKeysOutboundHttp({
    issuer: environment.CLOUDFLARE_ACCESS_ISSUER,
    httpClient: yield* HttpClient.HttpClient,
  });

  return yield* nativeOperatorRequest({ request, environment, http });
});
