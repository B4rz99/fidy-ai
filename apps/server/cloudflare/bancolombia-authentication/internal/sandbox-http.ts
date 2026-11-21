import { Effect } from "effect";
import { HttpClient } from "effect/http";
import type { BancolombiaSandboxHttpService } from "../../../src/shell/outbound-http/contract";
import { BancolombiaSandboxHttp } from "../../../src/shell/outbound-http/operations";

export const sandboxHttp = (
  httpClient: HttpClient.HttpClient
): Effect.Effect<BancolombiaSandboxHttpService> =>
  BancolombiaSandboxHttp.make.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
