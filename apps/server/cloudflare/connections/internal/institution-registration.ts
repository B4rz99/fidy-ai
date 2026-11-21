import { InstitutionId } from "../../../src/core/connections/contract";
import { ConnectionInstitutions } from "../../../src/shell/connections/contract";
import { ConnectionSandboxAdmission } from "../contract";
import { Clock, Effect, Option } from "effect";

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
