import { PATId } from "../../src/core/tokens/contract";
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

export const patRouteUrl = "https://directory.invalid/pat-route";
export const sourcePressureUrl = "https://directory.invalid/unresolved-source";
export const patRouteHeader = "fidy-internal-pat-reference";
export const PATRoute = Schema.Struct({ userId: UserId, patId: PATId });
