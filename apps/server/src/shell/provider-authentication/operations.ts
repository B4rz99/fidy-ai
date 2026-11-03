import { type OwnedStatement } from "~/shell/owner-write/contract";

/** Contact lookup for trusted operator selection only; email never establishes login authority. */
export const providerContactUsers = (email: string): OwnedStatement => ({
  sql: "SELECT user_id AS userId FROM provider_credentials WHERE lower(trim(contact_email)) = ?",
  params: [email.trim().toLowerCase()],
});
