import { activeProGrantSelection } from "~/shell/pro-grants/operations";
import { UserId } from "~/core/identity/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Option, Schema } from "effect";
import { activePaidSubscriptionForUserSelection } from "~/shell/subscription/operations";
import { activeTrialPeriodForUserSelection } from "~/shell/identity/operations";

export const activeProUserCondition = (
  input: Readonly<{ userId: string; nowEpochMs: number }>
): OwnedStatement => {
  Schema.decodeSync(Schema.Finite)(input.nowEpochMs);
  const subject = Schema.decodeOption(UserId)(input.userId);

  if (Option.isNone(subject)) return { sql: "0", params: [] };

  return activeProForUserSelection({
    users: { sql: "SELECT ? AS userId", params: [subject.value] },
    nowEpochMs: input.nowEpochMs,
  });
};

export const activeProForUserSelection = (
  input: Readonly<{ users: OwnedStatement; nowEpochMs: number }>
): OwnedStatement => {
  Schema.decodeSync(Schema.Finite)(input.nowEpochMs);
  const users = { sql: "SELECT userId FROM access_subject", params: [] };
  const trial = activeTrialPeriodForUserSelection({ ...input, users });
  const paid = activePaidSubscriptionForUserSelection({ ...input, users });
  const grant = activeProGrantSelection(users);

  return {
    sql: `(WITH access_input(userId) AS MATERIALIZED (${input.users.sql}),
      access_candidates AS MATERIALIZED (SELECT DISTINCT userId FROM access_input),
      access_subject AS MATERIALIZED (SELECT userId FROM access_candidates
        WHERE (SELECT COUNT(*) FROM access_candidates)=1)
      SELECT (${trial.sql} OR ${paid.sql} OR ${grant.sql}))`,
    params: [...input.users.params, ...trial.params, ...paid.params, ...grant.params],
  };
};
