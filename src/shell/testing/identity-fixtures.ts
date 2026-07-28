import { AgentBearerToken } from "~/core/tokens/model";

/** The deterministic all-scopes bearer used only by API-seam tests. */
export const defaultAgentBearer = AgentBearerToken.make(
  "fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"
);
