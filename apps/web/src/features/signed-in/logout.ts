import { Effect } from "effect";

type LogoutTrigger = (input: Readonly<{ onLoggedOut: () => void }>) => void;

export const createLogoutOperation =
  <A, E, R>(
    logout: Effect.Effect<A, E, R>
  ): ((input: Readonly<{ onLoggedOut: () => void }>) => Effect.Effect<void, never, R>) =>
  ({ onLoggedOut }) =>
    logout.pipe(Effect.andThen(Effect.sync(onLoggedOut)), Effect.orDie);

export const completeLogoutNavigation = ({
  completeLogout,
  navigate,
  runLogout,
}: Readonly<{
  completeLogout: () => void;
  navigate: () => Promise<void>;
  runLogout: LogoutTrigger;
}>): void => {
  runLogout({
    onLoggedOut: () => {
      completeLogout();
      navigate().catch(() => undefined);
    },
  });
};
