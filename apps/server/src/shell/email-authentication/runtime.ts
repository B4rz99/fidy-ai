import { Option } from "effect";
import { UserId } from "~/core/identity/reference";
import { WebSessionId } from "~/core/web-session/reference";
import type { CanonicalImplementationCaller } from "~/shell/_shared/canonical-implementation";
import { canonicalMutationImplementations } from "~/shell/_shared/canonical-mutation-registry";
import { EmailReplacementMutation, type EmailReplacementMutationService } from "./mutation";
import { FidyApi } from "~/shell/api";
import { decideOperationAccess, getOperationPolicy } from "~/shell/_shared/operation-policy";

/** The Worker binds its two D1 handlers to these declared operations, not to a copied route table. */
export const emailReplacementOperations = {
  request: FidyApi.groups.emailAuthentication.endpoints.requestEmailReplacement,
  complete: FidyApi.groups.emailAuthentication.endpoints.completeEmailReplacement,
} as const;

export { EmailReplacementMutation, type EmailReplacementMutationService };
export const emailReplacementImplementations = {
  request: canonicalMutationImplementations["emailAuthentication.requestEmailReplacement"],
  complete: canonicalMutationImplementations["emailAuthentication.completeEmailReplacement"],
} as const;

/** The browser WebSession is the sole authority for the canonical replacement invocation. */
export const browserReplacementCaller = (session: {
  readonly user_id: string;
  readonly id: string;
}): CanonicalImplementationCaller => ({
  resolved: {
    subjectUserId: UserId.make(session.user_id),
    capabilities: [],
    authorityRoot: "no-verified-whatsapp-authority",
    auditCaller: { _tag: "WebSession", webSessionId: WebSessionId.make(session.id) },
    fresh: true,
  },
  accessTier: "free",
  confirmationEvidence: () => Option.none(),
});

type ReplacementOperation = keyof typeof emailReplacementOperations;

/** Fail closed if the declaration's browser access policy diverges from Worker authorization. */
export const permitsFreshBrowserReplacement = (operation: ReplacementOperation): boolean => {
  const { access } = getOperationPolicy(emailReplacementOperations[operation]);
  return (
    access._tag === "FreshWebSessionOnly" &&
    decideOperationAccess(access, { _tag: "WebSession", fresh: true })._tag === "Allowed"
  );
};
