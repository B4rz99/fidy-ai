import { Predicate } from "effect";

type ConfirmationCheckpoint = "consumed" | "committed" | "outcome";
const checkpointReached = ({
  checkpoint,
  entries,
  toolEntry,
}: Readonly<{
  checkpoint: ConfirmationCheckpoint;
  entries: number;
  toolEntry: boolean;
}>): boolean => {
  switch (checkpoint) {
    case "consumed":
      return entries === 1 && toolEntry;
    case "committed":
      return entries === 2 && toolEntry;
    case "outcome":
      return entries === 2 && !toolEntry;
  }
};
/** Simulate connection loss after a durable confirmation checkpoint. Earlier real D1 writes
 * survive; subsequent writes, including terminalization, fail until the original binding resumes.
 */
export const confirmationOutage = ({
  db,
  checkpoint,
}: Readonly<{ db: D1Database; checkpoint: ConfirmationCheckpoint }>): D1Database => {
  let consumed = false;
  let entries = 0;
  let offline = false;
  return new Proxy(db, {
    get: (target, property): unknown => {
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          if (query.includes("UPDATE hosted_confirmations SET consumed_turn_id")) consumed = true;
          const toolEntry = query.includes("INSERT INTO transcript_entries");
          if (consumed && toolEntry) entries += 1;
          if (consumed && checkpointReached({ checkpoint, entries, toolEntry })) offline = true;
          if (offline) throw new Error("Simulated confirmation interruption");
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};
