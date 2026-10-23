import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { ConsentSubject } from "~/shell/consent/contract";

/** Correlated columns are the owner's fixed publication, never request-selected identifiers. Continuing work still requires the owner's exact original admission and lifetime. */
export const erasureAdmissionCondition = (
  input: Readonly<{
    subject: ConsentSubject;
    admitted: boolean;
  }>
): OwnedStatement => ({
  sql: `NOT EXISTS(SELECT 1 FROM erasure_requests erasure_fence WHERE erasure_fence.user_id=${input.subject._tag === "User" ? "?" : input.subject.column}
    ${input.admitted ? "AND erasure_fence.state<>'Draining'" : ""})`,
  params: input.subject._tag === "User" ? [input.subject.userId] : [],
});
