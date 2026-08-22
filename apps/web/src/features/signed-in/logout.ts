import { Effect } from "effect";

type LogoutTrigger = (input: Readonly<{ onLoggedOut: () => void }>) => void;

/** Builds the Atom mutation program that performs transport logout before publishing completion. */
export const makeLogoutOperation =
  <A, E, R>(
    logout: Effect.Effect<A, E, R>
  ): ((input: Readonly<{ onLoggedOut: () => void }>) => Effect.Effect<void, never, R>) =>
  ({ onLoggedOut }) =>
    logout.pipe(Effect.andThen(Effect.sync(onLoggedOut)), Effect.orDie);

/** Completes local logout and navigation only after the logout mutation reports success. */
export const completeLogoutNavigation = ({
  completeLogout,
  navigate,
  runLogout,
}: Readonly<{
  completeLogout: () => void;
  navigate: () => Promise<unknown>;
  runLogout: LogoutTrigger;
}>): void => {
  runLogout({
    onLoggedOut: () => {
      completeLogout();
      navigate().catch(() => undefined);
    },
  });
};
