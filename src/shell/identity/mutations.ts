import { Effect, type Schema } from "effect";
import { type User, type UserPreferences } from "~/core/identity/model";
import type { UserId } from "~/core/identity/reference";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import { type OperationResponse } from "~/shell/_shared/response";
import { updateUserPreferencesInScope } from "./repo";

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

/** Facts supplied after canonical decoding and caller authorization for a preference update. */
export type UpdateUserPreferencesInput = Readonly<{
  userId: UserId;
  payload: UserPreferences;
}>;

/** Updates editable User preferences without opening or committing a database transaction. */
export const updateUserPreferences: CanonicalMutationImplementation<
  UpdateUserPreferencesInput,
  MutationResponse<typeof User>,
  never
> = Effect.fn("updateUserPreferences")(function* ({ userId, payload }) {
  const user = yield* updateUserPreferencesInScope(userId, payload).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.orDie
  );
  return { data: user, next: [] };
});
