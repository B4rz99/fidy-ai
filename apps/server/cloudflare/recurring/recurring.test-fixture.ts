import { Option } from "effect";
import { UserTransactionCoordinator } from "../transactions/runtime";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";

const unusedAI = (): Promise<never> =>
  Promise.reject(new Error("Inference is not part of recurring detection"));
/** Construct real coordinator implementations; each fixture invocation has fresh instance-local execution state. */
export const makeCoordinators = (
  db: D1Database
): Readonly<{
  getByName: (
    name: string
  ) => Readonly<{ fetch: (request: RequestInfo | URL) => Promise<Response> }>;
}> => {
  const retained = new Map<string, UserTransactionCoordinator>();
  return {
    getByName: (name) => ({
      fetch: (request): Promise<Response> => {
        const found = Option.fromUndefinedOr(retained.get(name));
        const coordinator = Option.getOrElse(found, () => {
          const created = new UserTransactionCoordinator(
            { id: { name }, storage: { setAlarm: (): Promise<void> => Promise.resolve() } },
            { DB: db, AI: { run: unusedAI }, HOSTED_AI_MODEL: approvedWorkersAiModel }
          );
          retained.set(name, created);
          return created;
        });
        return coordinator.fetch(new Request(request));
      },
    }),
  };
};
/** A substituted User in private work cannot change the addressed coordinator's subject. */
export const sendBackground = ({
  db,
  coordinatorUser,
  body,
}: Readonly<{ db: D1Database; coordinatorUser: string; body: string }>): Promise<Response> =>
  makeCoordinators(db)
    .getByName(coordinatorUser)
    .fetch(
      new Request("https://coordinator/recurring-work", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );
