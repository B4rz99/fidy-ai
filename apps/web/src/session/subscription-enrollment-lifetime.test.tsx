import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type Cause, Effect } from "effect";
import { it as effectIt } from "@effect/vitest";
import { StrictMode, useState } from "react";
import { afterEach, expect } from "vitest";
import { SessionRegistryProvider } from "./session";
import { useSubscriptionEnrollmentClient } from "./subscription-enrollment-context";
import { SubscriptionEnrollmentLifetime } from "./subscription-enrollment-lifetime";
import { useSession } from "./session-context";
import {
  type SubscriptionEnrollmentClient,
  makeSubscriptionEnrollmentClient,
} from "@/transport/client";

const StatusProbe = ({
  completions,
}: Readonly<{ completions: Array<() => void> }>): React.JSX.Element => {
  const client = useSubscriptionEnrollmentClient();
  const session = useSession();
  const [published, setPublished] = useState("idle");
  const startStatus = (): void => {
    client
      .execute(() =>
        Effect.callback<string>((resume) => {
          completions.push(() => resume(Effect.succeed("stale status")));
          return Effect.void;
        })
      )
      .then(setPublished, () => undefined)
      .catch(() => undefined);
  };
  return (
    <>
      <span>{published}</span>
      <button type="button" onClick={startStatus}>
        start status
      </button>
      <button type="button" onClick={session.completeLogin}>
        login
      </button>
      <button type="button" onClick={session.completeLogout}>
        logout
      </button>
      <button type="button" onClick={session.expireAuthentication}>
        expire
      </button>
      <button type="button" onClick={session.replaceAuthenticationLifetime}>
        restart pairing
      </button>
    </>
  );
};

const findStartStatus = (): Effect.Effect<HTMLElement, Cause.UnknownError> =>
  Effect.tryPromise(() => screen.findByRole("button", { name: "start status" }));
const waitForAssertion = (assertion: () => void): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() => waitFor(assertion));

const trackedClient = (): Readonly<{
  makeClient: () => SubscriptionEnrollmentClient;
  counts: () => Readonly<{ created: number; disposed: number; active: number }>;
}> => {
  let created = 0;
  let disposed = 0;
  let active = 0;
  return {
    makeClient: () => {
      created += 1;
      active += 1;
      const client = makeSubscriptionEnrollmentClient({
        apiOrigin: "https://api.test.fidyapp.com",
      });
      return {
        signal: client.signal,
        execute: client.execute,
        dispose: () => {
          disposed += 1;
          active -= 1;
          return client.dispose();
        },
      };
    },
    counts: () => ({ created, disposed, active }),
  };
};

const transition = (
  name: "logout" | "expire" | "restart pairing",
  counts: ReturnType<typeof trackedClient>["counts"]
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    fireEvent.click(screen.getByRole("button", { name }));
    yield* findStartStatus();
    yield* waitForAssertion(() => {
      expect(counts().active).toBe(1);
      expect(counts().created - counts().disposed).toBe(1);
    });
  });

afterEach(cleanup);

effectIt.effect(
  "disposes every replaced authentication lifetime without stale status publication",
  () =>
    Effect.gen(function* () {
      const completions: Array<() => void> = [];
      const { makeClient, counts } = trackedClient();

      const application = render(
        <StrictMode>
          <SessionRegistryProvider>
            <SubscriptionEnrollmentLifetime makeClient={makeClient}>
              <StatusProbe completions={completions} />
            </SubscriptionEnrollmentLifetime>
          </SessionRegistryProvider>
        </StrictMode>
      );

      yield* findStartStatus();
      expect(counts().active).toBe(1);
      expect(counts().created - counts().disposed).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: "start status" }));
      yield* waitForAssertion(() => expect(completions).toHaveLength(1));
      fireEvent.click(screen.getByRole("button", { name: "login" }));
      yield* findStartStatus();
      yield* waitForAssertion(() => expect(counts().active).toBe(1));

      completions[0]?.();
      yield* waitForAssertion(() => expect(screen.getByText("idle")).toBeVisible());

      yield* transition("logout", counts);
      yield* transition("expire", counts);
      yield* transition("restart pairing", counts);

      application.unmount();
      expect(counts().active).toBe(0);
      expect(counts().disposed).toBe(counts().created);
    })
);
