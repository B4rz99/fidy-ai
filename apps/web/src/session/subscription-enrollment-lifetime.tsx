import { Option } from "effect";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type { SubscriptionEnrollmentClient } from "@/transport/client";
import { SubscriptionEnrollmentContext } from "./subscription-enrollment-context";
import { reportBrowserDefect } from "@/transport/browser-defects";

type SubscriptionEnrollmentLifetimeProps = Readonly<{
  readonly children: ReactNode;
  readonly makeClient: () => SubscriptionEnrollmentClient;
}>;

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
        current.dispose().catch(() => reportBrowserDefect("command_failed"));
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
