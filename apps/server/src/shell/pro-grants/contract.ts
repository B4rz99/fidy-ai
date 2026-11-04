import { EmailAddress } from "~/core/email-authentication/contract";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { Data, type Effect, type Option, Schema } from "effect";
import { UserId } from "~/core/identity/contract";

export const maximumProGrants = 1000;
export const ProSelector = Schema.Union([
  Schema.Struct({ userId: UserId }),
  Schema.Struct({ email: EmailAddress }),
]);
export const ProCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({ action: Schema.Literals(["grant", "revoke"]), selector: ProSelector }),
]);
export type ProCommand = typeof ProCommand.Type;
export const ProOperator = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9@._-]{1,128}$/u));
export const ProGrantEntry = Schema.Struct({
  userId: UserId,
  action: Schema.Literals(["grant", "revoke"]),
});
export const ProGrantFailureReason = Schema.Literals([
  "invalid-input",
  "unavailable",
  "user-not-found",
  "ambiguous-email",
]);
export class ProGrantFailure extends Data.TaggedError("ProGrantFailure")<{
  readonly reason: typeof ProGrantFailureReason.Type;
  readonly candidates: ReadonlyArray<UserId>;
}> {}
/** Database authority belongs to the trusted operator runtime, never a User credential. */
export type ProStatement = OwnedStatement & Readonly<{ admission: Option.Option<OwnedStatement> }>;
export type ProGrantQuery = (
  statement: ProStatement
) => Effect.Effect<ReadonlyArray<unknown>, ProGrantFailure>;
