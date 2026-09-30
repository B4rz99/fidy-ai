import { Context, Effect } from "effect";
import type { EmailAddress } from "~/core/email-authentication/model";
import type { UserId } from "~/core/identity/reference";
import type { CanonicalImplementationCaller } from "~/shell/_shared/canonical-implementation-caller";
import type { CanonicalInput } from "~/shell/_shared/canonical-input";
import type { CanonicalSuccess } from "~/shell/_shared/canonical-success";
import {
  EmailReplacementInvalidApi,
  emailReplacementInvalidBody,
} from "~/shell/web-authentication/contract";

/** Cloudflare's transaction adapter; the canonical implementation owns the operation result. */
export type EmailReplacementMutationService = Readonly<{
  request: (subject: UserId, candidate: EmailAddress) => Effect.Effect<void>;
  complete: (subject: UserId, combinedCode: string) => Effect.Effect<boolean>;
}>;

export class EmailReplacementMutation extends Context.Service<
  EmailReplacementMutation,
  EmailReplacementMutationService
>()("@fidy/server/shell/email-authentication/mutation/EmailReplacementMutation") {}

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
