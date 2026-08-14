import { TokenBearer } from "~/core/tokens/model";

/** The deterministic all-scopes bearer used only by API-seam tests. */
export const defaultPatBearer = TokenBearer.make(
  "fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"
);
