import { EmailAddress } from "~/core/email-authentication/contract";
import { Data, Schema } from "effect";
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

export class ProGrantFailure extends Data.TaggedError("ProGrantFailure")<{
  readonly reason: "invalid-input" | "unavailable" | "user-not-found" | "denied" | "conflict";
}> {}

export const betaProPath = "/internal/beta-pro";

export const ProCursor = Schema.Struct({
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  through: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ProPage = Schema.Struct({
  entries: Schema.Array(ProGrantEntry),
  next: Schema.NullOr(ProCursor),
});

export const ProEmailBinding = Schema.Struct({
  email: EmailAddress,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const ProMutation = Schema.Struct({
  action: Schema.Literals(["grant", "revoke"]),
  userId: UserId,
  requestId: Schema.String.check(Schema.isUUID()),
  mailbox: Schema.optional(ProEmailBinding),
});

export const ProTarget = Schema.Struct({ userId: UserId, revision: Schema.Int });

export const ProOperatorCommand = Schema.Union([
  ProMutation,
  Schema.Struct({ action: Schema.Literal("resolve"), email: EmailAddress }),
  Schema.Struct({ action: Schema.Literal("list"), cursor: Schema.optional(ProCursor) }),
]);
