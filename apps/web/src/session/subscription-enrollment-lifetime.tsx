import { Option } from "effect";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { SubscriptionEnrollmentClient } from "@/transport/client";
import { SubscriptionEnrollmentContext } from "./subscription-enrollment-context";

type SubscriptionEnrollmentLifetimeProps = Readonly<{
  readonly children: ReactNode;
  readonly makeClient: () => SubscriptionEnrollmentClient;
}>;

/** Ends enrollment authority immediately on lifetime replacement or unmount.
 * React Strict Mode replay acquires a fresh client after cleanup.
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
    <SubscriptionEnrollmentContext.Provider value={client}>
      <span ref={attachLifetime} hidden />
      {children}
    </SubscriptionEnrollmentContext.Provider>
  );
};
