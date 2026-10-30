import { browserSessionBindingPath } from "~/shell/browser-transport/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { TransactionListResponse } from "~/shell/transactions/contract";
import { CurrentUserMetadata } from "~/shell/identity/contract";
import {
  GrantedProcessingConsent,
  MissingProcessingConsent,
  RevokedProcessingConsent,
} from "~/shell/processing-consent/contract";
import { ResourceLimited, Unavailable } from "~/shell/public-http/contract";
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

export {
  browserSessionBindingHeader,
  browserSessionBindingPath,
} from "~/shell/browser-transport/contract";
/** A fresh bootstrap observation. Ordinary metadata exists only in the Granted branch. */
export const InitialTransactionPage = Schema.Struct({
  from: UtcTimestamp,
  to: UtcTimestamp,
  page: TransactionListResponse,
});
export type InitialTransactionPage = typeof InitialTransactionPage.Type;
export const BrowserSessionInitialContext = Schema.Union([
  Schema.Struct({
    ...GrantedProcessingConsent.fields,
    profile: CurrentUserMetadata,
    transactions: Schema.OptionFromOptionalKey(InitialTransactionPage),
  }),
  MissingProcessingConsent,
  RevokedProcessingConsent,
]);
export type BrowserSessionInitialContext = typeof BrowserSessionInitialContext.Type;
export const BrowserSessionBinding = Schema.Struct({
  binding: Schema.NullOr(WebSessionId),
  initial: Schema.OptionFromOptionalKey(BrowserSessionInitialContext),
});
export const BrowserSessionGroup = HttpApiGroup.make("browserSession").add(
  HttpApiEndpoint.get("binding", browserSessionBindingPath, {
    query: Schema.Struct({
      context: Schema.optionalKey(Schema.Literals(["application", "transactions"])),
    }),
    success: BrowserSessionBinding,
    error: [ResourceLimited, Unavailable],
  }).annotate(
    OpenApi.Description,
    "Read current browser session identity before mounting authenticated state. Optional application context adds fresh Consent and same-session authorized User display metadata under the unchanged request-pressure guard; it never authorizes later work."
  )
);
