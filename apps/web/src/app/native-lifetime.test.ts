import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vitest";
import { makeAuthenticationLifetime } from "@/session/lifetime";
import { type Authentication, Message } from "./native-model";
import { makeApplicationOwner } from "./native-lifetime";

const makeOwner = (): Readonly<{
  owner: ReturnType<typeof makeApplicationOwner>;
  expired: Array<() => void>;
  messages: Array<Message>;
}> => {
  const expired: Array<() => void> = [];
  const messages: Array<Message> = [];
  const owner = makeApplicationOwner({
    createLifetime: (onExpired) => {
      expired.push(onExpired);
      return makeAuthenticationLifetime({ apiOrigin: "https://api.test.fidyapp.com", onExpired });
    },
    dispatch: (message) => messages.push(message),
  });
  return { owner, expired, messages };
};

it.each<Authentication>(["signed-in", "signed-out", "expired"])(
  "replaces cached data and private capabilities on a %s transition",
  (authentication) => {
    const { owner, messages } = makeOwner();
    const first = owner.current();
    const cached = Atom.make("empty");
    first.lifetime.registry.set(cached, "previous account");
    const close = vi.fn();
    owner.retain({ epoch: first.epoch, mount: () => close });
    owner.transition(authentication);
    const next = owner.current();
    expect(close).toHaveBeenCalledOnce();
    expect(next.lifetime.registry.get(cached)).toBe("empty");
    expect(next.lifetime.apiClient).not.toBe(first.lifetime.apiClient);
    expect(next.lifetime.webAuthClient).not.toBe(first.lifetime.webAuthClient);
    expect(next.lifetime.hostedTurnClient).not.toBe(first.lifetime.hostedTurnClient);
    expect(next.lifetime.enrollmentClient).not.toBe(first.lifetime.enrollmentClient);
    expect(messages).toEqual([Message.ChangedLifetime({ authentication, epoch: 1 })]);
    expect(owner.isCurrent(first.epoch)).toBe(false);
    owner.dispose();
  }
);

it("ignores expiration callbacks from a replaced account and coalesces repeated expiration", () => {
  const { owner, expired, messages } = makeOwner();
  owner.transition("signed-in");
  expired[0]?.();
  expect(owner.current().authentication).toBe("signed-in");
  expect(messages).toHaveLength(1);
  expired[1]?.();
  expect(owner.current().authentication).toBe("expired");
  expect(messages).toHaveLength(2);
  expired[1]?.();
  expired[2]?.();
  expect(messages).toHaveLength(2);
  owner.dispose();
});

it("preserves authentication while restarting pairing with a fresh registry", () => {
  const { owner } = makeOwner();
  owner.transition("signed-in");
  const previous = owner.current();
  owner.restart();
  expect(owner.current().authentication).toBe("signed-in");
  expect(owner.current().lifetime.registry).not.toBe(previous.lifetime.registry);
  owner.dispose();
});

it("disposes retained DOM owners exactly once and never admits a stale mount", () => {
  const { owner, expired, messages } = makeOwner();
  const close = vi.fn();
  const release = owner.retain({ epoch: 0, mount: () => close });
  owner.transition("signed-in");
  release();
  expect(close).toHaveBeenCalledOnce();
  const staleMount = vi.fn(() => close);
  owner.retain({ epoch: 0, mount: staleMount })();
  expect(staleMount).not.toHaveBeenCalled();
  owner.dispose();
  owner.dispose();
  expired[1]?.();
  owner.transition("signed-out");
  expect(messages).toHaveLength(1);
  expect(owner.isCurrent(1)).toBe(false);
});

it("releases an unmounted feature without closing its account lifetime", () => {
  const { owner } = makeOwner();
  const close = vi.fn();
  const release = owner.retain({ epoch: 0, mount: () => close });
  release();
  release();
  expect(close).toHaveBeenCalledOnce();
  expect(owner.isCurrent(0)).toBe(true);
  owner.dispose();
  expect(close).toHaveBeenCalledOnce();
});

const pendingStatus = (completions: Array<() => void>): Effect.Effect<string> =>
  Effect.callback<string>((resume) => {
    completions.push(() => resume(Effect.succeed("stale status")));
    return Effect.void;
  });

it("interrupts pending enrollment on every transition and refuses stale status publication", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { owner } = makeOwner();
      const completions: Array<() => void> = [];
      const published: Array<string> = [];
      const rejected: Array<unknown> = [];
      for (const authentication of ["signed-in", "signed-out", "expired"] as const) {
        const client = owner.current().lifetime.enrollmentClient;
        const pending = client.execute(() => pendingStatus(completions));
        const settled = pending.then(
          (status) => {
            published.push(status);
          },
          (error) => {
            rejected.push(error);
          }
        );
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(completions).toHaveLength(rejected.length + 1))
        );
        owner.transition(authentication);
        completions.at(-1)?.();
        yield* Effect.tryPromise(() => settled);
        expect(published).toEqual([]);
        expect(client.signal.aborted).toBe(true);
        expect(owner.current().lifetime.enrollmentClient.signal.aborted).toBe(false);
      }
      expect(rejected).toHaveLength(3);
      const final = owner.current().lifetime.enrollmentClient;
      owner.dispose();
      expect(final.signal.aborted).toBe(true);
    })
  ));
