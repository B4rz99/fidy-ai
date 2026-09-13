import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { StrictMode, useState } from "react";
import { afterEach, expect, it } from "vitest";
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

afterEach(cleanup);

it("disposes every replaced authentication lifetime without stale status publication", async () => {
  const completions: Array<() => void> = [];
  let created = 0;
  let disposed = 0;
  let active = 0;
  const makeClient = (): SubscriptionEnrollmentClient => {
    created += 1;
    active += 1;
    const client = makeSubscriptionEnrollmentClient("https://api.test.fidyapp.com");
    return {
      execute: client.execute,
      dispose: () => {
        disposed += 1;
        active -= 1;
        return client.dispose();
      },
    };
  };

  const application = render(
    <StrictMode>
      <SessionRegistryProvider>
        <SubscriptionEnrollmentLifetime makeClient={makeClient}>
          <StatusProbe completions={completions} />
        </SubscriptionEnrollmentLifetime>
      </SessionRegistryProvider>
    </StrictMode>
  );

  await screen.findByRole("button", { name: "start status" });
  expect(active).toBe(1);
  expect(created - disposed).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "start status" }));
  await waitFor(() => expect(completions).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "login" }));
  await screen.findByRole("button", { name: "start status" });
  await waitFor(() => expect(active).toBe(1));

  completions[0]?.();
  await waitFor(() => expect(screen.getByText("idle")).toBeVisible());

  const transition = async (name: "logout" | "expire" | "restart pairing"): Promise<void> => {
    fireEvent.click(screen.getByRole("button", { name }));
    await screen.findByRole("button", { name: "start status" });
    await waitFor(() => {
      expect(active).toBe(1);
      expect(created - disposed).toBe(1);
    });
  };
  await transition("logout");
  await transition("expire");
  await transition("restart pairing");

  application.unmount();
  expect(active).toBe(0);
  expect(disposed).toBe(created);
});
