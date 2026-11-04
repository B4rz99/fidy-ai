import { CanonicalSnapshotResponse } from "../canonical-admission/contract";
import { SqliteStoreRequest } from "../sqlite-store/contract";
import { WebSessionId } from "../../src/core/web-session/contract";
import { type Effect, type Option, Schema } from "effect";
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

export const NativeDashboardRequest = Schema.Struct({
  manifest: SqliteStoreRequest.fields.manifest,
  epoch: SqliteStoreRequest.fields.epoch,
  request: Schema.instanceOf(Request),
  mode: Schema.Literals(["bound", "document"]),
});
export type NativeDashboardRequest = typeof NativeDashboardRequest.Type;
const Measurement = Schema.Struct({
  scans: Schema.Int,
  financialRows: Schema.Int,
  rowsRead: Schema.Int,
  workingGroups: Schema.Int,
  promotions: Schema.Int,
});
export const NativeDashboardResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("view"),
    response: CanonicalSnapshotResponse,
    binding: WebSessionId,
    measurement: Measurement,
  }),
  Schema.Struct({ kind: Schema.Literal("response"), response: CanonicalSnapshotResponse }),
]);
export type NativeDashboardResult = typeof NativeDashboardResult.Type;
export type NativeDashboardRead = Readonly<{
  storage: DurableObjectStorage;
  bucket: Option.Option<R2Bucket>;
  browserOrigin: string;
  input: NativeDashboardRequest;
  admitted: () => boolean;
}>;

export type NativeDashboardBinding = Readonly<{
  dashboard: (input: NativeDashboardRequest) => Promise<unknown>;
}>;
export type NativeDashboardReader = (
  input: Pick<NativeDashboardRequest, "request" | "mode">
) => Promise<NativeDashboardResult>;
