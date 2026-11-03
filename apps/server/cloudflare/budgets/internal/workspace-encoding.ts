import { Effect, Schema, Struct } from "effect";
import { BudgetStatus, BudgetWorkspace } from "../../../src/core/budgets/contract";

// These union checks read cap, spent and progress; neither reads the removed period field.
const statusFacts = BudgetStatus.mapMembers(
  ([under, reached, over]) => [
    under.mapFields(Struct.omit(["period"])),
    reached.mapFields(Struct.omit(["period"])),
    over.mapFields(Struct.omit(["period"])),
  ],
  { unsafePreserveChecks: true }
);
const workspaceFacts = Schema.Struct({
  ...BudgetWorkspace.fields,
  statuses: Schema.Array(statusFacts),
});
const encodeFacts = Schema.encodeEffect(workspaceFacts);
const encodeComplete = Schema.encodeEffect(Schema.toCodecJson(BudgetWorkspace));

/** Validate the one shared period once, retaining each status's exact financial checks and wire shape. */
export const encodeBudgetWorkspace = (
  workspace: typeof BudgetWorkspace.Type
): Effect.Effect<Schema.Json, Schema.SchemaError> => {
  if (workspace.statuses.some((status) => status.period !== workspace.period)) {
    return encodeComplete(workspace);
  }
  return encodeFacts({
    ...workspace,
    statuses: workspace.statuses.map((status) => {
      if (status.type === "under") return Struct.omit(status, ["period"]);
      if (status.type === "reached") return Struct.omit(status, ["period"]);
      return Struct.omit(status, ["period"]);
    }),
  }).pipe(
    Effect.map((data) => ({
      ...data,
      statuses: data.statuses.map((status) => ({ ...status, period: data.period })),
    }))
  );
};
