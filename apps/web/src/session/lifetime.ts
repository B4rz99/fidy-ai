import { AtomRegistry } from "effect/reactivity";
import {
  type FidyClient,
  type HostedTurnClient,
  type SubscriptionEnrollmentClient,
  type WebAuthClient,
  makeFidyClient,
  makeHostedTurnClient,
  makeSubscriptionEnrollmentClient,
  makeWebAuthClient,
} from "@/transport/client";

/**
 * Capabilities for one authentication lifetime. Mounted features register immediate disposal;
 * closing the lifetime revokes them before releasing transport and cached resources. A closed
 * lifetime never admits another mounted owner. Construct a fresh lifetime after any account change.
 */
export type AuthenticationLifetime = Readonly<{
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
  enrollmentClient: SubscriptionEnrollmentClient;
  registry: AtomRegistry.AtomRegistry;
  retain: (dispose: () => void) => () => void;
  dispose: () => void;
}>;

/** Creates isolated browser capabilities; the expiration callback belongs to the application. */
export const makeAuthenticationLifetime = ({
  apiOrigin,
  onExpired,
}: Readonly<{ apiOrigin: string; onExpired: () => void }>): AuthenticationLifetime => {
  const registry = AtomRegistry.make();
  const enrollmentClient = makeSubscriptionEnrollmentClient({ apiOrigin });
  const owners = new Set<() => void>();
  let active = true;
  return {
    apiClient: makeFidyClient({
      apiOrigin,
      observer: {
        onAuthenticationExpired: () => {
          if (active) onExpired();
        },
      },
    }),
    webAuthClient: makeWebAuthClient({ apiOrigin }),
    hostedTurnClient: makeHostedTurnClient({ apiOrigin }),
    enrollmentClient,
    registry,
    retain: (dispose) => {
      if (!active) {
        dispose();
        return () => undefined;
      }
      owners.add(dispose);
      return () => {
        owners.delete(dispose);
      };
    },
    dispose: () => {
      if (!active) return;
      active = false;
      for (const dispose of owners) dispose();
      owners.clear();
      registry.dispose();
      enrollmentClient.dispose().catch(() => undefined);
    },
  };
};
