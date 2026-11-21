import type { OwnedStatement } from "~/shell/owner-write/contract";
import { ConsentSubject } from "~/shell/consent/contract";

export const erasureAdmissionCondition = (
  input: Readonly<{
    subject: ConsentSubject;
    admitted: boolean;
  }>
): OwnedStatement => ({
  sql: `NOT EXISTS(SELECT 1 FROM erasure_requests erasure_fence WHERE erasure_fence.user_id=${ConsentSubject.$is("User")(input.subject) ? "?" : input.subject.column}
    ${input.admitted ? "AND erasure_fence.state<>'Draining'" : ""})`,
  params: ConsentSubject.$is("User")(input.subject) ? [input.subject.userId] : [],
});
