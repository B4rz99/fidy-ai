import { Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import { WebSessionId } from "../../src/core/web-session/contract";

export const directoryName = "directory-v1";
export const sessionRouteUrl = "https://directory.invalid/session-route";
export const SessionRoute = Schema.Struct({ userId: UserId, sessionId: WebSessionId });

export type UserStoreBindings = Readonly<{
  DIRECTORY: Pick<DurableObjectNamespace, "getByName">;
  USER_STORE: Pick<DurableObjectNamespace, "getByName">;
}>;
