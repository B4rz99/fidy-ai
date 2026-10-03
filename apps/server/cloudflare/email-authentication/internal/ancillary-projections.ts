import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type { VerifiedEmailQueryInput } from "../contract";

export const verifiedEmailQuery = ({ userId }: VerifiedEmailQueryInput): OwnedStatement => ({
  sql: "SELECT user_id AS userId, email_address AS emailAddress FROM verified_email_credentials WHERE user_id = ?",
  params: [userId],
});
