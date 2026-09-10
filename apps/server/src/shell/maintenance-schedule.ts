import { type Duration, Effect } from "effect";

/**
 * One repeat-safe maintenance action whose missed process-local tick can only delay cleanup. The
 * action runs immediately when its owning application scope starts and then at the declared cadence.
 */
export type BestEffortMaintenance<R> = Readonly<{
  timing: "best-effort";
  cadence: Duration.Input;
  work: Effect.Effect<void, never, R>;
}>;

/** Runs bounded best-effort maintenance immediately and repeats it until the caller's scope closes. */
export const runBestEffortMaintenance: <R>(
  maintenance: BestEffortMaintenance<R>
) => Effect.Effect<never, never, R> = (maintenance) =>
  maintenance.work.pipe(Effect.andThen(Effect.sleep(maintenance.cadence)), Effect.forever);
