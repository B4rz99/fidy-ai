import { Option } from "effect";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { SubscriptionEnrollmentClient } from "@/transport/client";
import { SubscriptionEnrollmentContext } from "./subscription-enrollment-context";

type SubscriptionEnrollmentLifetimeProps = Readonly<{
  readonly children: ReactNode;
  readonly makeClient: () => SubscriptionEnrollmentClient;
}>;

/**
 * Owns exactly one direct enrollment client for the mounted authentication lifetime. The ref
 * cleanup runs on subtree replacement and application unmount instead of waiting for Effect Atom's
 * delayed registry disposal; React Strict Mode replay acquires a fresh client after cleanup.
 */
export const SubscriptionEnrollmentLifetime = ({
  children,
  makeClient,
}: SubscriptionEnrollmentLifetimeProps): React.JSX.Element => {
  const [client, setClient] = useState<Option.Option<SubscriptionEnrollmentClient>>(Option.none);
  const attachLifetime = useCallback(
    (_element: HTMLSpanElement): (() => void) => {
      const current = makeClient();
      setClient(Option.some(current));
      return () => {
        current.dispose().catch(() => undefined);
      };
    },
    [makeClient]
  );

  return (
    <>
      <span ref={attachLifetime} hidden />
      {Option.match(client, {
        onNone: () => null,
        onSome: (current) => (
          <SubscriptionEnrollmentContext.Provider value={Option.some(current)}>
            {children}
          </SubscriptionEnrollmentContext.Provider>
        ),
      })}
    </>
  );
};
