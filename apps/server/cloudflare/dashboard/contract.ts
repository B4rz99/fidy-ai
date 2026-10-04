import type { Effect, Option } from "effect";
import type {
  ApplyDashboardEditCanonicalInput,
  DashboardGroup,
  InitializeDashboardCanonicalInput,
} from "../../src/shell/dashboard/contract";
import type { QueryCaller, TransactionCaller } from "../canonical-work/contract";

/** Canonical operation names derived from Dashboard's one published declaration. */
export type DashboardOperation = `dashboard.${keyof typeof DashboardGroup.endpoints}`;
export type DashboardMutationOperation = Extract<
  DashboardOperation,
  "dashboard.initializeDashboard" | "dashboard.applyDashboardEdit"
>;
export type DashboardQueryOperation = Exclude<DashboardOperation, DashboardMutationOperation>;

type DashboardInputs = {
  "dashboard.initializeDashboard": typeof InitializeDashboardCanonicalInput.Type;
  "dashboard.applyDashboardEdit": typeof ApplyDashboardEditCanonicalInput.Type;
};

/** A decoded individual call; absent input asks the owner to record its canonical refusal. */
export type DashboardMutationCall = {
  [Operation in keyof DashboardInputs]: Readonly<{
    operation: Operation;
    input: Option.Option<DashboardInputs[Operation]>;
  }>;
}[keyof DashboardInputs];

/**
 * The catalog requires live caller authority only. Document calls additionally require dispatch
 * through that same User's coordinator, holding its turn until committed readback is complete.
 */
export type DashboardRequest = Readonly<{
  db: D1Database;
  request: Request;
}> &
  (
    | Readonly<{ operation: DashboardQueryOperation; subject: QueryCaller }>
    | Readonly<{
        operation: DashboardMutationOperation;
        subject: TransactionCaller;
        runMutation: (call: DashboardMutationCall) => Effect.Effect<Response>;
      }>
  );
