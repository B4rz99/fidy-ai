import { useAtom } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionRegistryProvider } from "./session";

const markerAtom = Atom.make("empty");

const RegistryMarker = (): React.JSX.Element => {
  const [value, setValue] = useAtom(markerAtom);
  return (
    <button type="button" onClick={() => setValue("remembered")}>
      {value}
    </button>
  );
};

describe("session registry lifetime", () => {
  it("replaces the registry when the authentication lifetime changes", () => {
    const view = render(
      <SessionRegistryProvider authenticationLifetime="first">
        <RegistryMarker />
      </SessionRegistryProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "empty" }));
    expect(screen.getByRole("button", { name: "remembered" })).toBeVisible();

    view.rerender(
      <SessionRegistryProvider authenticationLifetime="second">
        <RegistryMarker />
      </SessionRegistryProvider>
    );

    expect(screen.getByRole("button", { name: "empty" })).toBeVisible();
  });
});
