import type { HostedTurnClient } from "@/transport/hosted-turn-client";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient, WebAuthClient } from "@/transport/client";

export type WebRouterContext = Readonly<{
  registry: AtomRegistry.AtomRegistry;
  /** Display identity checked by BrowserSessionBoundary; never grants authority. */
  sessionBinding: string;
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
