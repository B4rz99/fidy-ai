import type { InitialBrowserRequest } from "./initial-request";
import { Effect, Exit, Option } from "effect";
import { type BrowserSessionObservation, loadBrowserSessionEntry } from "./session-binding";

export type InitialSessionWork = Readonly<{
  result: Effect.Effect<Exit.Exit<BrowserSessionObservation, unknown>>;
  cancel: () => void;
}>;
export type InitialBrowserSession = Readonly<{
  apiOrigin: string;
  ready: Promise<void>;
  take: (owner: object) => Option.Option<InitialSessionWork>;
  cancel: () => void;
}>;

const preparedResult = (
  completed: () => Option.Option<Exit.Exit<BrowserSessionObservation, unknown>>,
  result: Promise<Exit.Exit<BrowserSessionObservation, unknown>>
): Effect.Effect<Exit.Exit<BrowserSessionObservation, unknown>> =>
  Effect.suspend(() =>
    Option.match(completed(), {
      onNone: () => Effect.tryPromise(() => result).pipe(Effect.orElseSucceed(Exit.fail)),
      onSome: Effect.succeed,
    })
  );

/** Start once per document. Replay belongs only to the same mounted observer, never another epoch. */
export const beginInitialBrowserSession = ({
  apiOrigin,
  context,
  request,
}: Readonly<{
  apiOrigin: string;
  context: boolean;
  request: InitialBrowserRequest;
}>): InitialBrowserSession => {
  const controller = new AbortController();
  const observe = loadBrowserSessionEntry({
    apiOrigin,
    context,
    request: Option.some(request),
  });
  const result = Effect.runPromiseExit(observe, {
    signal: AbortSignal.any([controller.signal, request.signal]),
  });
  let completed = Option.none<Exit.Exit<BrowserSessionObservation, unknown>>();
  let work = Option.none<InitialSessionWork>();
  const cancel = (): void => {
    completed = Option.none();
    work = Option.none();
    controller.abort();
    request.cancel();
  };
  const ready = result.then((exit) => {
    if (request.isCurrent()) completed = Option.some(exit);
  });
  const prepared = preparedResult(() => completed, result);
  work = Option.some({ result: prepared, cancel });
  let owner = Option.none<object>();
  return {
    apiOrigin,
    ready,
    cancel,
    take: (next) => {
      request.release();
      if (!request.isCurrent() || (Option.isSome(owner) && owner.value !== next)) {
        cancel();
      }
      owner = Option.some(next);
      return work;
    },
  };
};
