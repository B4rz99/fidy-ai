import { type Layer } from "effect";
import type { AuthenticationLifetime } from "@/session/lifetime";
import { type Authentication, Message } from "./native-model";

export type LifetimeFactory = (onExpired: () => void) => AuthenticationLifetime;
export type ApplicationOwner = Readonly<{
  current: () => Readonly<{
    lifetime: AuthenticationLifetime;
    epoch: number;
    authentication: Authentication;
  }>;
  isCurrent: (epoch: number) => boolean;
  transition: (authentication: Authentication) => void;
  restart: () => void;
  retain: (
    configuration: Readonly<{
      epoch: number;
      mount: (lifetime: AuthenticationLifetime) => () => void;
    }>
  ) => () => void;
  dispose: () => void;
}>;

/** Replaces capabilities synchronously, before an asynchronous view can admit any prior account work. */
export const makeApplicationOwner = ({
  createLifetime,
  dispatch,
}: Readonly<{
  createLifetime: LifetimeFactory;
  dispatch: (message: Message) => void;
}>): ApplicationOwner => {
  let active = true;
  let epoch = 0;
  let authentication: Authentication = "signed-out";
  const expire = (): void => {
    if (active && authentication !== "expired") replace("expired");
  };
  const fresh = (): AuthenticationLifetime => {
    const expected = epoch;
    return createLifetime(() => {
      if (active && epoch === expected) expire();
    });
  };
  let lifetime = fresh();
  const replace = (next: Authentication): void => {
    if (!active) return;
    lifetime.dispose();
    epoch += 1;
    authentication = next;
    lifetime = fresh();
    dispatch(Message.ChangedLifetime({ authentication, epoch }));
  };
  return {
    current: () => ({ lifetime, epoch, authentication }),
    isCurrent: (expected) => active && epoch === expected,
    transition: replace,
    restart: () => replace(authentication),
    retain: ({ epoch: expected, mount }) => {
      if (!active || expected !== epoch) return (): void => undefined;
      let mounted = true;
      const retained = lifetime;
      const release = mount(retained);
      const dispose = (): void => {
        if (!mounted) return;
        mounted = false;
        release();
      };
      const forget = retained.retain(dispose);
      return (): void => {
        forget();
        dispose();
      };
    },
    dispose: () => {
      if (!active) return;
      active = false;
      lifetime.dispose();
    },
  };
};

/** Obtains the generated client's actual transport layer from this lifetime's isolated registry. */
export const apiResources = (lifetime: AuthenticationLifetime): Layer.Layer<never> =>
  lifetime.registry.get(lifetime.apiClient.runtime.layer);
export const authResources = (lifetime: AuthenticationLifetime): Layer.Layer<never> =>
  lifetime.registry.get(lifetime.webAuthClient.runtime.layer);
