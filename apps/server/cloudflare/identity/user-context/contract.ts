import type { UserId } from "../../../src/core/identity/contract";
import { Data, type Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

export class UserContextUnavailable extends Data.TaggedError("UserContextUnavailable")<{}> {}

export type UserContextRead = Readonly<{
  db: D1Database;
  userId: UserId;
  authority: Option.Option<OwnedStatement>;
}>;

export type UserContextStatement = Readonly<{
  db: D1Database;
  statement: OwnedStatement;
}> &
  (Readonly<{ userId: UserId }> | Readonly<{ userSelection: OwnedStatement }>);
