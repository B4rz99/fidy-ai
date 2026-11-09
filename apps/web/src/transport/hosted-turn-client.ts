import { HostedTurnApi, type HostedTurnApiGroups } from "@fidy/server/hosted-turn-api";
import { AtomHttpApi } from "effect/reactivity";
import { type BrowserClientOptions, browserClientLayer } from "./browser-client-layer";
import { observeBrowserDecode } from "./browser-defects";

export {
  HostedTurnRequest,
  HostedTurnQuotaExceeded,
  HostedTurnReceipt,
  HostedTurnProposal,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
} from "@fidy/server/hosted-turn-api";

/** Browser-only reply/receipt channel; loading it never constructs the canonical API catalog. */
export type HostedTurnClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/HostedTurnClient",
  HostedTurnApiGroups
>;

export const makeHostedTurnClient = (options: BrowserClientOptions): HostedTurnClient =>
  AtomHttpApi.Service<never>()("@fidy/web/HostedTurnClient", {
    api: HostedTurnApi,
    baseUrl: options.apiOrigin,
    httpClient: browserClientLayer({ ...options, boundary: "hosted-turn" }),
    transformResponse: observeBrowserDecode,
  });
