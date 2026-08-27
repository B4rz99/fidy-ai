import { DateTime, Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import { selectActivePATs } from "./repo";

/** Reads only safe metadata for the caller's currently usable PATs. */
export const listPATs = Effect.fn("listPATs")(function* (input: { readonly userId: UserId }) {
  return {
    data: { pats: yield* selectActivePATs(input.userId, yield* DateTime.now) },
    next: [],
  };
});
