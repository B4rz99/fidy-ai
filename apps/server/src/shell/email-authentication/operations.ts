import { WebSessionAuditCaller } from "~/core/audit/contract";
import type {
  CanonicalImplementationCaller,
  CanonicalInput,
  CanonicalSuccess,
} from "~/shell/canonical-operations/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import {
  EmailAuthenticationGroup,
  type EmailPairingSubject,
  type EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  type EmailReplacementMutationService,
  type EmailReplacementUnavailableApi,
  emailReplacementInvalidBody,
} from "./contract";
import { emailPairingAllowsUser as compatibleSubject } from "~/shell/email-authentication/internal/pairing-subject";
import { Context, Effect, Option, Predicate } from "effect";
import { UserId } from "~/core/identity/contract";
import { WebSessionId } from "~/core/web-session/contract";
import { decideOperationAccess } from "~/shell/canonical-policy/operations";
import {
  OperationAccessCaller,
  OperationAccessDecision,
  getOperationPolicy,
} from "~/shell/canonical-policy/contract";

export type { EmailReplacementMutationService } from "./contract";

export class EmailReplacementMutation extends Context.Service<
  EmailReplacementMutation,
  EmailReplacementMutationService
>()("@fidy/server/shell/email-authentication/operations/EmailReplacementMutation") {}

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
  | EmailReplacementInvalidApi
  | EmailReplacementUnavailableApi
  | EmailReplacementFreshPairingRequiredApi,
  EmailReplacementMutation
> =>
  Effect.gen(function* () {
    const mutation = yield* EmailReplacementMutation;

    if (!(yield* mutation.complete(caller.resolved.subjectUserId, input.payload))) {
      return yield* EmailReplacementInvalidApi.make({ error: emailReplacementInvalidBody.error });
    }

    return { data: { status: "replaced" }, next: [] } as const;
  });

export const emailReplacementOperations = {
  request: EmailAuthenticationGroup.endpoints.requestEmailReplacement,
  complete: EmailAuthenticationGroup.endpoints.completeEmailReplacement,
} as const;

export const emailReplacementImplementations = {
  request: requestEmailReplacement,
  complete: completeEmailReplacement,
} as const;

export const browserReplacementCaller = (session: {
  readonly user_id: string;
  readonly id: string;
}): CanonicalImplementationCaller => ({
  resolved: {
    subjectUserId: UserId.make(session.user_id),
    capabilities: [],
    authorityRoot: "no-verified-whatsapp-authority",
    auditCaller: WebSessionAuditCaller.make({ webSessionId: WebSessionId.make(session.id) }),
    fresh: true,
  },
  accessTier: "free",
  confirmationEvidence: () => Option.none(),
});

type ReplacementOperation = keyof typeof emailReplacementOperations;

export const permitsFreshBrowserReplacement = (operation: ReplacementOperation): boolean => {
  const { access } = getOperationPolicy(emailReplacementOperations[operation]);

  return (
    Predicate.isTagged(access, "FreshWebSessionOnly") &&
    OperationAccessDecision.$is("Allowed")(
      decideOperationAccess(access, OperationAccessCaller.WebSession({ fresh: true }))
    )
  );
};

export const emailPairingAllowsUser = (input: EmailPairingSubject): OwnedStatement =>
  compatibleSubject(input);
