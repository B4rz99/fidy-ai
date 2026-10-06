import { Effect, Predicate } from "effect";

type PublicationCheckpoint = "stage" | "publication" | "outcome";
const checkpointReached = ({
  checkpoint,
  staged,
  entries,
}: Readonly<{ checkpoint: PublicationCheckpoint; staged: boolean; entries: number }>): boolean => {
  switch (checkpoint) {
    case "stage":
      return staged;
    case "outcome":
      return entries === 2;
    case "publication":
      return false;
  }
};
/** Simulate connection loss after durable staging, publication, or publication outcome.
 * Recovery uses the original real D1 and R2 bindings, with all checkpoint effects retained.
 */
export const publicationOutage = ({
  db,
  checkpoint,
}: Readonly<{ db: D1Database; checkpoint: PublicationCheckpoint }>): D1Database => {
  let staged = false;
  let publication = false;
  let entries = 0;
  let offline = false;
  return new Proxy(db, {
    get: (target, property): unknown => {
      if (property === "batch") {
        return (statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> =>
          Effect.runPromise(
            Effect.gen(function* () {
              const result = yield* Effect.tryPromise(() => target.batch(statements));
              if (publication && checkpoint === "publication") offline = true;
              return result;
            })
          );
      }
      if (property === "prepare") {
        return (query: string): D1PreparedStatement => {
          if (checkpointReached({ checkpoint, staged, entries })) offline = true;
          if (offline) throw new Error("Simulated publication interruption");
          if (query.includes("UPDATE statement_whatsapp_documents SET staging_id")) staged = true;
          if (query.includes("INSERT INTO statement_submissions")) publication = true;
          if (query.includes("INSERT INTO transcript_entries") && staged) entries += 1;
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};
