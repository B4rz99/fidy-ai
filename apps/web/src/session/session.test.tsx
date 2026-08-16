import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionRegistryProvider } from "./session";
import { useSession } from "./session-context";

const markerAtom = Atom.make("empty");

const RegistryMarker = (): React.JSX.Element => {
  const [value, setValue] = useAtom(markerAtom);
  const { replaceAuthenticationLifetime } = useSession();
  return (
    <>
      <button type="button" onClick={() => setValue("remembered")}>
        {value}
      </button>
      <button type="button" onClick={replaceAuthenticationLifetime}>
        replace authentication lifetime
      </button>
    </>
  );
};

const SessionWithoutProvider = (): React.JSX.Element => {
  useSession();
  return <span>unreachable</span>;
};

describe("session registry lifetime", () => {
  it("requires the application-owned session provider", () => {
    expect(() => render(<SessionWithoutProvider />)).toThrow(
      "useSession must be used within SessionRegistryProvider"
    );
  });

  it("replaces the registry through an explicit authentication transition", () => {
    render(
      <SessionRegistryProvider>
        <RegistryMarker />
      </SessionRegistryProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "empty" }));
    expect(screen.getByRole("button", { name: "remembered" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "replace authentication lifetime" }));

    expect(screen.getByRole("button", { name: "empty" })).toBeVisible();
  });
});
