import { Schema } from "effect";
import { UserId } from "../../src/core/identity/contract";
import {
  ProCursor,
  ProEmailBinding,
  ProMutation,
  ProOperator,
} from "../../src/shell/pro-grants/contract";

export const betaUserUrl = "https://user.invalid/beta-pro";

export const betaRegistryUrl = "https://maintenance.invalid/beta-pro-page";

export const betaPageSize = 16;

export const BetaRegistryPage = Schema.Struct({
  users: Schema.Array(UserId).check(Schema.isMaxLength(betaPageSize)),
  next: Schema.NullOr(ProCursor),
});

export const BetaAuthority = Schema.Struct({
  issuer: Schema.String,
  subject: Schema.String,
  email: ProOperator,
  deadline: Schema.Int,
});

export const BetaUserCommand = Schema.Struct({
  authority: BetaAuthority,
  command: Schema.Union([
    ProMutation,
    Schema.Struct({ action: Schema.Literal("inspect"), userId: UserId }),
    Schema.Struct({ action: Schema.Literal("resolve"), userId: UserId, mailbox: ProEmailBinding }),
  ]),
});

export const betaStatus = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  unavailable: 503,
} as const;
