import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";

/** One stable User and the fresh authenticated WebSession authorizing an account change. */
export type FreshSessionSubject = Readonly<{ id: string; user_id: string }>;

/** A resolved WebSession credential to recheck within its protected work. */
export type WebSessionSubject = Readonly<{ id: string; userId: string; digest: Uint8Array }>;
/** A complete live WebSession predicate to commit with its protected User-owned action. */
export type WebSessionAuthority = Readonly<{
  table: "web_sessions";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** Browser-only revocation of the presented WebSession, retaining the established logout path. */
export const logoutWebSessionEndpoint = HttpApiEndpoint.post("logout", "/web/session/logout", {
  success: HttpApiSchema.NoContent,
}).annotate(OpenApi.Description, "Revoke the current browser WebSession and expire its cookie.");
