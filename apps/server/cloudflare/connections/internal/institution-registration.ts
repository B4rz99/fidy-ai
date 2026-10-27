import { InstitutionId } from "../../../src/core/connections/contract";
import { ConnectionInstitutions } from "../../../src/shell/connections/contract";
import { ConnectionSandboxAdmission } from "../contract";
import { Clock, Effect, Option } from "effect";

/** Sandbox admission is limited to its configured User and absolute test window. */
export const institutionsForUser = (userId: string): Effect.Effect<ReadonlyArray<InstitutionId>> =>
  Effect.gen(function* () {
    const registered = yield* ConnectionInstitutions;
    const admission = yield* ConnectionSandboxAdmission;
    const now = yield* Clock.currentTimeMillis;
    return Option.isSome(admission) &&
      admission.value.userId === userId &&
      admission.value.startsAt <= now &&
      now < admission.value.expiresAt
      ? [...registered, InstitutionId.make("bancolombia")]
      : registered;
  });

/** Static deployed registry only; neither request input nor database state supplies these IDs. */
export const registeredInstitutionPredicate = ({
  column,
  institutions,
}: Readonly<{ column: string; institutions: ReadonlyArray<InstitutionId> }>): string =>
  `${column} IN (${institutions.map((id) => `'${id.replaceAll("'", "''")}'`).join(",") || "NULL"})`;
