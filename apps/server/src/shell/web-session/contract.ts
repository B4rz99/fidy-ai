import { Schema } from "effect";
import { WebSessionId } from "~/core/web-session/contract";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";

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

/** Public correlation for one browser authority lifetime; never sufficient to authenticate. */
export const browserSessionBindingHeader = "Fidy-Session-Binding";
export const browserSessionBindingPath = "/web/session/binding";
export const BrowserSessionBinding = Schema.Struct({ binding: Schema.NullOr(WebSessionId) });
export const BrowserSessionGroup = HttpApiGroup.make("browserSession").add(
  HttpApiEndpoint.get("binding", browserSessionBindingPath, {
    success: BrowserSessionBinding,
  }).annotate(
    OpenApi.Description,
    "Read the current browser session identity before mounting authenticated state. This identity grants no authority."
  )
);
