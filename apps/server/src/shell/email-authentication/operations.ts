import type {
  CanonicalImplementationCaller,
  CanonicalInput,
  CanonicalSuccess,
} from "~/shell/canonical-operations/contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { EmailPairingSubject } from "./contract";
import { emailPairingAllowsUser as compatibleSubject } from "~/shell/email-authentication/internal/pairing-subject";
import { Context, Effect, Option } from "effect";
import { UserId } from "~/core/identity/reference";
import { WebSessionId } from "~/core/web-session/reference";
import { decideOperationAccess } from "~/shell/canonical-policy/operations";
import { getOperationPolicy } from "~/shell/canonical-policy/contract";
import {
  EmailAuthenticationGroup,
  EmailReplacementInvalidApi,
  type EmailReplacementMutationService,
  emailReplacementInvalidBody,
} from "./contract";

export type { EmailReplacementMutationService } from "./contract";

export class EmailReplacementMutation extends Context.Service<
  EmailReplacementMutation,
  EmailReplacementMutationService
>()("@fidy/server/shell/email-authentication/operations/EmailReplacementMutation") {}

/** Both browser operations enter the same canonical mutation seam as other stable-User work. */
export const requestEmailReplacement = ({
  input,
  caller,
}: Readonly<{
  input: CanonicalInput<"emailAuthentication.requestEmailReplacement">;
  caller: CanonicalImplementationCaller;
}>): Effect.Effect<
  CanonicalSuccess<"emailAuthentication.requestEmailReplacement">,
  never,
  EmailReplacementMutation
> =>
  Effect.gen(function* () {
    const mutation = yield* EmailReplacementMutation;
    yield* mutation.request(caller.resolved.subjectUserId, input.payload.candidateEmail);
    return { data: { status: "pending" }, next: [] } as const;
  });

export const completeEmailReplacement = ({
  input,
  caller,
}: Readonly<{
  input: CanonicalInput<"emailAuthentication.completeEmailReplacement">;
  caller: CanonicalImplementationCaller;
}>): Effect.Effect<
  CanonicalSuccess<"emailAuthentication.completeEmailReplacement">,
  EmailReplacementInvalidApi,
  EmailReplacementMutation
> =>
  Effect.gen(function* () {
    const mutation = yield* EmailReplacementMutation;
    if (!(yield* mutation.complete(caller.resolved.subjectUserId, input.payload.combinedCode))) {
      return yield* EmailReplacementInvalidApi.make({ error: emailReplacementInvalidBody.error });
    }
    return { data: { status: "replaced" }, next: [] } as const;
  });

/** The Worker binds its two D1 handlers to these declared operations, not to a copied route table. */
export const emailReplacementOperations = {
  request: EmailAuthenticationGroup.endpoints.requestEmailReplacement,
  complete: EmailAuthenticationGroup.endpoints.completeEmailReplacement,
} as const;

export const emailReplacementImplementations = {
  request: requestEmailReplacement,
  complete: completeEmailReplacement,
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

/**
 * Retain only pairingId/userId subjects compatible with existing mailbox approval at commit.
 * The caller supplies trusted static SQL projecting pairingId and userId with parameterized values,
 * then composes the returned query into its own guarded statement. No proof evidence is released.
 */
export const emailPairingAllowsUser = (input: EmailPairingSubject): OwnedStatement =>
  compatibleSubject(input);
