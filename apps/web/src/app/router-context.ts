import type { HostedTurnClient } from "@/transport/hosted-turn-client";
import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient, WebAuthClient } from "@/transport/client";

export type WebRouterContext = Readonly<{
  registry: AtomRegistry.AtomRegistry;
  sessionBinding: string;
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
